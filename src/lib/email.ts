// The store's one email rail: an outbox-first transport layer.
//
// Every message is recorded in the email_outbox table before any send is
// attempted (see lib/orders.ts for how rows get enqueued). flushOutbox
// sends pending rows through the first transport that works:
//
//   1. Cloudflare Email Sending, via the worker's EMAIL (send_email)
//      binding, once bigbrainshelf.com is onboarded as a sending domain
//      on the Cloudflare account. No API key is involved.
//   2. Resend, when RESEND_API_KEY is configured on the worker, as the
//      automatic fallback if the Cloudflare send fails (or the binding
//      is absent). The bigbrainshelf.com domain must be verified in
//      Resend before those sends succeed.
//
// If neither transport is configured, sends are skipped and rows stay
// pending. Nothing is ever dropped: a later webhook delivery or the admin
// "retry emails" action calls flushOutbox again and pending rows go out
// then. The default from address is orders@bigbrainshelf.com; rows with
// a scoped sender carry it in from_email (see the identity map below).
//
// The HTML part of each message is rendered at send time from the same
// content models that produce the stored plain text (lib/email-render.ts
// + emails/ React Email templates); the stored body_text stays the
// plain-text part, byte for byte what it has always been.

import { ensureOutboxColumns, type DBLike } from "./orders";

export const EMAIL_FROM = "Big Brain Shelf <orders@bigbrainshelf.com>";
export const EMAIL_FROM_ADDRESS = "orders@bigbrainshelf.com";
export const EMAIL_FROM_NAME = "Big Brain Shelf";

// Sender identities on bigbrainshelf.com. Sending is verified per domain
// (in Resend today, and in Cloudflare Email Sending once the domain is
// onboarded there), so any address on the domain can send once the domain
// itself is verified; there is no per-address setup. The map:
//   orders@    money and packages: order confirmations, shipping and
//              delivery updates, club billing problems, and the owner's
//              store alerts. The default sender (rows with no from_email).
//   noreply@   sign-in links, password resets, and the contact-form
//              forward. Nobody should reply to these; the address says
//              so, and its mail carries itself as Reply-To (never
//              support@). Rows get this sender from senderForKind in
//              lib/orders.ts at enqueue time.
//   hello@     the mail that should feel like a person wrote it: the
//              family welcome, the birthday gift email, the club
//              welcome, and club box state notes. Also assigned by
//              senderForKind in lib/orders.ts.
//   support@   the human support identity. orders@ and hello@ mail
//              carries it as Reply-To so buyer replies land with
//              support, and it is where CG answers from. Receiving runs
//              through Cloudflare Email Routing on the domain.
//   news@      Book Club / new-release sends. The day-3 post-purchase
//              club follow-up sends from here (rows carry from_email;
//              see lib/marketing.ts). When broadcast volume starts, this
//              identity moves to a sending subdomain to keep marketing
//              reputation off the root domain that orders@ depends on.
//   outreach@  partnerships, press, and bookstore outreach. Reserved.
export const SUPPORT_EMAIL = "support@bigbrainshelf.com";
export const NEWS_EMAIL = "news@bigbrainshelf.com";
export const NOREPLY_EMAIL = "noreply@bigbrainshelf.com";
export const HELLO_EMAIL = "hello@bigbrainshelf.com";
export const OUTREACH_EMAIL = "outreach@bigbrainshelf.com";

const MAX_ATTEMPTS = 5;
const DEFAULT_SITE = "https://bigbrainshelf.com";

export interface OutgoingMessage {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  replyTo?: string;
  // Bare sender address override (marketing rows send from news@).
  // Defaults to orders@ when absent.
  fromAddress?: string;
}

export function cloudflareEmailAvailable(env: any): boolean {
  return Boolean(env?.EMAIL && typeof env.EMAIL.send === "function");
}

export function emailTransportAvailable(env: any): boolean {
  return cloudflareEmailAvailable(env) || Boolean(env?.RESEND_API_KEY);
}

export async function sendViaCloudflare(
  env: any,
  msg: OutgoingMessage
): Promise<{ ok: boolean; error?: string }> {
  if (!cloudflareEmailAvailable(env)) {
    return { ok: false, error: "EMAIL binding not configured" };
  }
  try {
    await env.EMAIL.send({
      from: { email: msg.fromAddress || EMAIL_FROM_ADDRESS, name: EMAIL_FROM_NAME },
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    });
    return { ok: true };
  } catch (err: any) {
    const code = err?.code ? ` [${err.code}]` : "";
    return {
      ok: false,
      error: `cloudflare email${code}: ${String(err?.message || err)}`.slice(0, 500),
    };
  }
}

export async function sendViaResend(
  env: any,
  msg: OutgoingMessage
): Promise<{ ok: boolean; error?: string }> {
  if (!env?.RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        // Resend sits behind Cloudflare, which blocks some default agents.
        "User-Agent": "curl/8.0",
      },
      body: JSON.stringify({
        from: msg.fromAddress ? `${EMAIL_FROM_NAME} <${msg.fromAddress}>` : EMAIL_FROM,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `resend ${res.status}: ${detail.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// Send one message: Cloudflare Email Sending first (when the binding is
// present), Resend as the automatic fallback on any Cloudflare failure.
export async function sendEmail(
  env: any,
  msg: OutgoingMessage
): Promise<{ ok: boolean; transport?: string; error?: string }> {
  const errors: string[] = [];
  if (cloudflareEmailAvailable(env)) {
    const cf = await sendViaCloudflare(env, msg);
    if (cf.ok) return { ok: true, transport: "cloudflare" };
    errors.push(cf.error || "cloudflare email failed");
  }
  if (env?.RESEND_API_KEY) {
    const rs = await sendViaResend(env, msg);
    if (rs.ok) return { ok: true, transport: "resend" };
    errors.push(rs.error || "resend failed");
  }
  if (!errors.length) errors.push("no email transport configured");
  return { ok: false, error: errors.join("; ") };
}

// Marketing opt-out check, done at send time (a follow-up row can sit
// for days, and the reader may unsubscribe in between). Read directly
// here so email.ts stays free of a marketing import; a missing table
// simply means nobody has opted out yet.
async function isMarketingSuppressed(db: DBLike, row: any): Promise<boolean> {
  // Marketing kinds: the post-purchase club follow-up, the Book Club
  // selection reminders, and the release announcements (both waves).
  // Transactional cycle mail (locked, shipped, action needed) is not
  // marketing and is never suppressed here.
  const marketing =
    row.kind === "club_followup" ||
    row.kind === "club_cycle_reminder_14" ||
    row.kind === "club_cycle_reminder_3" ||
    row.kind === "release_club" ||
    row.kind === "release_public";
  if (!marketing) return false;
  try {
    const hit = await db
      .prepare("SELECT email FROM marketing_opt_outs WHERE email = ?")
      .bind(String(row.to_email || "").trim().toLowerCase())
      .first();
    return Boolean(hit);
  } catch {
    return false;
  }
}

// Attempt to send pending outbox rows (oldest first). A row is marked sent
// only when a transport accepts it; failures bump attempts and keep the
// row for a later flush until MAX_ATTEMPTS, after which it stays as
// 'failed' for a human to look at. Rows are never deleted here. Rows
// with a send_after in the future (the day-3 club follow-up) are not
// picked up until they are due.
export async function flushOutbox(
  db: DBLike,
  env: any,
  limit = 10,
  site: string = DEFAULT_SITE
): Promise<{ attempted: number; sent: number; failed: number; skipped: number }> {
  await ensureOutboxColumns(db);
  const { results } = await db
    .prepare(
      "SELECT * FROM email_outbox WHERE (status = 'pending' OR (status = 'failed' AND attempts < ?)) AND (send_after IS NULL OR send_after <= ?) ORDER BY created_at ASC LIMIT ?"
    )
    .bind(MAX_ATTEMPTS, Math.floor(Date.now() / 1000), limit)
    .all();
  const rows = (results || []) as any[];
  const summary = { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  if (!emailTransportAvailable(env)) {
    summary.skipped = rows.length;
    return summary;
  }
  for (const row of rows) {
    if (await isMarketingSuppressed(db, row)) {
      // Opted out since enqueue: close the row without sending. It is
      // never retried (the flush only picks pending/failed rows).
      await db
        .prepare("UPDATE email_outbox SET status = 'suppressed' WHERE id = ?")
        .bind(row.id)
        .run();
      summary.skipped += 1;
      continue;
    }
    summary.attempted += 1;
    // Best effort HTML: if rendering fails for any reason, the message
    // still goes out with its stored plain text, as it always has.
    let html: string | null = null;
    try {
      const { renderOutboxEmailHtml } = await import("./email-render");
      html = await renderOutboxEmailHtml(db, site, row);
    } catch {
      html = null;
    }
    const res = await sendEmail(env, {
      to: row.to_email,
      subject: row.subject,
      text: row.body_text,
      html,
      // Order mail sends from orders@; rows carry their scoped sender
      // (noreply@, hello@, news@) in from_email when they have one.
      // Buyer replies go to the support identity, not back to the
      // sending address, EXCEPT noreply@ mail, which carries itself as
      // Reply-To so nobody answers it expecting a person. A row can
      // carry its own reply_to (contact form forwards carry the
      // sender's address so the owner can answer them directly).
      fromAddress: row.from_email || undefined,
      replyTo:
        row.reply_to ||
        (row.from_email === NOREPLY_EMAIL ? NOREPLY_EMAIL : SUPPORT_EMAIL),
    });
    if (res.ok) {
      summary.sent += 1;
      await db
        .prepare("UPDATE email_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?")
        .bind(Math.floor(Date.now() / 1000), row.id)
        .run();
    } else {
      summary.failed += 1;
      await db
        .prepare("UPDATE email_outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?")
        .bind(String(res.error || "send failed").slice(0, 500), row.id)
        .run();
    }
  }
  return summary;
}
