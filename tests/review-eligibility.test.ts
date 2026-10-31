// Review eligibility tests (CG, 2026-10-31): only readers may
// review (bought it, or can read/listen through a club), and one
// review per reader per book ever. Runs the real src/lib code
// against an in-memory bun:sqlite database.
// Run with: bun tests/review-eligibility.test.ts
import { Database } from "bun:sqlite";
import { ensureReviewsTable, reviewEligibility } from "../src/lib/reviews";
import { ensureClubTable } from "../src/lib/club";
import { ensureClubCycleTables } from "../src/lib/club-cycles";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, topic TEXT, cover_key TEXT, status TEXT, picture_book_key TEXT, coloring_book_key TEXT, epub_key TEXT, color_book_key TEXT, audiobook_key TEXT, price INTEGER, price_print INTEGER);
CREATE TABLE club_signups (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, shelf TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, book_slugs TEXT, items TEXT, stripe_session_id TEXT, amount INTEGER DEFAULT 0, currency TEXT DEFAULT 'usd', status TEXT DEFAULT 'complete', delivery_token TEXT, cart_fingerprint TEXT, physical_status TEXT, ship_name TEXT, ship_address TEXT, shipping_cents INTEGER, created_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO books (slug, title, topic, status, cover_key, picture_book_key, coloring_book_key, audiobook_key, price, price_print) VALUES
  ('alpha', 'Alpha', 'tech', 'complete', 'a/cover.jpg', 'a/pic.pdf', 'a/col.pdf', 'a/audio.m4b', 899, 2000),
  ('beta', 'Beta', 'money', 'complete', 'b/cover.jpg', 'b/pic.pdf', 'b/col.pdf', 'b/audio.m4b', 899, 2000);
`);

const db = {
  prepare(sql: string) {
    const calls = (args: any[]) => {
      const stmt = raw.query(sql);
      return {
        async run() { const r = stmt.run(...args) as any; return { meta: { changes: r?.changes ?? 0 } }; },
        async first() { return stmt.get(...args) ?? null; },
        async all() { return { results: stmt.all(...args) }; },
      };
    };
    return { bind: (...args: any[]) => calls(args), ...calls([]) };
  },
} as any;

await ensureClubTable(db);
await ensureClubCycleTables(db);
await ensureReviewsTable(db);

// 1. A stranger (no order, no club) cannot review.
const stranger = await reviewEligibility(db, { id: "u-stranger", email: "stranger@example.com" }, "alpha");
assert(!stranger.allowed && stranger.reason === "not_entitled", "stranger is not entitled");

// 2. A buyer whose order is on their EMAIL only (guest checkout,
// signed in later) can review, verified.
raw.exec(`INSERT INTO orders (id, user_id, email, book_slugs, items, amount, status, created_at)
  VALUES ('o1', NULL, 'buyer@example.com', '["alpha"]', '[{"slug":"alpha","format":"digital"}]', 899, 'complete', 100)`);
const buyer = await reviewEligibility(db, { id: "u-buyer", email: "buyer@example.com" }, "alpha");
assert(buyer.allowed && buyer.verified, "email-matched buyer allowed + verified");

// 3. The same buyer cannot review a different book they lack.
const other = await reviewEligibility(db, { id: "u-buyer", email: "buyer@example.com" }, "beta");
assert(!other.allowed && other.reason === "not_entitled", "buyer cannot review a book they do not have");

// 4. One review per reader per book: an existing pending review blocks.
raw.exec(`INSERT INTO reviews (id, book_slug, user_id, user_email, display_name, rating, title, body, status, created_at)
  VALUES ('r1', 'alpha', 'u-buyer', 'buyer@example.com', 'Buyer', 5, 'Great', 'Loved it', 'pending', 200)`);
const dupe = await reviewEligibility(db, { id: "u-buyer", email: "buyer@example.com" }, "alpha");
assert(!dupe.allowed && dupe.reason === "already_reviewed", "second review blocked");

// 5. An Audio Club member can review a book they can listen to.
raw.exec(`INSERT INTO club_signups (id, name, email, shelf, status, created_at, plan, club_plan, subscription_status, user_id)
  VALUES ('c1', 'Member', 'member@example.com', 'tech', 'paid', 100, 'monthly', 'audio', 'active', 'u-member')`);
const member = await reviewEligibility(db, { id: "u-member", email: "member@example.com" }, "beta");
assert(member.allowed, "club member allowed to review a listenable book");
assert(!member.verified, "club listening is not a verified purchase");

if (failures) { console.error(failures + " FAILURES"); process.exit(1); }
console.log("ALL REVIEW ELIGIBILITY TESTS PASSED");
