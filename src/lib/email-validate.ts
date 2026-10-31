// Email validation + the newsletter subscribe write, shared so the
// rules are unit-testable and the /api/subscribe route stays thin.
//
// The "subscribers" table is the free newsletter list (new release
// announcements; wave 2 in lib/releases.ts reads it). It is NOT the
// paid Book Club: the club lives in club_signups and keeps its name.
// Validation is strict and happens before any write: an invalid
// address returns 400 from the route and no row is ever written.

import type { DBLike } from "./orders";

export const INVALID_EMAIL_MESSAGE = "That email does not look right.";

export function normalizeEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

export type EmailValidation =
  | { ok: true; email: string }
  | { ok: false; email: string };

// Rules (checked on the normalized address):
// - total length 1..254
// - exactly one "@"
// - local part: 1..64 chars, no whitespace, no consecutive dots,
//   does not start or end with a dot
// - domain: at least one dot, every label non-empty alphanumeric or
//   hyphen (not leading/trailing hyphen), top label at least 2 letters
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TLD_RE = /^[a-z]{2,}$/;

export function validateEmail(raw: unknown): EmailValidation {
  const email = normalizeEmail(raw);
  const fail: EmailValidation = { ok: false, email };
  if (!email) return fail;
  if (email.length > 254) return fail;
  const parts = email.split("@");
  if (parts.length !== 2) return fail;
  const [local, domain] = parts;
  if (!local || local.length > 64) return fail;
  if (/\s/.test(local) || local.includes("..")) return fail;
  if (local.startsWith(".") || local.endsWith(".")) return fail;
  if (!domain || /\s/.test(domain)) return fail;
  const labels = domain.split(".");
  if (labels.length < 2) return fail;
  for (const label of labels) {
    if (!DOMAIN_LABEL_RE.test(label)) return fail;
  }
  if (!TLD_RE.test(labels[labels.length - 1])) return fail;
  return { ok: true, email };
}

// Optional display name from the subscribe form. Never required and
// never trusted as markup: control characters and angle brackets are
// stripped, whitespace is collapsed, and the result is capped at 60
// characters. Empty after cleaning means "no name given" (null).
export function sanitizeSubscriberName(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw)
    .replace(/[<>\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned || null;
}

// The table is also created by migration.sql; the CREATE here keeps
// the subscribe path self-sufficient on a fresh database.
export async function ensureSubscribersTable(db: DBLike): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS subscribers (
         id TEXT PRIMARY KEY,
         email TEXT NOT NULL UNIQUE,
         created_at INTEGER NOT NULL,
         source TEXT NOT NULL DEFAULT 'footer',
         name TEXT
       )`
    )
    .bind()
    .run();
  // Existing tables predate the name column; add it when missing
  // (same pragma-probe pattern as ensureOutboxColumns in orders.ts).
  try {
    const { results } = await db
      .prepare("SELECT name FROM pragma_table_info('subscribers')")
      .bind()
      .all();
    const have = new Set((results || []).map((r: any) => String(r.name)));
    if (!have.has("name")) {
      await db.prepare("ALTER TABLE subscribers ADD COLUMN name TEXT").bind().run();
    }
  } catch { /* the insert below surfaces any real schema problem */ }
}

export type AddSubscriberResult =
  | { ok: true; already: boolean; email: string }
  | { ok: false };

// Validate, normalize, and insert one newsletter subscriber.
// Duplicates are an idempotent success (already: true), never an
// error and never a second row. Invalid input writes nothing. The
// optional name is stored on first subscribe; a duplicate subscribe
// may fill in a name the row does not have yet, but never overwrites
// a name already on file.
export async function addSubscriber(
  db: DBLike,
  rawEmail: unknown,
  rawSource?: unknown,
  rawName?: unknown
): Promise<AddSubscriberResult> {
  const v = validateEmail(rawEmail);
  if (!v.ok) return { ok: false };
  await ensureSubscribersTable(db);
  const source = String(rawSource || "footer").slice(0, 40) || "footer";
  const name = sanitizeSubscriberName(rawName);
  const res = await db
    .prepare(
      "INSERT OR IGNORE INTO subscribers (id, email, created_at, source, name) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(crypto.randomUUID(), v.email, Date.now(), source, name)
    .run();
  const already = !(res.meta && Number(res.meta.changes) > 0);
  if (already && name) {
    await db
      .prepare(
        "UPDATE subscribers SET name = ? WHERE email = ? AND (name IS NULL OR name = '')"
      )
      .bind(name, v.email)
      .run();
  }
  return { ok: true, already, email: v.email };
}
