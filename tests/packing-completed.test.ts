// Packing shelf separation (admin redesign fix, 2026-11-03): the
// shelf is work WAITING to be packed and shipped only. Parcels that
// already shipped or were delivered come off the queue and are
// listed by getCompletedParcels instead (the orders page's collapsed
// Completed section). Digital-only orders appear in neither list,
// even if a physical status was somehow stamped on them, because
// they have no physical pack lines.
// Run with: bun tests/packing-completed.test.ts
import { Database } from "bun:sqlite";
import { getPackingQueue, getCompletedParcels } from "../src/lib/packing";
import { ensureClubCycleTables } from "../src/lib/club-cycles";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, cover_key TEXT, price REAL, price_print REAL, picture_book_key TEXT, coloring_book_key TEXT, audiobook_key TEXT, public_slug TEXT, status TEXT);
INSERT INTO books VALUES ('mira-the-heron-and-the-still-water', 'Mira the Heron and the Still Water', NULL, 899, 2000, 'p', 'c', 'a', 'mira-the-heron-and-the-still-water', 'complete');
CREATE TABLE club_signups (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, shelf TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL);
INSERT INTO club_signups VALUES ('m1', 'Member One', 'm1@example.com', 'tech', 'paid', 100);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, book_slugs TEXT, items TEXT, amount INTEGER, currency TEXT, status TEXT, created_at INTEGER, physical_status TEXT, pack_json TEXT);
INSERT INTO orders VALUES ('ordwait1', 'u1', 'a@x.com', '["mira-the-heron-and-the-still-water"]', '[{"slug":"mira-the-heron-and-the-still-water","format":"printed"}]', 2000, 'usd', 'complete', 1000, 'preorder_received', NULL);
INSERT INTO orders VALUES ('ordship1', 'u1', 'a@x.com', '["mira-the-heron-and-the-still-water"]', '[{"slug":"mira-the-heron-and-the-still-water","format":"printed"}]', 2000, 'usd', 'complete', 2000, 'shipped', NULL);
INSERT INTO orders VALUES ('orddeliv1', 'u1', 'a@x.com', '["mira-the-heron-and-the-still-water"]', '[{"slug":"mira-the-heron-and-the-still-water","format":"giftset"}]', 2500, 'usd', 'complete', 3000, 'delivered', NULL);
INSERT INTO orders VALUES ('orddigital1', 'u1', 'a@x.com', '["mira-the-heron-and-the-still-water"]', '[{"slug":"mira-the-heron-and-the-still-water","format":"digital"}]', 899, 'usd', 'complete', 4000, NULL, NULL);
INSERT INTO orders VALUES ('orddigitalshipped', 'u1', 'a@x.com', '["mira-the-heron-and-the-still-water"]', '[{"slug":"mira-the-heron-and-the-still-water","format":"digital"}]', 899, 'usd', 'complete', 5000, 'shipped', NULL);
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

await ensureClubCycleTables(db);
raw.exec(`
INSERT INTO club_cycle_boxes (id, signup_id, ship_date, selected_book_slug, resolved_book_slug, second_selected_book_slug, second_resolved_book_slug, status, shipped_at, delivered_at, created_at, updated_at)
VALUES
  ('boxwait', 'm1', '2020-01-01', 'mira-the-heron-and-the-still-water', 'mira-the-heron-and-the-still-water', NULL, NULL, 'locked', NULL, NULL, 100, 100),
  ('boxship', 'm1', '2026-10-01', 'mira-the-heron-and-the-still-water', 'mira-the-heron-and-the-still-water', NULL, NULL, 'shipped', 6000, NULL, 100, 100),
  ('boxdeliv', 'm1', '2026-09-01', 'mira-the-heron-and-the-still-water', 'mira-the-heron-and-the-still-water', NULL, NULL, 'delivered', 5000, 7000, 100, 100);
`);

{
  const queue = await getPackingQueue(db);
  const ids = queue.map((q) => q.id).sort();
  assert(ids.join(",") === "boxwait,ordwait1",
    "queue: only the waiting order and the waiting box are on the shelf");

  const done = await getCompletedParcels(db);
  const doneIds = done.map((d) => d.id);
  assert(doneIds.includes("ordship1") && doneIds.includes("orddeliv1"),
    "completed: the shipped and delivered orders are listed");
  assert(doneIds.includes("boxship") && doneIds.includes("boxdeliv"),
    "completed: the shipped and delivered club boxes are listed");
  assert(!doneIds.includes("orddigital1") && !doneIds.includes("orddigitalshipped") && !doneIds.includes("ordwait1"),
    "completed: digital-only and still-waiting orders are not listed");
  const ship = done.find((d) => d.id === "ordship1");
  const deliv = done.find((d) => d.id === "orddeliv1");
  assert(ship?.stage === "Shipped" && ship?.href === "/admin/orders/ordship1" && ship?.kind === "order",
    "completed: a shipped order carries its stage, kind, and fulfillment link");
  assert(deliv?.stage === "Delivered" && deliv?.lines === 2,
    "completed: the delivered gift set counts its two pack lines");
  assert(doneIds.join(",") === "boxdeliv,boxship,orddeliv1,ordship1",
    "completed: newest first across orders and boxes (delivered_at / shipped_at / created_at)");
}

if (failures) { console.error(failures + " packing-completed test(s) failed"); process.exit(1); }
console.log("All packing-completed tests passed.");
