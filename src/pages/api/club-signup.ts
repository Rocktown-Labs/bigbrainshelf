import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { getAuth } from "../../lib/auth";
import { ensureClubTable, getClubSignup, isShelf, upsertClubReservation } from "../../lib/club";
import { clubSignupStatus } from "../../lib/offers";

// POST /api/club-signup { shelf? } -> { ok: true, status }
// (Shelf optional since 2026-10-29: the plans page sells the plan
// only, and members configure their offering in their account.)
// The Book Club waitlist join, shown on /clubs when the physical
// club is full. Like checkout, it requires a store account (the
// middleware passes this route through to self-authenticate, same as
// /api/club/checkout): the reservation row is keyed to the SESSION
// user (id + account email), and any email in the request body is
// ignored. An anonymous caller can neither create a reservation in
// someone else's name nor overwrite an existing member's row, which
// the old public form allowed because upsertClubReservation updates
// name and shelf on conflict. Joining also adds the account email to
// the general subscribers list with source 'club', so release emails
// reach waitlisted members.

export const POST: APIRoute = async ({ request }) => {
  const db = env.DB as any;
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.email) {
    return Response.json(
      { ok: false, error: "Create your account or sign in to join the waitlist.", needsAccount: true },
      { status: 401 }
    );
  }
  await ensureClubTable(db);

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by validation below */ }
  const email = String(session.user.email).trim().toLowerCase();
  const name =
    String(body?.name || "").trim().slice(0, 120) ||
    String((session.user as any).name || "").trim() ||
    email.split("@")[0];
  // The plans page no longer asks visitors to pick a shelf before
  // subscribing (owner, 2026-10-29): members configure their offering
  // after joining, in their account. The ledger column is NOT NULL,
  // so a missing or invalid pick reuses the account's existing shelf
  // when there is one and falls back to the default, exactly like
  // the Audio Club branch of checkout. An explicit valid shelf in
  // the body is still honored for older clients.
  let shelf = String(body?.shelf || "").trim().toLowerCase();
  if (!isShelf(shelf)) {
    const existing = await getClubSignup(db, email).catch(() => null);
    shelf = existing?.shelf && isShelf(String(existing.shelf)) ? String(existing.shelf) : "tech";
  }

  const status = clubSignupStatus();
  // One row per account email. A repeat signup updates the name and
  // shelf pick but keeps the original status and join date.
  await upsertClubReservation(db, { name, email, shelf, status, userId: session.user.id });

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS subscribers (
       id TEXT PRIMARY KEY,
       email TEXT NOT NULL UNIQUE,
       created_at INTEGER NOT NULL,
       source TEXT NOT NULL DEFAULT 'footer'
     )`
  ).run();
  const sub = await db.prepare(
    "INSERT OR IGNORE INTO subscribers (id, email, created_at, source) VALUES (?, ?, ?, 'club')"
  ).bind(crypto.randomUUID(), email, Date.now()).run();
  const already = !(sub.meta && Number(sub.meta.changes) > 0);

  const row = await db.prepare("SELECT status FROM club_signups WHERE email = ?").bind(email).first();
  return Response.json({ ok: true, status: row?.status || status, already });
};
