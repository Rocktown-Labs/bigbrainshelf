// Focused idempotency test for the checkout/delivery pipeline.
// Runs the real src/lib code against an in-memory bun:sqlite database
// using the production schema. Run with: bun tests/idempotency.test.ts
import { Database } from "bun:sqlite";
import {
  getOrCreatePendingOrder,
  attachStripeSession,
  recordWebhookEvent,
  markWebhookEventProcessed,
  processCheckoutCompleted,
  expireOrderBySession,
  setPhysicalStatus,
} from "../src/lib/orders";
import { flushOutbox } from "../src/lib/email";
import {
  enqueueClubFollowup,
  getOrCreateUnsubscribeToken,
  recordOptOutByToken,
  isOptedOut,
} from "../src/lib/marketing";

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
INSERT INTO books VALUES ('mastery', 'Mira the Heron and the Still Water', 'books/mastery/picture-book.pdf', 'books/mastery/coloring-book.pdf', 'books/mastery/book.epub', NULL, NULL);
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

// --- Checkout idempotency: same user + same cart reuses one pending order
const cart = [
  { slug: "mastery", format: "digital" },
  { slug: "mastery", format: "printed" },
];
const p1 = await getOrCreatePendingOrder(db, { userId: "user1", email: "buyer@example.com", items: cart, amount: 4699 });
const p2 = await getOrCreatePendingOrder(db, { userId: "user1", email: "buyer@example.com", items: cart, amount: 4699 });
assert(p1.id === p2.id, "double checkout reuses the same pending order");
assert(count("SELECT COUNT(*) n FROM orders WHERE status='pending'") === 1, "exactly one pending order row");
assert(p1.delivery_token && p1.delivery_token.length >= 32, "pending order carries a delivery token");

// --- Webhook event dedupe
const evt = { id: "evt_test_1", type: "checkout.session.completed" };
assert((await recordWebhookEvent(db, evt)) === "new", "first event sighting is new");

// --- Completion: order converges, one confirmation email with links
await attachStripeSession(db, p1.id, "cs_test_123");
const session = {
  id: "cs_test_123",
  amount_total: 4699,
  currency: "usd",
  customer_email: "buyer@example.com",
  metadata: { user_id: "user1", order_id: p1.id, items: JSON.stringify(cart), slugs: "mastery" },
};
const order = await processCheckoutCompleted(db, SITE, session);
assert(order.status === "complete", "order completed");
assert(order.physical_status === "preorder_received", "printed order starts at preorder_received");
assert(count("SELECT COUNT(*) n FROM orders WHERE stripe_session_id='cs_test_123'") === 1, "one order per stripe session");

const outbox1 = raw.query("SELECT * FROM email_outbox").all() as any[];
assert(outbox1.length === 1 && outbox1[0].kind === "order_confirmation", "exactly one confirmation email enqueued");
const body: string = outbox1[0].body_text;
assert(!body.includes("/api/order-download"), "confirmation carries NO bearer download links (CG, 2026-10-31: auth-backed only)");
assert(!body.includes(order.delivery_token), "the delivery token never appears in the email");
assert(body.includes("Your books are in your library"), "confirmation names the library as the home of the files");
assert(!body.includes("—") && !outbox1[0].subject.includes("—"), "no em dashes in confirmation copy");
assert(body.includes("/account"), "confirmation points at the library");

// --- Replay after a crash (event recorded, never marked processed):
// processing again must not duplicate the order or the email.
const order2 = await processCheckoutCompleted(db, SITE, session);
assert(order2.id === order.id, "replayed completion converges on the same order");
assert(count("SELECT COUNT(*) n FROM email_outbox") === 1, "replayed completion does not enqueue a second confirmation");

// --- Event marked processed: further replays are skipped entirely
await markWebhookEventProcessed(db, evt.id, "done");
assert((await recordWebhookEvent(db, evt)) === "duplicate", "processed event replay is a duplicate");

// --- Outbox flush without a Resend key: pending, never dropped
let summary = await flushOutbox(db, {});
assert(summary.skipped === 1, "flush without key skips and keeps the row");
let row = raw.query("SELECT * FROM email_outbox WHERE kind='order_confirmation'").get() as any;
assert(row.status === "pending", "row stays pending without a key");

// --- Outbox flush with a working provider: sent exactly once
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
summary = await flushOutbox(db, { RESEND_API_KEY: "re_test" });
assert(summary.sent === 1, "flush with key sends the pending email");
row = raw.query("SELECT * FROM email_outbox WHERE kind='order_confirmation'").get() as any;
assert(row.status === "sent" && row.sent_at > 0, "row marked sent with timestamp");
summary = await flushOutbox(db, { RESEND_API_KEY: "re_test" });
assert(summary.attempted === 0, "sent email is never sent twice");
(globalThis as any).fetch = realFetch;

// --- Physical status: exactly one update email per transition
let res = await setPhysicalStatus(db, SITE, order.id, "in_print");
assert(res.ok, "advance to in_print works");
assert(count("SELECT COUNT(*) n FROM email_outbox WHERE kind='physical_update_in_print'") === 1, "one in_print email enqueued");
res = await setPhysicalStatus(db, SITE, order.id, "in_print");
assert(res.ok && count("SELECT COUNT(*) n FROM email_outbox WHERE kind='physical_update_in_print'") === 1, "re-setting the same status sends nothing new");
res = await setPhysicalStatus(db, SITE, order.id, "preorder_received");
assert(!res.ok, "moving backwards is refused");
const upd = raw.query("SELECT * FROM email_outbox WHERE kind='physical_update_in_print'").get() as any;
assert(!upd.body_text.includes("—") && !upd.subject.includes("—"), "no em dashes in physical update copy");

// --- Digital-only order with no pending row (session created elsewhere)
const digitalSession = {
  id: "cs_test_999",
  amount_total: 699,
  currency: "usd",
  customer_email: "reader@example.com",
  metadata: { user_id: "user2", items: JSON.stringify([{ slug: "mastery", format: "digital" }]), slugs: "mastery" },
};
const dOrder = await processCheckoutCompleted(db, SITE, digitalSession);
assert(dOrder && dOrder.physical_status === null, "digital-only order has no physical status");
assert(count("SELECT COUNT(*) n FROM email_outbox WHERE order_id=? AND kind='order_confirmation'", dOrder.id) === 1, "digital order gets its one confirmation");

// --- Expired session frees the cart fingerprint for a fresh attempt
const p3 = await getOrCreatePendingOrder(db, { userId: "user3", email: "c@example.com", items: [{ slug: "mastery", format: "digital" }], amount: 699 });
await attachStripeSession(db, p3.id, "cs_test_exp");
await expireOrderBySession(db, "cs_test_exp");
const p4 = await getOrCreatePendingOrder(db, { userId: "user3", email: "c@example.com", items: [{ slug: "mastery", format: "digital" }], amount: 699 });
assert(p4.id !== p3.id, "expired checkout frees the cart for a new pending order");

// --- Club funnel (Workstream 3): confirmation block, day-3 follow-up,
// unsubscribe. processCheckoutCompleted does not enqueue the follow-up
// itself (the webhook does); these call the same helper the webhook uses.
const confBody = (raw.query("SELECT body_text FROM email_outbox WHERE kind='order_confirmation' AND order_id=?").get(order.id) as any).body_text as string;
assert(confBody.includes("About the Book Club:"), "confirmation pitches the club to a non-member");
assert(confBody.includes("$60.00 every 3 months"), "club block price comes from the club constant");
assert(confBody.includes("first box ships within a few days of joining"), "club block names the first box ship window (processing time included)");
assert(!confBody.includes("January 1"), "club block carries no launch-date ship framing");
assert(confBody.includes("/clubs"), "club block links to /clubs");

await enqueueClubFollowup(db, SITE, dOrder);
const fuRows = raw.query("SELECT * FROM email_outbox WHERE kind='club_followup'").all() as any[];
assert(fuRows.length === 1, "one follow-up enqueued for the purchase");
assert(fuRows[0].from_email === "news@bigbrainshelf.com", "follow-up sends from news@");
assert(fuRows[0].send_after - fuRows[0].created_at === 259200, "follow-up is delayed 3 days");
assert(fuRows[0].body_text.includes("/api/unsubscribe?token="), "follow-up carries an unsubscribe link");
assert(!fuRows[0].body_text.includes("—") && !fuRows[0].subject.includes("—"), "no em dashes in follow-up copy");
await enqueueClubFollowup(db, SITE, dOrder);
assert(count("SELECT COUNT(*) n FROM email_outbox WHERE kind='club_followup'") === 1, "follow-up enqueue is idempotent per order");

// Not due yet: a flush sends other due mail but leaves the follow-up.
let captured: any[] = [];
(globalThis as any).fetch = async (_url: any, opts: any) => {
  captured.push(JSON.parse(opts.body));
  return new Response(JSON.stringify({ id: "em_x" }), { status: 200 });
};
await flushOutbox(db, { RESEND_API_KEY: "re_test" }, 50);
let fuRow = raw.query("SELECT * FROM email_outbox WHERE kind='club_followup'").get() as any;
assert(fuRow.status === "pending", "follow-up is not sent before its send_after");
assert(!captured.some((b) => b.subject === fuRow.subject), "no follow-up in the early flush");

// Opt out after enqueue: the due flush suppresses instead of sending.
const token = await getOrCreateUnsubscribeToken(db, "reader@example.com");
assert((await recordOptOutByToken(db, token)) === "reader@example.com", "unsubscribe token resolves to the email");
assert(await isOptedOut(db, "reader@example.com"), "opt-out is recorded");
raw.exec("UPDATE email_outbox SET send_after = 1 WHERE kind='club_followup'");
captured = [];
await flushOutbox(db, { RESEND_API_KEY: "re_test" }, 50);
fuRow = raw.query("SELECT * FROM email_outbox WHERE kind='club_followup'").get() as any;
assert(fuRow.status === "suppressed", "opted-out follow-up is suppressed at send time");
assert(!captured.some((b) => b.subject === fuRow.subject), "suppressed follow-up is never sent");

// An opted-out buyer gets no follow-up for later orders either.
const lateSession = {
  id: "cs_test_777",
  amount_total: 699,
  currency: "usd",
  customer_email: "reader@example.com",
  metadata: { user_id: "user2", items: JSON.stringify([{ slug: "mastery", format: "digital" }]), slugs: "mastery" },
};
const lateOrder = await processCheckoutCompleted(db, SITE, lateSession);
await enqueueClubFollowup(db, SITE, lateOrder);
assert(count("SELECT COUNT(*) n FROM email_outbox WHERE kind='club_followup'") === 1, "opted-out buyer gets no new follow-up");

// Paid members: no club block in the confirmation, no follow-up.
raw.exec("INSERT INTO club_signups (id, name, email, shelf, status, created_at) VALUES ('m1', 'Member', 'member@example.com', 'tech', 'paid', 1)");
const memberSession = {
  id: "cs_test_555",
  amount_total: 699,
  currency: "usd",
  customer_email: "member@example.com",
  metadata: { user_id: "user9", items: JSON.stringify([{ slug: "mastery", format: "digital" }]), slugs: "mastery" },
};
const mOrder = await processCheckoutCompleted(db, SITE, memberSession);
const mConf = (raw.query("SELECT body_text FROM email_outbox WHERE kind='order_confirmation' AND order_id=?").get(mOrder.id) as any).body_text as string;
assert(!mConf.includes("About the Book Club:"), "paid member confirmation skips the club block");
await enqueueClubFollowup(db, SITE, mOrder);
assert(count("SELECT COUNT(*) n FROM email_outbox WHERE kind='club_followup' AND order_id=?", mOrder.id) === 0, "paid member gets no follow-up");

// A fresh buyer, due and not opted out: the follow-up sends from news@.
const fanSession = {
  id: "cs_test_888",
  amount_total: 699,
  currency: "usd",
  customer_email: "fan@example.com",
  metadata: { user_id: "user10", items: JSON.stringify([{ slug: "mastery", format: "digital" }]), slugs: "mastery" },
};
const fanOrder = await processCheckoutCompleted(db, SITE, fanSession);
await enqueueClubFollowup(db, SITE, fanOrder);
raw.exec("UPDATE email_outbox SET send_after = 1 WHERE kind='club_followup' AND order_id='" + fanOrder.id + "'");
captured = [];
await flushOutbox(db, { RESEND_API_KEY: "re_test" }, 50);
const fanFu = raw.query("SELECT * FROM email_outbox WHERE kind='club_followup' AND order_id=?").get(fanOrder.id) as any;
assert(fanFu.status === "sent", "due follow-up sends on a later flush");
const fanSend = captured.find((b) => b.subject === fanFu.subject);
assert(!!fanSend && String(fanSend.from).includes("news@bigbrainshelf.com"), "follow-up is sent from the news@ identity");
(globalThis as any).fetch = realFetch;

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
