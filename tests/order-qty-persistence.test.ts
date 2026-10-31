// Quantity persistence tests (found live 2026-10-31 by the camstewart7
// edge probes): Stripe charged quantities correctly, but
// completeOrder rebuilt the order's items from session metadata
// keeping only slug/format/upgrade, so every qty>1 order was stored
// as qty 1. Receipts, the account page, pick lists and the
// confirmation email then under-reported the order (probe order
// 54F3CFF5: charged $44.08 for 2x digital + 1x printed, stored as
// 1x + 1x; its confirmation email listed one digital line, no x2,
// and no printed line at all because the model also collapsed items
// to one line per book wearing the first format found).
// Run with: bun tests/order-qty-persistence.test.ts
import { Database } from "bun:sqlite";
import {
  getOrCreatePendingOrder,
  attachStripeSession,
  processCheckoutCompleted,
  parseItems,
  itemQty,
} from "../src/lib/orders";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, picture_book_key TEXT, coloring_book_key TEXT, epub_key TEXT, color_book_key TEXT, audiobook_key TEXT);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL, book_slugs TEXT NOT NULL, stripe_session_id TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'usd', status TEXT NOT NULL DEFAULT 'complete', created_at INTEGER NOT NULL, items TEXT DEFAULT '', delivery_token TEXT, cart_fingerprint TEXT, physical_status TEXT, ship_name TEXT, ship_address TEXT, shipping_cents INTEGER NOT NULL DEFAULT 0, carrier TEXT, tracking_number TEXT, label_url TEXT, shippo_shipment_id TEXT, shippo_transaction_id TEXT);
CREATE UNIQUE INDEX orders_delivery_token_idx ON orders(delivery_token) WHERE delivery_token IS NOT NULL;
CREATE UNIQUE INDEX orders_pending_fp_idx ON orders(user_id, cart_fingerprint) WHERE status = 'pending';
CREATE TABLE webhook_events (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL, processed_at INTEGER, result TEXT);
CREATE TABLE email_outbox (id TEXT PRIMARY KEY, order_id TEXT, kind TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, send_after INTEGER, from_email TEXT);
CREATE UNIQUE INDEX email_outbox_order_kind_idx ON email_outbox(order_id, kind) WHERE order_id IS NOT NULL;
INSERT INTO books VALUES ('mastery', 'Mira the Heron and the Still Water', 'books/mastery/picture-book.pdf', 'books/mastery/coloring-book.pdf', 'books/mastery/book.epub', NULL, 'books/mastery/audiobook.m4b');
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
const SITE = "https://bigbrainshelf.com";
const USER = "user-qty-1";

// --- Mixed cart: 2x digital + 1x printed of the SAME book -------------------
const mixed = [
  { slug: "mastery", format: "digital", qty: 2 },
  { slug: "mastery", format: "printed", qty: 1 },
];
const p1 = await getOrCreatePendingOrder(db, { userId: USER, email: "buyer@example.com", items: mixed as any, amount: 4408 });
await attachStripeSession(db, p1.id, "cs_qty_1");
const done1 = await processCheckoutCompleted(db, SITE, {
  id: "cs_qty_1",
  amount_total: 4408,
  currency: "usd",
  customer_details: { email: "buyer@example.com" },
  metadata: {
    user_id: USER, order_id: p1.id, items: JSON.stringify(mixed), slugs: "mastery",
    shipping_cents: "610", ship_name: "Buyer",
    ship_address: JSON.stringify({ line1: "1 Main St", city: "Little Rock", state: "AR", postal_code: "72202", country: "US" }),
  },
  shipping_cost: { amount_total: 610 },
});
const stored1 = parseItems(done1);
assert(stored1.length === 2, "mixed order: both lines survive completion");
assert(itemQty(stored1.find((i: any) => i.format === "digital")) === 2, "mixed order: the digital line keeps qty 2 in the stored order");
assert(itemQty(stored1.find((i: any) => i.format === "printed")) === 1, "mixed order: the printed line keeps qty 1 in the stored order");

const conf1 = raw.query("SELECT body_text FROM email_outbox WHERE order_id = ? AND kind = 'order_confirmation'").get(p1.id) as any;
assert(conf1?.body_text?.includes("(digital) ×2"), "confirmation email: the digital line shows x2");
assert(conf1?.body_text?.includes("full color printed book"), "confirmation email: the printed line is listed, not collapsed into the digital line");
const owner1 = raw.query("SELECT body_text FROM email_outbox WHERE order_id = ? AND kind = 'owner_new_order'").get(p1.id) as any;
assert(owner1?.body_text?.includes("(Digital bundle) ×2 - $17.98"), "owner notice: the digital line shows x2 with the line total");
assert(owner1?.body_text?.includes("(Printed book) - $20.00"), "owner notice: the printed line is listed too");

// --- Single line, qty 3 printed ---------------------------------------------
const triple = [{ slug: "mastery", format: "printed", qty: 3 }];
const p2 = await getOrCreatePendingOrder(db, { userId: USER, email: "buyer@example.com", items: triple as any, amount: 6628 });
await attachStripeSession(db, p2.id, "cs_qty_2");
const done2 = await processCheckoutCompleted(db, SITE, {
  id: "cs_qty_2",
  amount_total: 6628,
  currency: "usd",
  customer_details: { email: "buyer@example.com" },
  metadata: {
    user_id: USER, order_id: p2.id, items: JSON.stringify(triple), slugs: "mastery",
    shipping_cents: "628", ship_name: "Buyer",
    ship_address: JSON.stringify({ line1: "1 Main St", city: "Little Rock", state: "AR", postal_code: "72202", country: "US" }),
  },
  shipping_cost: { amount_total: 628 },
});
const stored2 = parseItems(done2);
assert(stored2.length === 1 && itemQty(stored2[0]) === 3, "qty order: 3x printed is stored as one line with qty 3");
const conf2 = raw.query("SELECT body_text FROM email_outbox WHERE order_id = ? AND kind = 'order_confirmation'").get(p2.id) as any;
assert(conf2?.body_text?.includes("×3"), "confirmation email: the 3x printed line shows x3");

if (failures) { console.error(`\n${failures} FAILURES`); process.exit(1); }
console.log("\nALL PASS");
