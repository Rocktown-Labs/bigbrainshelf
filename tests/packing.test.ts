// Packing + pickup tests (admin redesign S4, 2026-11-03). Covers:
// pack line construction for store orders (gift set = two pieces,
// digital never packs) and club boxes (gift set + second book +
// stickers), the tick math incl. the reserved label key, the Shippo
// pickup eligibility matrix (docs checked 2026-11-03: USPS
// Priority-class and DHL Express only), pack-state parsing, the
// stale-slug book resolution behind order labels (an order recorded
// under a retired slug still names its book), and the packing queue
// mixing store orders and club boxes while excluding digital-only
// orders. Run: bun tests/packing.test.ts
import { Database } from "bun:sqlite";
import {
  packLinesForGroups,
  packLinesForBox,
  boxContentsComplete,
  packProgress,
  getPackingQueue,
  PACK_LABEL_KEY,
} from "../src/lib/packing";
import { pickupEligibleFor } from "../src/lib/shippo";
import { orderItemLabels, parsePackState, normalizePackState, type OrderItemGroup } from "../src/lib/orders";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures++; console.error("FAIL:", label); }
}

// --- Pack lines: store orders ---------------------------------------
function group(partial: Partial<OrderItemGroup>): OrderItemGroup {
  return {
    title: "Mira the Heron and the Still Water",
    name: "Mira",
    format: "printed",
    count: 1,
    code: "MTH-still-water",
    cover: null,
    href: null,
    unitCents: 2000,
    ...partial,
  };
}
{
  const lines = packLinesForGroups([
    group({ format: "printed", count: 2 }),
    group({ format: "giftset", title: "Wells the Whale and the Great Harbor", code: "WTW-great-harbor" }),
    group({ format: "digital" }),
    group({ format: "audio" }),
  ]);
  assert(lines.length === 3, "order lines: printed + gift set story + gift set coloring pack; digital and audio never do");
  assert(lines[0].key === "MTH-still-water|printed" && lines[0].qty === 2, "order lines: printed line carries its quantity, keyed by book code");
  assert(lines[1].key === "WTW-great-harbor|giftset:story" && lines[2].key === "WTW-great-harbor|giftset:coloring", "order lines: a gift set packs as two pieces");
  assert(lines[1].code === "WTW-great-harbor", "order lines: the book code rides the line");
}

// --- Pack lines: club boxes ------------------------------------------
const bookRow = (slug: string, title: string) => ({ slug, title, cover_key: null, public_slug: slug });
{
  const box: any = {
    resolved_book_slug: "algorithms",
    selected_book_slug: null,
    second_resolved_book_slug: "docker",
    second_selected_book_slug: null,
  };
  const books = new Map([
    ["algorithms", bookRow("algorithms", "Fenix the Fox and the Clever Trails")],
    ["docker", bookRow("docker", "Wells the Whale and the Great Harbor")],
  ]);
  assert(boxContentsComplete(box) === true, "box: both slots resolved means contents complete");
  assert(boxContentsComplete({ ...box, second_resolved_book_slug: null }) === false, "box: a missing second book means the pick step comes first");
  const lines = packLinesForBox(box, books);
  assert(lines.map((l) => l.key).join(",") === "slot1:story,slot1:coloring,slot2:story,extras:stickers", "box lines: gift set pair + second book + sticker sheet");
  assert(lines[0].code === "FTF-clever-trails" && lines[2].code === "WTW-great-harbor", "box lines: codes derive from the titles");
}

// --- Tick math ---------------------------------------------------------
{
  const lines = packLinesForGroups([group({ format: "printed" }), group({ format: "giftset", title: "Wells the Whale and the Great Harbor", code: "WTW-great-harbor" })]);
  const none = packProgress(lines, {});
  assert(none.total === 3 && none.done === 0 && !none.complete && !none.labelPrinted, "progress: nothing ticked");
  const partial = packProgress(lines, { [lines[0].key]: true, [PACK_LABEL_KEY]: true });
  assert(partial.done === 1 && !partial.complete && partial.labelPrinted, "progress: the label tick is tracked apart from the lines");
  const full = packProgress(lines, Object.fromEntries([...lines.map((l) => [l.key, true]), [PACK_LABEL_KEY, true]]));
  assert(full.complete && full.labelPrinted, "progress: every line + label means shippable");
}

// --- Pack state parsing -------------------------------------------------
{
  assert(parsePackState("not json").slot === undefined && Object.keys(parsePackState("[]")).length === 0, "pack state: junk reads as nothing ticked");
  assert(parsePackState('{"a":true,"b":false}').a === true && !("b" in parsePackState('{"a":true,"b":false}')), "pack state: only true ticks survive parsing");
  assert(normalizePackState({ a: 1, b: 0 })?.a === true && normalizePackState("x") === null, "pack state: normalize validates the payload shape");
}

// --- Pickup eligibility (Shippo /pickups coverage) -----------------------
{
  assert(pickupEligibleFor("USPS", "Priority Mail") === true, "pickup: USPS Priority Mail is eligible");
  assert(pickupEligibleFor("USPS", "Priority Mail Express") === true, "pickup: USPS Priority Mail Express is eligible");
  assert(pickupEligibleFor("USPS", "Ground Advantage") === false, "pickup: USPS Ground Advantage is NOT eligible");
  assert(pickupEligibleFor("UPS", "Ground Saver") === false, "pickup: UPS is never offered through Shippo");
  assert(pickupEligibleFor("FedEx", "Ground") === false, "pickup: FedEx is never offered through Shippo");
  assert(pickupEligibleFor("DHL Express", "Express Worldwide") === true, "pickup: DHL Express is eligible");
}

// --- Stale-slug resolution + the packing queue ---------------------------
const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, cover_key TEXT, price REAL, price_print REAL, picture_book_key TEXT, coloring_book_key TEXT, audiobook_key TEXT, public_slug TEXT);
INSERT INTO books VALUES ('mira-the-heron-and-the-still-water', 'Mira the Heron and the Still Water', NULL, 899, 2000, 'p', 'c', 'a', 'mira-the-heron-and-the-still-water');
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, book_slugs TEXT, items TEXT, amount INTEGER, currency TEXT, status TEXT, created_at INTEGER, physical_status TEXT, pack_json TEXT);
INSERT INTO orders VALUES ('ordprint1', 'u1', 'a@x.com', '["mastery"]', '[{"slug":"mastery","format":"printed"}]', 2700, 'usd', 'complete', 100, 'preorder_received', NULL);
INSERT INTO orders VALUES ('orddigital1', 'u1', 'a@x.com', '["mastery"]', '[{"slug":"mastery","format":"digital"}]', 899, 'usd', 'complete', 90, NULL, NULL);
`);
const db = {
  prepare(sql: string) {
    return {
      bind(...args: any[]) {
        const stmt = raw.query(sql);
        return {
          async run() { stmt.run(...args); return {}; },
          async first() { return stmt.get(...args) ?? null; },
          async all() { return { results: stmt.all(...args) }; },
        };
      },
    };
  },
} as any;

{
  // The retired slug "mastery" resolves through book_slug_aliases to
  // the book's real row, so the label names the book instead of the
  // neutral fallback (the generic-label bug CG flagged).
  raw.exec(`CREATE TABLE IF NOT EXISTS book_slug_aliases (alias TEXT PRIMARY KEY, slug TEXT NOT NULL, created_at INTEGER NOT NULL);
            INSERT INTO book_slug_aliases VALUES ('mastery', 'mira-the-heron-and-the-still-water', 1);`);
  const labels = await orderItemLabels(db, [{ id: "ordprint1", items: '[{"slug":"mastery","format":"printed"}]', book_slugs: '["mastery"]' }]);
  assert((labels.get("ordprint1") || [])[0] === "Mira the Heron and the Still Water (full color printed book, digital files included)", "labels: a retired slug still names its book");

  const queue = await getPackingQueue(db);
  const orderItems = queue.filter((q) => q.kind === "order");
  assert(orderItems.length === 1 && orderItems[0].id === "ordprint1", "queue: the printed order is on the shelf, the digital-only order is not");
  assert(orderItems[0].ref === "#ORDPRINT" && orderItems[0].lines === 1 && orderItems[0].href === "/admin/orders/ordprint1", "queue: order card carries ref, line count, and the fulfillment link");
}

if (failures) { console.error(failures + " packing test(s) failed"); process.exit(1); }
console.log("All packing tests passed.");
