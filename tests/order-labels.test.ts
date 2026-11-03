// Regression test for the generic-label defect (admin redesign fix,
// 2026-11-03): pre-migration orders store items under the retired
// INTERNAL slug "mastery", while the Mira book row now wears
// "mira-the-heron-and-the-still-water" as both slug and public slug.
// Production's book_slug_aliases had rows for the retired fern /
// basil / wally public slugs but NO row for "mastery", so every label
// surface fell through to "Big Brain Shelf book" (order #CDF25AF9).
// The S4 packing test missed it because its fixture hand-seeded the
// alias production lacks. This fixture mirrors production exactly:
// the book row under the new slug, the order under "mastery", and NO
// pre-seeded alias; the fix must come from the code (the rename seed
// in lib/public-slugs.ts), not from fixture data.
// Run with: bun tests/order-labels.test.ts
import { Database } from "bun:sqlite";
import { orderItemLabels, orderPickList } from "../src/lib/orders";
import { resolveBookForPublicRoute } from "../src/lib/public-slugs";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, cover_key TEXT, price REAL, price_print REAL, picture_book_key TEXT, coloring_book_key TEXT, audiobook_key TEXT, public_slug TEXT, status TEXT);
INSERT INTO books VALUES ('mira-the-heron-and-the-still-water', 'Mira the Heron and the Still Water', NULL, 899, 2000, 'p', 'c', 'a', 'mira-the-heron-and-the-still-water', 'complete');
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, book_slugs TEXT, items TEXT, amount INTEGER, currency TEXT, status TEXT, created_at INTEGER, physical_status TEXT, pack_json TEXT);
INSERT INTO orders VALUES ('cdf25af9-03df-4e59-9f1c-b343ca481cc5', '', 'buyer@example.com', '["mastery"]', '[{"slug":"mastery","format":"digital","qty":1},{"slug":"mastery","format":"giftset","qty":1}]', 3399, 'usd', 'complete', 1793400000, 'preorder_received', NULL);
INSERT INTO orders VALUES ('ordunknown1', '', 'buyer@example.com', '["nosuchbook"]', '[{"slug":"nosuchbook","format":"digital","qty":1}]', 899, 'usd', 'complete', 1793400001, NULL, NULL);
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

const order = {
  id: "cdf25af9-03df-4e59-9f1c-b343ca481cc5",
  items: '[{"slug":"mastery","format":"digital","qty":1},{"slug":"mastery","format":"giftset","qty":1}]',
  book_slugs: '["mastery"]',
};

{
  const labels = await orderItemLabels(db, [order]);
  const mine = labels.get(order.id) || [];
  assert(mine[0] === "Mira the Heron and the Still Water (digital)",
    "labels: the pre-migration digital line names Mira, not the fallback");
  assert(mine[1] === "Mira the Heron and the Still Water (gift set: printed storybook and coloring book, digital files included)",
    "labels: the pre-migration gift set line names Mira, not the fallback");

  // The fix is durable in code: consulting the labels seeded the
  // rename alias into the table (INSERT OR IGNORE via ensureOnce).
  const alias = raw.query("SELECT slug FROM book_slug_aliases WHERE alias = 'mastery'").get() as any;
  assert(alias?.slug === "mira-the-heron-and-the-still-water",
    "labels: the read seeded the mastery alias from code");

  // The public route resolves the retired slug too (301 source).
  // The resolver reports an alias-table hit with via "internal" (its
  // standing convention for the alias branch).
  const resolved = await resolveBookForPublicRoute(db, "mastery");
  assert(resolved?.book?.slug === "mira-the-heron-and-the-still-water" && resolved?.via === "internal",
    "routes: /books/mastery resolves to the Mira book through the alias");

  // The pick list (packing + detail groups) names the book and uses
  // its public title, code, and canonical link.
  const picks = await orderPickList(db, [order]);
  const groups = picks.get(order.id) || [];
  const gift = groups.find((g) => g.format === "giftset");
  assert(!!gift && gift.title === "Mira the Heron and the Still Water" && gift.code === "MTH-still-water" &&
    gift.href === "/books/mira-the-heron-and-the-still-water",
    "pick list: the gift set group carries Mira's title, code, and public link");

  // The fallback still exists for a slug that names nothing at all:
  // the fix resolves KNOWN retired slugs, it does not invent titles.
  const unknown = await orderItemLabels(db, [{ id: "ordunknown1", items: '[{"slug":"nosuchbook","format":"digital","qty":1}]', book_slugs: '["nosuchbook"]' }]);
  assert((unknown.get("ordunknown1") || [])[0] === "Big Brain Shelf book (digital)",
    "labels: a truly unknown slug keeps the neutral fallback");
}

if (failures) { console.error(failures + " order-labels test(s) failed"); process.exit(1); }
console.log("All order-labels tests passed.");
