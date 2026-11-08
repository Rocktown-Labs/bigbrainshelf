// Club RBAC tests (2026-10-28 page rewrite + flow hardening): the
// club is account first, then checkout, then access, and every step
// is keyed to the session server-side.
//
// Pins:
//  - /api/club/checkout requires a session BEFORE anything else (an
//    anonymous caller gets 401 even when Stripe is unconfigured),
//    and keys the reservation + Stripe metadata to the session user;
//    the request body can never supply the member's email.
//  - /api/club-signup (the waitlist join) requires a session too and
//    keys the row to the session email + user id; a body email is
//    ignored, so nobody can create or overwrite another person's
//    club row (the old public form could: the upsert updates name
//    and shelf on conflict).
//  - /api/club/selection loads the member by the session email only.
//  - the admin club API stays behind the admin session (locals.user).
//  - activation binds user id + plan from the checkout session's
//    metadata, and the membership lookup (the entitlement layer's
//    only door) answers for the account that owns the row and no
//    one else.
//  - reader / page / download routes reach access only through the
//    server-side entitlement layer in lib/library.ts.
//  - the /clubs page carries no founding-offer copy and (CG,
//    2026-11-07) joins through the cart: the join forms add the club
//    line and open the sheet, no account gate anywhere.
//
// Lib-level checks run the real src/lib code against an in-memory
// bun:sqlite database; route checks are source pins in the style of
// the other suites. Run with: bun tests/club-rbac.test.ts
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  activateClubFromSession,
  upsertClubReservation,
  getClubMembership,
  ensureClubTable,
} from "../src/lib/club";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- Route source pins ------------------------------------------------
const checkout = read("../src/pages/api/club/checkout.ts");
const sessionCheckAt = checkout.indexOf("auth.api.getSession");
const stripeCheckAt = checkout.indexOf("if (!e.STRIPE_SECRET_KEY)");
assert(sessionCheckAt > -1 && stripeCheckAt > -1 && sessionCheckAt < stripeCheckAt, "checkout: session is checked before the Stripe config check (anonymous gets 401 in every server state)");
assert(checkout.includes("status: 401") && checkout.includes("needsAccount: true"), "checkout: anonymous callers get 401 with needsAccount");
assert(checkout.includes("String(session.user.email"), "checkout: member email comes from the session");
assert(!checkout.includes("body?.email") && !checkout.includes("body.email"), "checkout: the request body email is never read");
assert(checkout.includes("user_id: session.user.id"), "checkout: Stripe metadata carries the session user id");
assert(checkout.includes("userId: session.user.id"), "checkout: the reservation row is keyed to the session user id");

const waitlist = read("../src/pages/api/club-signup.ts");
assert(waitlist.includes("auth.api.getSession"), "waitlist: the route resolves the caller's session itself");
assert(waitlist.includes("status: 401") && waitlist.includes("needsAccount: true"), "waitlist: anonymous callers get 401 with needsAccount");
assert(waitlist.includes("String(session.user.email"), "waitlist: member email comes from the session");
assert(!waitlist.includes("body?.email") && !waitlist.includes("body.email"), "waitlist: the request body email is never read");
assert(waitlist.includes("userId: session.user.id"), "waitlist: the reservation row is keyed to the session user id");

const selection = read("../src/pages/api/club/selection.ts");
assert(selection.includes("auth.api.getSession") && selection.includes("getClubSignup(e.DB, session.user.email)"), "selection: the member row is loaded by the session email only");

const adminClub = read("../src/pages/api/admin/club.ts");
assert(adminClub.includes("(locals as any)?.user") && adminClub.includes("status: 401"), "admin club API: gated on the admin session (locals.user)");

const webhook = read("../src/pages/api/stripe/webhook.ts");
assert(webhook.includes("activateClubFromSession"), "webhook: club activation runs through activateClubFromSession (metadata-bound)");

// Access routes: the server-side entitlement layer is the only door.
const audioRoute = read("../src/pages/api/library/audio/[slug]/[track].ts");
assert(audioRoute.includes("ownsAudioBook"), "audio stream route: access decided by ownsAudioBook (library entitlement layer)");
const pageRoute = read("../src/pages/api/library/page/[slug].ts");
assert(pageRoute.includes("ownsDigitalBook"), "reader page route: access decided by ownsDigitalBook (library entitlement layer)");
const downloadRoute = read("../src/pages/api/download.ts");
assert(downloadRoute.includes("getDigitalEntitlements"), "download route: access decided by getDigitalEntitlements (library entitlement layer)");

// ---- Page copy pins -----------------------------------------------------
const page = read("../src/pages/clubs.astro");
assert(!/founding (member|membership|cohort|price|plan|spot|queue|lock)/i.test(page), "clubs page: no founding-offer copy anywhere");
// The account gate is retired (CG, 2026-11-07): joining is adding
// the club to the cart and checking out, guests included. The pins
// below stood for the old account-first flow until this change.
assert(!page.includes("Create an account to join"), "clubs page: no account gate on the join buttons");
assert(!page.includes("/signup?next="), "clubs page: no signup detour");
assert(page.includes("Add to cart"), "clubs page: the join buttons add to the cart");
assert(page.includes('addClubToCart("book-club"'), "clubs page: the Book Club form adds the book-club cart line");
assert(page.includes('addClubToCart("audio-club"'), "clubs page: the Audio Club form adds the audio-club cart line");
assert(page.includes("your membership lives on your email"), "clubs page: states the email-keyed membership in one line");
assert(!page.includes('id="club-email"') && !page.includes('id="audio-email"'), "clubs page: no email fields (the account supplies the email)");

// ---- Lib-level scoping --------------------------------------------------
const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, topic TEXT, cover_key TEXT, status TEXT, picture_book_key TEXT, coloring_book_key TEXT, epub_key TEXT, color_book_key TEXT, audiobook_key TEXT, price INTEGER, price_print INTEGER);
CREATE TABLE club_signups (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, shelf TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, book_slugs TEXT, items TEXT, stripe_session_id TEXT, amount INTEGER DEFAULT 0, currency TEXT DEFAULT 'usd', status TEXT DEFAULT 'complete', delivery_token TEXT, cart_fingerprint TEXT, physical_status TEXT, ship_name TEXT, ship_address TEXT, shipping_cents INTEGER, created_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO books (slug, title, topic, status, picture_book_key, coloring_book_key, audiobook_key, price, price_print) VALUES
  ('algorithms', 'Fern', 'tech', 'complete', 'f/pic.pdf', 'f/col.pdf', 'f/audio.m4b', 899, 2000);
`);
const db = {
  prepare(sql: string) {
    return {
      bind(...args: any[]) {
        const stmt = raw.query(sql);
        return {
          async run() { const r = stmt.run(...args) as any; return { meta: { changes: r?.changes ?? 0 } }; },
          async first() { return stmt.get(...args) ?? null; },
          async all() { return { results: stmt.all(...args) }; },
        };
      },
    };
  },
} as any;
await ensureClubTable(db);

// Activation binds the membership to the checkout session's user:
// the row gains the metadata user id and the metadata plan.
const res = await upsertClubReservation(db, {
  name: "Uma", email: "uma@example.com", shelf: "tech",
  status: "queued", userId: "user-uma", clubPlan: "audio",
});
const member = await activateClubFromSession(db, {
  id: "cs_uma",
  customer: "cus_uma",
  subscription: "sub_uma",
  metadata: {
    club: "1", club_signup_id: res.id, club_plan: "audio", plan: "monthly",
    email: "uma@example.com", name: "Uma", shelf: "tech", user_id: "user-uma",
  },
});
assert(member?.user_id === "user-uma", "activation: the row is bound to the metadata user id");
assert(member?.club_plan === "audio" && member?.plan === "monthly", "activation: plan and period come from the metadata");

// The membership lookup answers for the owning account only.
const own = await getClubMembership(db, { id: "user-uma", email: "uma@example.com" });
assert(own?.id === res.id, "membership lookup: the owner account finds its row");
const stranger = await getClubMembership(db, { id: "user-other", email: "other@example.com" });
assert(stranger === null, "membership lookup: a different account gets nothing");

// A reservation written for one email never mutates another email's
// row (the property the session keying relies on at the route layer).
const victimBefore = raw.query("SELECT name, shelf FROM club_signups WHERE email = 'uma@example.com'").get() as any;
await upsertClubReservation(db, {
  name: "Mallory", email: "mallory@example.com", shelf: "money",
  status: "queued", userId: "user-mallory", clubPlan: "physical",
});
const victimAfter = raw.query("SELECT name, shelf FROM club_signups WHERE email = 'uma@example.com'").get() as any;
assert(victimAfter.name === victimBefore.name && victimAfter.shelf === victimBefore.shelf, "reservations are scoped per email: another signup leaves the row untouched");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nALL CLUB RBAC TESTS PASSED");
