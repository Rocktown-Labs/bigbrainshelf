// Fulfillment tests (2026-10-29 operator pass): the packed stage in
// the physical flow, its exactly-once buyer email, the shipped email
// carrying the label's tracking when the operator marks shipped
// (buying a label no longer advances the stage), the Shippo tracking
// poll's DELIVERED mapping, and the source pins for the surfaces that
// consume the flow. Runs the real src/lib code against an in-memory
// bun:sqlite database. Run with: bun tests/fulfillment.test.ts
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { PHYSICAL_FLOW, setPhysicalStatus } from "../src/lib/orders";
import { pollShippedOrderTracking } from "../src/lib/club-scheduler";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// --- Flow shape ------------------------------------------------------
assert(
  JSON.stringify(PHYSICAL_FLOW) === JSON.stringify(["preorder_received", "in_print", "packed", "shipped", "delivered"]),
  "flow: received, in print, packed, shipped, delivered"
);

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, picture_book_key TEXT, coloring_book_key TEXT, epub_key TEXT, color_book_key TEXT, audiobook_key TEXT);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL, book_slugs TEXT NOT NULL, stripe_session_id TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'usd', status TEXT NOT NULL DEFAULT 'complete', created_at INTEGER NOT NULL, items TEXT DEFAULT '', delivery_token TEXT, cart_fingerprint TEXT, physical_status TEXT, ship_name TEXT, ship_address TEXT, shipping_cents INTEGER NOT NULL DEFAULT 0, carrier TEXT, carrier_service TEXT, tracking_number TEXT, label_url TEXT, shippo_shipment_id TEXT, shippo_transaction_id TEXT);
CREATE TABLE email_outbox (id TEXT PRIMARY KEY, order_id TEXT, kind TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, send_after INTEGER, from_email TEXT);
CREATE UNIQUE INDEX email_outbox_order_kind_idx ON email_outbox(order_id, kind) WHERE order_id IS NOT NULL;
INSERT INTO books VALUES ('mastery', 'Mira the Heron and the Still Water', 'books/mastery/picture-book.pdf', 'books/mastery/coloring-book.pdf', 'books/mastery/book.epub', NULL, NULL);
INSERT INTO orders (id, user_id, email, book_slugs, stripe_session_id, amount, status, created_at, items, physical_status)
VALUES ('ord-1', 'user1', 'buyer@example.com', '["mastery"]', 'cs_fulfill_1', 2000, 'complete', 1761600000, '[{"slug":"mastery","format":"printed"}]', 'preorder_received');
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
const count = (sql: string, ...args: any[]) => (raw.query(sql).get(...args) as any).n as number;
const orderRow = (id: string) => raw.query("SELECT * FROM orders WHERE id = ?").get(id) as any;

// --- Packed stage: transition + exactly-once email -------------------
let res = await setPhysicalStatus(db, SITE, "ord-1", "in_print");
assert(res.ok, "advance to in_print works");
res = await setPhysicalStatus(db, SITE, "ord-1", "packed");
assert(res.ok && orderRow("ord-1").physical_status === "packed", "advance to packed works");
assert(count("SELECT COUNT(*) n FROM email_outbox WHERE kind='physical_update_packed'") === 1, "exactly one packed email enqueued (dedupe key physical_update_packed)");
const packedMail = raw.query("SELECT * FROM email_outbox WHERE kind='physical_update_packed'").get() as any;
assert(packedMail.subject === "Your order is packed", "packed email subject names the stage");
assert(packedMail.body_text.includes("packed up and ready to go"), "packed email body says what happens next");
assert(!packedMail.body_text.includes("—") && !packedMail.subject.includes("—"), "no em dashes in packed email copy");
res = await setPhysicalStatus(db, SITE, "ord-1", "packed");
assert(res.ok && count("SELECT COUNT(*) n FROM email_outbox WHERE kind='physical_update_packed'") === 1, "re-marking packed enqueues nothing new");
res = await setPhysicalStatus(db, SITE, "ord-1", "in_print");
assert(!res.ok && orderRow("ord-1").physical_status === "packed", "moving backwards from packed is refused");

// --- Shipped email carries the stored label's tracking ---------------
// The decoupled flow: buy_label stores carrier + tracking and leaves
// the stage alone; the operator then marks shipped, and the email
// built at that moment must include the tracking.
raw.exec("UPDATE orders SET carrier = 'USPS', carrier_service = 'Priority Mail', tracking_number = '9400111899223856928499', label_url = 'https://labels.example/l.pdf' WHERE id = 'ord-1'");
res = await setPhysicalStatus(db, SITE, "ord-1", "shipped");
assert(res.ok, "mark shipped after packing works");
const shippedMail = raw.query("SELECT * FROM email_outbox WHERE kind='physical_update_shipped'").get() as any;
assert(shippedMail && shippedMail.body_text.includes("9400111899223856928499"), "shipped email includes the tracking number stored by the label purchase");
assert(shippedMail && shippedMail.body_text.includes("USPS"), "shipped email names the carrier");

// --- Tracking poll: DELIVERED advances, others only store text -------
const SHIPPO_ENV = {
  SHIPPO_API_KEY: "shippo_test_dummy",
  SHIPPO_FROM_NAME: "Big Brain Shelf",
  SHIPPO_FROM_STREET1: "100 Main St",
  SHIPPO_FROM_CITY: "Searcy",
  SHIPPO_FROM_STATE: "AR",
  SHIPPO_FROM_ZIP: "72143",
  SHIPPO_FROM_PHONE: "5015551234",
  SHIPPO_FROM_EMAIL: "orders@bigbrainshelf.com",
};
raw.exec(`
INSERT INTO orders (id, user_id, email, book_slugs, stripe_session_id, amount, status, created_at, items, physical_status, carrier, tracking_number)
VALUES ('ord-2', 'user2', 'two@example.com', '["mastery"]', 'cs_fulfill_2', 2000, 'complete', 1761600100, '[{"slug":"mastery","format":"printed"}]', 'shipped', 'UPS', '1Z999AA10123456784');
INSERT INTO orders (id, user_id, email, book_slugs, stripe_session_id, amount, status, created_at, items, physical_status, carrier, tracking_number)
VALUES ('ord-3', 'user3', 'three@example.com', '["mastery"]', 'cs_fulfill_3', 2000, 'complete', 1761600200, '[{"slug":"mastery","format":"printed"}]', 'shipped', 'USPS', 'BROKEN1');
INSERT INTO orders (id, user_id, email, book_slugs, stripe_session_id, amount, status, created_at, items, physical_status, carrier, tracking_number)
VALUES ('ord-4', 'user4', 'four@example.com', '["mastery"]', 'cs_fulfill_4', 2000, 'complete', 1761600300, '[{"slug":"mastery","format":"printed"}]', 'in_print', 'USPS', '9400999999999999999999');
`);

const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: string) => {
  const u = String(url);
  if (u.includes("/tracks/usps/9400111899223856928499")) {
    return new Response(JSON.stringify({ tracking_status: { status: "DELIVERED", status_details: "Delivered to the front door" } }), { status: 200 });
  }
  if (u.includes("/tracks/ups/1Z999AA10123456784")) {
    return new Response(JSON.stringify({ tracking_status: { status: "TRANSIT", status_details: "Out for delivery" } }), { status: 200 });
  }
  throw new Error("carrier API exploded");
};
const poll1 = await pollShippedOrderTracking(db, SHIPPO_ENV, SITE, 25);
assert(poll1.checked === 3 && poll1.delivered === 1 && poll1.errors === 1, "poll: checks shipped+tracked orders only, one delivered, one failure isolated");
assert(orderRow("ord-1").physical_status === "delivered", "poll: DELIVERED advances the order to delivered");
assert(orderRow("ord-1").tracking_status === "Delivered to the front door", "poll: carrier status text stored on the order");
assert(orderRow("ord-2").physical_status === "shipped" && orderRow("ord-2").tracking_status === "Out for delivery", "poll: TRANSIT stores text and leaves the stage alone");
assert(orderRow("ord-3").physical_status === "shipped", "poll: a failing lookup leaves its order untouched");
assert(count("SELECT COUNT(*) n FROM email_outbox WHERE kind='physical_update_delivered' AND order_id='ord-1'") === 1, "poll: exactly one delivered email enqueued");
const poll2 = await pollShippedOrderTracking(db, SHIPPO_ENV, SITE, 25);
assert(poll2.checked === 2 && count("SELECT COUNT(*) n FROM email_outbox WHERE kind='physical_update_delivered'") === 1, "poll: delivered orders leave the poll set, no second delivered email");
(globalThis as any).fetch = realFetch;

// --- Source pins: the surfaces that consume the flow ------------------
const ordersApi = read("../src/pages/api/admin/orders.ts");
assert(ordersApi.includes("physical_status IN ('preorder_received', 'in_print', 'packed')"), "api: packed counts as to-fulfill in stats and tabs");
const buyLabelBlock = ordersApi.slice(ordersApi.indexOf('action === "buy_label"'));
assert(!buyLabelBlock.includes("setPhysicalStatus("), "api: buy_label no longer advances the stage");
assert(ordersApi.includes("tracking_status FROM orders"), "api: order detail payload carries the carrier status text");

const dashLib = read("../src/lib/admin-dashboard.ts");
assert(dashLib.includes('["packed", "Packed"]'), "dashboard: fulfillment stepper includes Packed");
assert(dashLib.includes("physical_status IN ('preorder_received', 'in_print', 'packed')"), "dashboard: printed-waiting count includes packed");

const ordersPage = read("../src/pages/admin/orders.astro");
assert(ordersPage.includes("data-kebab") && ordersPage.includes('id="row-menu"'), "orders table: kebab button and shared menu exist");
assert(ordersPage.includes('"Copy order ID"') && ordersPage.includes('"Print label"') && ordersPage.includes('"#label"'), "orders table: menu carries View/Print label/Mark stages/Copy order ID");
assert(ordersPage.includes('packed: "Packed"'), "orders table: stage labels include Packed");

const detailPage = read("../src/pages/admin/orders/[id].astro");
assert(detailPage.includes('id="label"'), "detail: fulfillment card is the #label deep-link target");
assert(detailPage.includes("data-stage") && detailPage.includes("Mark ' + LABELS[s]"), "detail: forward-stage buttons render for every remaining stage");
assert(detailPage.includes("No 2-day rate for this address; using the cheapest USPS/UPS option"), "detail: quote UI surfaces the no-2-day fallback");
assert(detailPage.includes("Carrier status: "), "detail: carrier status text shows on the fulfillment card");
assert(detailPage.includes("repeat(5,1fr)"), "detail: stepper is five stages wide");

const shippoSrc = read("../src/lib/shippo.ts");
assert(shippoSrc.includes("chooseRate(rates)") && shippoSrc.includes("chooseRate(created.rates)"), "shippo: fulfillment quote and direct buy both use the 2-day rule");
assert(shippoSrc.includes("/tracks/"), "shippo: tracking lookup uses the Shippo tracks endpoint");

const checkoutApi = read("../src/pages/api/club/checkout.ts");
const signupApi = read("../src/pages/api/club-signup.ts");
assert(!checkoutApi.includes("Please pick a shelf") && !signupApi.includes("Please pick a shelf"), "club endpoints: a missing shelf no longer blocks joining");
const clubPage = read("../src/pages/clubs.astro");
assert(!clubPage.includes('picked(form, "shelf")'), "plans page: join and waitlist forms no longer read a shelf pick");

if (failures) { console.error(failures + " fulfillment test(s) failed"); process.exit(1); }
console.log("All fulfillment tests passed.");
