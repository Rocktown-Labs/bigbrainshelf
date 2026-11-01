// Marketing email mechanics for the Book Club funnel (Workstream 3).
//
// Scope is deliberately narrow: the only marketing send is the day-3
// post-purchase club follow-up. It rides the same outbox as order mail
// (lib/orders.ts enqueueEmail + lib/email.ts flushOutbox), from the
// news@ identity, delayed with a send_after timestamp. Transactional
// order mail never touches any of this.
//
// Unsubscribe: every follow-up carries a tokened /api/unsubscribe link.
// The token is stable per email address (email_unsubscribe_tokens), so
// the link in an old email keeps working. Opt-outs land in
// marketing_opt_outs and are respected twice: the follow-up is not
// enqueued for an opted-out address, and flushOutbox re-checks at send
// time and suppresses the row instead of sending.

import { enqueueEmail, type DBLike } from "./orders";
import { ensureClubTable, isPaidClubMember } from "./club";
import {
  clubPriceLabel,
  clubIsLive,
  CLUB_ANNUAL_PRICE_CENTS,
  AUDIO_CLUB_PRICE_CENTS,
  AUDIO_CLUB_ANNUAL_PRICE_CENTS,
} from "./offers";
import { NEWS_EMAIL } from "./email";

export const CLUB_FOLLOWUP_KIND = "club_followup";
export const CLUB_FOLLOWUP_DELAY_SECONDS = 3 * 24 * 60 * 60; // 3 days

const now = () => Math.floor(Date.now() / 1000);
const norm = (email: string) => email.trim().toLowerCase();

export async function ensureMarketingTables(db: DBLike): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS marketing_opt_outs (
         email TEXT PRIMARY KEY,
         unsubscribed_at INTEGER NOT NULL
       )`
    )
    .bind()
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS email_unsubscribe_tokens (
         email TEXT PRIMARY KEY,
         token TEXT NOT NULL UNIQUE
       )`
    )
    .bind()
    .run();
}

export async function getOrCreateUnsubscribeToken(db: DBLike, email: string): Promise<string> {
  await ensureMarketingTables(db);
  const e = norm(email);
  const existing = await db
    .prepare("SELECT token FROM email_unsubscribe_tokens WHERE email = ?")
    .bind(e)
    .first();
  if (existing?.token) return String(existing.token);
  const token = crypto.randomUUID();
  await db
    .prepare("INSERT OR IGNORE INTO email_unsubscribe_tokens (email, token) VALUES (?, ?)")
    .bind(e, token)
    .run();
  const row = await db
    .prepare("SELECT token FROM email_unsubscribe_tokens WHERE email = ?")
    .bind(e)
    .first();
  return String(row?.token || token);
}

export function unsubscribeUrl(site: string, token: string): string {
  return `${site}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}

export async function isOptedOut(db: DBLike, email: string): Promise<boolean> {
  await ensureMarketingTables(db);
  const row = await db
    .prepare("SELECT email FROM marketing_opt_outs WHERE email = ?")
    .bind(norm(email))
    .first();
  return Boolean(row);
}

// Resolve an unsubscribe token to its email and record the opt-out.
// Returns the email on success, null for an unknown token.
export async function recordOptOutByToken(db: DBLike, token: string): Promise<string | null> {
  await ensureMarketingTables(db);
  const row = await db
    .prepare("SELECT email FROM email_unsubscribe_tokens WHERE token = ?")
    .bind(String(token || ""))
    .first();
  if (!row?.email) return null;
  const email = norm(String(row.email));
  await db
    .prepare("INSERT OR IGNORE INTO marketing_opt_outs (email, unsubscribed_at) VALUES (?, ?)")
    .bind(email, now())
    .run();
  return email;
}

// The follow-up's content model: the plain-text builder below and the
// React Email template (emails/ClubFollowupEmail.tsx, via
// lib/email-render.ts) render from this one model, same discipline as
// the order emails. Prices come from the club constants in offers.ts.
export interface ClubFollowupModel {
  subject: string;
  priceLabel: string;
  annualLabel: string;
  audioMonthlyLabel: string;
  audioAnnualLabel: string;
  clubUrl: string;
  unsubscribeUrl: string;
  live: boolean;
}

export function buildClubFollowupModel(site: string, token: string): ClubFollowupModel {
  return {
    subject: "Join the Book Club: a printed set every 3 months",
    priceLabel: clubPriceLabel(),
    annualLabel: clubPriceLabel(CLUB_ANNUAL_PRICE_CENTS),
    audioMonthlyLabel: clubPriceLabel(AUDIO_CLUB_PRICE_CENTS),
    audioAnnualLabel: clubPriceLabel(AUDIO_CLUB_ANNUAL_PRICE_CENTS),
    clubUrl: `${site}/clubs`,
    unsubscribeUrl: unsubscribeUrl(site, token),
    live: clubIsLive(),
  };
}

export function buildClubFollowupEmail(
  site: string,
  token: string
): { subject: string; text: string } {
  const m = buildClubFollowupModel(site, token);
  const lines: string[] = [];
  lines.push("Thank you again for your Big Brain Shelf order.");
  lines.push("");
  lines.push("If your reader is ready for the next big idea, the Book Club is the easy way to keep the shelf growing without thinking about it.");
  lines.push("");
  lines.push(
    `Members get the club book as a full gift set (the printed storybook plus its printed coloring book) and a second printed book from the back catalog in each box, plus a sticker sheet and a little extra from the cast, and the digital editions in their library from the day they join. Membership is ${m.priceLabel} every 3 months, shipping included, and your price stays locked while the membership stays active. There is also an annual plan at ${m.annualLabel} a year.`
  );
  lines.push("");
  lines.push(
    "Your first box ships within a few days of the day you join, and a new box follows every 3 months from your join date."
  );
  lines.push("");
  lines.push(
    `Rather just listen? The Audio Club puts every Big Brain Shelf audiobook in your library for ${m.audioMonthlyLabel} a month, or ${m.audioAnnualLabel} a year, for as long as your membership is active. Listening only: nothing ships on that plan.`
  );
  lines.push("");
  lines.push(`Join the club: ${m.clubUrl}`);
  lines.push("");
  lines.push("Happy reading,");
  lines.push("Big Brain Shelf");
  lines.push("");
  lines.push(`You are getting this because you bought a book from Big Brain Shelf. Rather not get club news? Unsubscribe here: ${m.unsubscribeUrl}`);
  return { subject: m.subject, text: lines.join("\n") };
}

// Enqueue the day-3 follow-up for a completed order. Skips silently
// when the buyer is already a paid club member or has opted out of
// marketing mail; the outbox unique (order_id, kind) index makes repeat
// calls converge on one row. Callers wrap this in try/catch: marketing
// must never break an order.
export async function enqueueClubFollowup(db: DBLike, site: string, order: any): Promise<void> {
  const email = String(order?.email || "").trim();
  if (!email || !order?.id) return;
  await ensureMarketingTables(db);
  await ensureClubTable(db);
  if (await isPaidClubMember(db, email)) return;
  if (await isOptedOut(db, email)) return;
  const token = await getOrCreateUnsubscribeToken(db, email);
  const { subject, text } = buildClubFollowupEmail(site, token);
  await enqueueEmail(db, {
    orderId: order.id,
    kind: CLUB_FOLLOWUP_KIND,
    to: email,
    subject,
    text,
    sendAfter: now() + CLUB_FOLLOWUP_DELAY_SECONDS,
    fromEmail: NEWS_EMAIL,
  });
}
