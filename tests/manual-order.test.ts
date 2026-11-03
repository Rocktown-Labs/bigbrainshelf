// Manual orders (admin redesign fix, 2026-11-03): an admin can
// create a real order by hand. It is a normal completed order row,
// marked in its data (source 'manual', a 'manual:' session marker,
// an internal note), priced by the per-line prices the admin entered
// (stored on the items, winning over catalog prices everywhere),
// landing on the packing shelf when it has physical lines and
// treated as fulfilled when it is digital-only. No Stripe objects,
// and zero emails are enqueued at creation.
// Run with: bun tests/manual-order.test.ts
import { Database } from "bun:sqlite";
import {
  createManualOrder,
  listManualOrderCatalog,
  orderItemLabels,
  pricedOrderLines,
} from "../src/lib/orders";
import { getPackingQueue } from "../src/lib/packing";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, cover_key TEXT, price REAL, price_print REAL, picture_book_key TEXT, coloring_book_key TEXT, audiobook_key TEXT, public_slug TEXT, status TEXT);
INSERT INTO books VALUES ('mira-the-heron-and-the-still-water', 'Mira the Heron and the Still Water', NULL, 899, 2000, 'p', 'c', 'a', 'mira-the-heron-and-the-still-water', 'complete');
INSERT INTO books VALUES ('algorithms', 'Fenix the Fox and the Clever Trails', NULL, 899, 2000, 'p', 'c', NULL, 'fenix-the-fox-and-the-clever-trails', 'ready_for_qa');
INSERT INTO books VALUES ('buildingbook', 'Unfinished Tales', NULL, 899, 2000, 'p', 'c', NULL, 'unfinished-tales', 'building');
CREATE TABLE club_signups (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, shelf TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, book_slugs TEXT, items TEXT, stripe_session_id TEXT, amount INTEGER, currency TEXT, status TEXT, delivery_token TEXT, created_at INTEGER, physical_status TEXT, ship_name TEXT, ship_address TEXT, shipping_cents INTEGER, pack_json TEXT);
CREATE TABLE email_outbox (id TEXT PRIMARY KEY, order_id TEXT, kind TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, send_after INTEGER, from_email TEXT);
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

const ADDRESS = { line1: "2310 W 18th St", city: "Little Rock", state: "AR", postal_code: "72202", country: "US" };

{
  // The form's catalog: sellable books only, by public slug, with
  // the store's default prices per format.
  const catalog = await listManualOrderCatalog(db);
  assert(catalog.length === 2 && !catalog.some((c) => c.slug === "unfinished-tales"),
    "catalog: only sellable books are offered");
  const mira = catalog.find((c) => c.slug === "mira-the-heron-and-the-still-water");
  assert(mira?.prices.digital === 899 && mira?.prices.printed === 2000 && mira?.prices.giftset === 2500 && mira?.prices.audio === 199,
    "catalog: default prices are the store prices from offers/catalog rules");
  const fenix = catalog.find((c) => c.slug === "fenix-the-fox-and-the-clever-trails");
  assert(!!fenix && fenix.prices.audio === null,
    "catalog: a book without an audiobook offers no audio line");

  // A physical manual order, picked by PUBLIC slug, with an edited
  // per-line price and a shipping amount.
  const made = await createManualOrder(db, {
    name: "Cameron Stewart",
    email: "buyer@example.com",
    address: ADDRESS,
    lines: [{ slug: "fenix-the-fox-and-the-clever-trails", format: "printed", qty: 2, priceCents: 1800 }],
    shippingCents: 500,
    note: "Replacement for a damaged copy.",
  });
  assert(made.ok, "create: a physical manual order is created");
  if (made.ok) {
    const o = made.order;
    assert(o.source === "manual" && String(o.stripe_session_id).startsWith("manual:") && o.admin_note === "Replacement for a damaged copy.",
      "create: the row is marked manual in its data, with the internal note");
    assert(o.status === "complete" && o.physical_status === "preorder_received",
      "create: physical manual orders start at the first fulfillment stage");
    assert(o.amount === 1800 * 2 + 500 && o.shipping_cents === 500,
      "create: the total is the entered lines plus the entered shipping");
    const storedItems = JSON.parse(o.items);
    assert(storedItems[0].slug === "algorithms" && storedItems[0].priceCents === 1800,
      "create: the line stores the INTERNAL slug and the entered price");

    const labels = await orderItemLabels(db, [o]);
    assert((labels.get(o.id) || [])[0] === "Fenix the Fox and the Clever Trails (full color printed book, digital files included) ×2",
      "labels: the manual order names its book like any other order, quantity included");

    const priced = pricedOrderLines(o, [
      { slug: "algorithms", title: "Fenix the Fox and the Clever Trails", price: 899, price_print: 2000 } as any,
    ]);
    assert(priced.length === 1 && priced[0].unitCents === 1800 && priced[0].lineTotalCents === 3600,
      "pricing: the entered per-line price wins over the catalog price");

    const queue = await getPackingQueue(db);
    assert(queue.some((q) => q.kind === "order" && q.id === o.id),
      "shelf: the physical manual order lands on the packing shelf");
  }
  const outboxRows = (raw.query("SELECT COUNT(*) n FROM email_outbox").get() as any).n;
  assert(outboxRows === 0, "emails: creating a manual order enqueues no email");

  // A digital-only comp: fulfilled on creation, off the shelf.
  const comp = await createManualOrder(db, {
    email: "reviewer@example.com",
    lines: [{ slug: "mira-the-heron-and-the-still-water", format: "digital", qty: 5, priceCents: 0 }],
  });
  assert(comp.ok && comp.order.physical_status === null && comp.order.amount === 0,
    "create: a digital-only manual order is fulfilled, with no physical stage");
  if (comp.ok) {
    const stored = JSON.parse(comp.order.items);
    assert(stored[0].qty === 1, "create: single-copy formats clamp to one copy, like checkout");
    const queue = await getPackingQueue(db);
    assert(!queue.some((q) => q.id === comp.order.id),
      "shelf: the digital-only manual order stays off the packing shelf");
  }

  // Validation: plain refusals, no partial rows.
  const noEmail = await createManualOrder(db, { email: "", lines: [{ slug: "mira-the-heron-and-the-still-water", format: "digital", qty: 1, priceCents: 0 }] });
  assert(!noEmail.ok, "validate: an email is required");
  const noLines = await createManualOrder(db, { email: "a@x.com", lines: [] });
  assert(!noLines.ok, "validate: at least one line is required");
  const noAddress = await createManualOrder(db, {
    email: "a@x.com",
    lines: [{ slug: "mira-the-heron-and-the-still-water", format: "printed", qty: 1, priceCents: 2000 }],
  });
  assert(!noAddress.ok, "validate: printed lines require a shipping address");
  const badSlug = await createManualOrder(db, {
    email: "a@x.com",
    lines: [{ slug: "not-a-book", format: "digital", qty: 1, priceCents: 0 }],
  });
  assert(!badSlug.ok, "validate: an unknown book is refused");
  const orderCount = (raw.query("SELECT COUNT(*) n FROM orders").get() as any).n;
  assert(orderCount === 2, "validate: refused creations wrote no order rows");
}

if (failures) { console.error(failures + " manual-order test(s) failed"); process.exit(1); }
console.log("All manual-order tests passed.");
