// Release announcements: when a book is published, the shelf hears
// about it in two waves. Book Club members (paid) always hear FIRST
// (wave 1, immediate); everyone else on the site subscriber list gets
// the same news after the members-first window (wave 2, +3 days).
//
// The mail rides the existing outbox as marketing: sent from news@,
// suppressed for marketing opt-outs both at enqueue time (here) and at
// send time (flushOutbox re-checks the release kinds), and every
// message carries the stable tokened unsubscribe link. Idempotency is
// the outbox dedupe_key, one per book + wave + recipient
// (release:{slug}:{wave}:{email}), so a republish or a double publish
// click enqueues nothing twice. The publish action only enqueues on a
// book's FIRST publish (see stampPublishedAt), which is also when
// books.published_at is stamped, once and never overwritten.
//
// Real delivery still depends on the email transport being configured
// (Cloudflare Email Sending / Resend); without it the outbox rows
// queue safely and flush when a transport exists.

import { enqueueEmail, type DBLike } from "./orders";
import { ensureClubTable } from "./club";
import {
  ensureMarketingTables,
  getOrCreateUnsubscribeToken,
  isOptedOut,
  unsubscribeUrl,
} from "./marketing";
import { NEWS_EMAIL } from "./email";
import { buildCast, bookCast, TOPIC_LABELS } from "./cast-public";
import { mediaUrl } from "./media";
import { bookHref, ensurePublicSlugColumn } from "./public-slugs";
import { formatPublishedDate } from "./offers";
import { ensureOnce } from "./schema-cache";

export const RELEASE_CLUB_KIND = "release_club";
export const RELEASE_PUBLIC_KIND = "release_public";
export const RELEASE_KINDS = [RELEASE_CLUB_KIND, RELEASE_PUBLIC_KIND];
export const RELEASE_PUBLIC_DELAY_SECONDS = 3 * 24 * 60 * 60; // 3 days

export function isReleaseKind(kind: string): boolean {
  return RELEASE_KINDS.includes(kind);
}

const now = () => Math.floor(Date.now() / 1000);
const norm = (email: string) => email.trim().toLowerCase();

// books.published_at is added after the original schema shipped, so it
// is ensured at runtime in the same style as the outbox columns: check
// the pragma, ALTER only when missing. migration.sql carries the same
// statement as the schema record.
export async function ensurePublishedAtColumn(db: DBLike): Promise<void> {
  await ensureOnce(db, "books.published_at", async () => {
    const { results } = await db
      .prepare("SELECT name FROM pragma_table_info('books')")
      .bind()
      .all();
    const have = new Set((results || []).map((r: any) => String(r.name)));
    if (!have.has("published_at")) {
      await db.prepare("ALTER TABLE books ADD COLUMN published_at INTEGER").bind().run();
    }
  });
}

// Stamp the publication moment the first time a book is published.
// Returns true when this call was the first publish (the caller then
// enqueues the announcements); a republish leaves the original stamp
// untouched and returns false.
export async function stampPublishedAt(db: DBLike, slug: string, atSec: number): Promise<boolean> {
  await ensurePublishedAtColumn(db);
  const row: any = await db
    .prepare("SELECT published_at FROM books WHERE slug = ?")
    .bind(slug)
    .first();
  if (!row || row.published_at) return false;
  await db
    .prepare("UPDATE books SET published_at = ? WHERE slug = ? AND published_at IS NULL")
    .bind(atSec, slug)
    .run();
  return true;
}

export interface ReleaseCastEntry {
  name: string;
  species: string;
  role: string;
  portrait: string | null;
  debut: boolean;
}

// The book's public cast (same model as Meet the Cast: gallery
// portraits and overview roles), in story order, with a debut flag for
// characters whose name appears in no OTHER completed book. A name in
// an earlier book means a returning favorite, not an introduction.
export async function loadReleaseCast(db: DBLike, slug: string): Promise<ReleaseCastEntry[]> {
  await ensurePublicSlugColumn(db).catch(() => {});
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.species, c.book_slug,
              b.title AS book_title, b.topic AS book_topic, b.picture_book_key,
              b.public_slug AS book_public_slug
         FROM characters c
         JOIN books b ON b.slug = c.book_slug
        WHERE c.book_slug = ?`
    )
    .bind(slug)
    .all();
  const members = bookCast(buildCast((results || []) as any[]), slug);
  if (!members.length) return [];
  const { results: prior } = await db
    .prepare(
      `SELECT DISTINCT c.name AS name
         FROM characters c
         JOIN books b ON b.slug = c.book_slug
        WHERE b.status = 'complete' AND c.book_slug != ?`
    )
    .bind(slug)
    .all();
  const returning = new Set((prior || []).map((r: any) => String(r.name)));
  return members.map((m) => ({
    name: m.name,
    species: m.species,
    role: m.role,
    portrait: m.portrait,
    debut: !returning.has(m.name),
  }));
}

export interface ReleaseEmailModel {
  wave: "club" | "public";
  subject: string;
  bookTitle: string;
  bookUrl: string;
  coverUrl: string;
  shelfLabel: string;
  publishedLabel: string;
  description: string;
  priceLine: string;
  cast: ReleaseCastEntry[];
  unsubscribeUrl: string;
}

function priceLineFor(book: any): string {
  const parts: string[] = [];
  const price = Number(book?.price || 0);
  const print = Number(book?.price_print || 0);
  if (price > 0) {
    parts.push(
      `Digital bundle $${(price / 100).toFixed(2)}${book?.audiobook_key ? ", audiobook included" : ""}`
    );
  }
  if (print > 0) parts.push(`Full color printed book $${(print / 100).toFixed(2)}`);
  return parts.join(" · ");
}

export function buildReleaseModel(args: {
  site: string;
  book: any;
  cast: ReleaseCastEntry[];
  wave: "club" | "public";
  token: string;
}): ReleaseEmailModel {
  const { site, book, cast, wave, token } = args;
  const title = String(book.title || "A new Big Brain Shelf book");
  return {
    wave,
    subject:
      wave === "club"
        ? `Members first: ${title} has arrived`
        : `New on the shelf: ${title}`,
    bookTitle: title,
    // Announcement mail links carry the title-based public slug,
    // never the internal (source-derived) one.
    bookUrl: `${site}${bookHref(book)}`,
    coverUrl: mediaUrl(book.cover_key) || "",
    shelfLabel: TOPIC_LABELS[String(book.topic || "tech")] || "Tech",
    publishedLabel: book.published_at ? formatPublishedDate(Number(book.published_at)) : "",
    description: String(book.description || ""),
    priceLine: priceLineFor(book),
    cast,
    unsubscribeUrl: unsubscribeUrl(site, token),
  };
}

// Plain-text part of the announcement. The HTML part renders from the
// same model (emails/ReleaseEmail.tsx via lib/email-render.ts). No em
// dashes anywhere in the copy.
export function buildReleaseEmail(model: ReleaseEmailModel): { subject: string; text: string } {
  const lines: string[] = [];
  lines.push("Hello from Big Brain Shelf,");
  lines.push("");
  if (model.wave === "club") {
    lines.push(
      `Book Club members hear about every new book first, and this one is yours before anyone else: ${model.bookTitle} has arrived on the shelf.`
    );
  } else {
    lines.push(`A new book has arrived on the Big Brain Shelf: ${model.bookTitle}.`);
  }
  if (model.description) {
    lines.push("");
    lines.push(model.description);
  }
  lines.push("");
  lines.push(
    `Find it on the ${model.shelfLabel} shelf${model.publishedLabel ? `, published ${model.publishedLabel}` : ""}.${model.priceLine ? ` ${model.priceLine}.` : ""}`
  );
  lines.push(`See the book: ${model.bookUrl}`);
  if (model.cast.length) {
    lines.push("");
    lines.push("Meet the cast:");
    for (const c of model.cast) {
      const role = c.role ? `: ${c.role}` : "";
      lines.push(
        c.debut
          ? `Introducing ${c.name}, the ${c.species}${role}.`
          : `${c.name}, the ${c.species}, is back${role}.`
      );
    }
  }
  lines.push("");
  lines.push("Happy reading,");
  lines.push("Big Brain Shelf");
  lines.push("");
  lines.push(
    model.wave === "club"
      ? `You are getting this because you are a Big Brain Shelf Book Club member. Rather not get release news? Unsubscribe here: ${model.unsubscribeUrl}`
      : `You are getting this because you subscribed at bigbrainshelf.com. Rather not get release news? Unsubscribe here: ${model.unsubscribeUrl}`
  );
  return { subject: model.subject, text: lines.join("\n") };
}

async function outboxCountsForBook(
  db: DBLike,
  slug: string
): Promise<{ club: number; public: number }> {
  const { results } = await db
    .prepare(
      "SELECT kind, COUNT(*) AS n FROM email_outbox WHERE dedupe_key LIKE ? GROUP BY kind"
    )
    .bind(`release:${slug}:%`)
    .all();
  const counts = { club: 0, public: 0 };
  for (const r of (results || []) as any[]) {
    if (r.kind === RELEASE_CLUB_KIND) counts.club = Number(r.n || 0);
    if (r.kind === RELEASE_PUBLIC_KIND) counts.public = Number(r.n || 0);
  }
  return counts;
}

// Enqueue both announcement waves for a freshly published book.
// Wave 1: paid Book Club members, immediate. Wave 2: site subscribers
// who are not members, delayed by the members-first window. Opted-out
// addresses are skipped at enqueue (and re-checked at send). Returns
// the outbox row counts per wave after enqueueing, which makes repeat
// calls converge on the same numbers instead of double counting.
export async function enqueueReleaseAnnouncements(
  db: DBLike,
  site: string,
  slug: string,
  atSec: number = now()
): Promise<{ club: number; public: number }> {
  const book: any = await db.prepare("SELECT * FROM books WHERE slug = ?").bind(slug).first();
  if (!book) return { club: 0, public: 0 };
  await ensureMarketingTables(db);
  await ensureClubTable(db);
  const cast = await loadReleaseCast(db, slug);

  const { results: memberRows } = await db
    .prepare("SELECT email FROM club_signups WHERE status = 'paid'")
    .bind()
    .all();
  const memberSet = new Set<string>();
  for (const r of (memberRows || []) as any[]) {
    const e = norm(String(r.email || ""));
    if (e) memberSet.add(e);
  }
  const { results: subRows } = await db.prepare("SELECT email FROM subscribers").bind().all();
  const subscriberSet = new Set<string>();
  for (const r of (subRows || []) as any[]) {
    const e = norm(String(r.email || ""));
    if (e) subscriberSet.add(e);
  }

  const sendOne = async (email: string, wave: "club" | "public") => {
    if (await isOptedOut(db, email)) return;
    const token = await getOrCreateUnsubscribeToken(db, email);
    const model = buildReleaseModel({ site, book, cast, wave, token });
    const { subject, text } = buildReleaseEmail(model);
    await enqueueEmail(db, {
      orderId: null,
      kind: wave === "club" ? RELEASE_CLUB_KIND : RELEASE_PUBLIC_KIND,
      to: email,
      subject,
      text,
      sendAfter: wave === "club" ? null : atSec + RELEASE_PUBLIC_DELAY_SECONDS,
      fromEmail: NEWS_EMAIL,
      dedupeKey: `release:${slug}:${wave}:${email}`,
    });
  };

  for (const email of memberSet) await sendOne(email, "club");
  for (const email of subscriberSet) {
    if (memberSet.has(email)) continue; // members hear once, in wave 1
    await sendOne(email, "public");
  }
  return outboxCountsForBook(db, slug);
}

// Rebuild the model for an outbox row at HTML render time, mirroring
// the club follow-up pattern: the slug rides in the dedupe_key and the
// unsubscribe token is the same stable one the text was enqueued with.
export async function loadReleaseEmailModel(
  db: DBLike,
  site: string,
  row: { kind: string; to_email?: string | null; dedupe_key?: string | null }
): Promise<ReleaseEmailModel | null> {
  if (!isReleaseKind(row.kind)) return null;
  const m = String(row.dedupe_key || "").match(/^release:([^:]+):/);
  if (!m) return null;
  const slug = m[1];
  const book: any = await db.prepare("SELECT * FROM books WHERE slug = ?").bind(slug).first();
  if (!book) return null;
  const cast = await loadReleaseCast(db, slug);
  const token = await getOrCreateUnsubscribeToken(db, String(row.to_email || ""));
  return buildReleaseModel({
    site,
    book,
    cast,
    wave: row.kind === RELEASE_CLUB_KIND ? "club" : "public",
    token,
  });
}

export interface ReleaseWaveStatus {
  queued: number;
  sent: number;
  suppressed: number;
}

export interface ReleaseStatus {
  slug: string;
  title: string;
  publishedAt: number;
  publishedLabel: string;
  club: ReleaseWaveStatus;
  public: ReleaseWaveStatus;
}

// Admin rollup: every published book with a stamp, newest first, and
// per-wave outbox counts (queued = pending or failed, sent, and
// suppressed by an opt-out at send time).
export async function getReleaseAnnouncementStatus(db: DBLike): Promise<ReleaseStatus[]> {
  await ensurePublishedAtColumn(db);
  const { results: books } = await db
    .prepare(
      "SELECT slug, title, published_at FROM books WHERE status = 'complete' AND published_at IS NOT NULL ORDER BY published_at DESC"
    )
    .bind()
    .all();
  const out: ReleaseStatus[] = [];
  for (const b of (books || []) as any[]) {
    const { results } = await db
      .prepare(
        "SELECT kind, status, COUNT(*) AS n FROM email_outbox WHERE dedupe_key LIKE ? GROUP BY kind, status"
      )
      .bind(`release:${b.slug}:%`)
      .all();
    const blank = (): ReleaseWaveStatus => ({ queued: 0, sent: 0, suppressed: 0 });
    const club = blank();
    const pub = blank();
    for (const r of (results || []) as any[]) {
      const target = r.kind === RELEASE_CLUB_KIND ? club : r.kind === RELEASE_PUBLIC_KIND ? pub : null;
      if (!target) continue;
      const n = Number(r.n || 0);
      if (r.status === "sent") target.sent += n;
      else if (r.status === "suppressed") target.suppressed += n;
      else target.queued += n;
    }
    out.push({
      slug: String(b.slug),
      title: String(b.title || "Untitled book"),
      publishedAt: Number(b.published_at),
      publishedLabel: formatPublishedDate(Number(b.published_at)),
      club,
      public: pub,
    });
  }
  return out;
}
