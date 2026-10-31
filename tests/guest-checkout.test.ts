// Guest checkout tests (CG, 2026-10-28: "guest should be able to
// checkout, just not on subscriptions"). Covers:
//  - the pricing guardrail: with no ownership (the guest case) a
//    digital line prices at full with NO audio-upgrade credit; the
//    credit exists only when the entitlement layer says the account
//    owns the audiobook;
//  - guest order identity: a pending order keyed "guest:<id>" with
//    an empty email and a delivery token, deduped per guest;
//  - webhook completion for a guest: the order converges, Stripe's
//    collected email is copied onto the order, and the confirmation
//    email goes to that email carrying token download links (the
//    session-less delivery path);
//  - the emailed token download route carries no session check;
//  - source pins: /api/checkout no longer gates on a session, reads
//    entitlements only for signed-in buyers, sets customer_email
//    only for them, lands guests on the token order page, and still
//    reaches the Stripe-config 503 (never a 401) for anonymous
//    callers; the cart clients no longer bounce guests to login;
//  - subscriptions stay account-only (club checkout 401 pin).
// Run with: bun tests/guest-checkout.test.ts
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  checkoutItemPrice,
  getOrCreatePendingOrder,
  attachStripeSession,
  processCheckoutCompleted,
} from "../src/lib/orders";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// --- Pricing guardrail -------------------------------------------------------
const BOOK = { slug: "mastery", price: 899, price_print: 2000, picture_book_key: "p", coloring_book_key: "c", audiobook_key: "a" };
const guestPriced = checkoutItemPrice(BOOK, "digital", { digital: false, audio: false });
assert(guestPriced?.cents === 899 && !guestPriced?.upgrade, "pricing: no ownership (guest) pays the full digital price, no upgrade credit");
const ownerPriced = checkoutItemPrice(BOOK, "digital", { digital: false, audio: true });
assert(ownerPriced?.cents === 700 && ownerPriced?.upgrade === "audio-upgrade", "pricing: the audio credit exists only with account ownership");
assert(checkoutItemPrice(BOOK, "printed", { digital: false, audio: false })?.cents === 2000, "pricing: guest printed price is the list price");
assert(checkoutItemPrice(BOOK, "audio", { digital: false, audio: false })?.cents === 199, "pricing: guest audio-only price is the list price");

// --- Guest order lifecycle ---------------------------------------------------
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
const GUEST = "guest:11111111-2222-3333-4444-555555555555";
const cart = [{ slug: "mastery", format: "digital" }];

const g1 = await getOrCreatePendingOrder(db, { userId: GUEST, email: "", items: cart, amount: 899 });
assert(g1.user_id === GUEST && g1.email === "", "guest order: keyed to the guest id with no email yet");
assert(g1.delivery_token && g1.delivery_token.length >= 32, "guest order: carries the delivery token the success page and email links use");
const g2 = await getOrCreatePendingOrder(db, { userId: GUEST, email: "", items: cart, amount: 899 });
assert(g2.id === g1.id, "guest order: a double submit from the same guest reuses the pending order");
const other = await getOrCreatePendingOrder(db, { userId: "guest:99999999-8888-7777-6666-555555555555", email: "", items: cart, amount: 899 });
assert(other.id !== g1.id && other.delivery_token !== g1.delivery_token, "guest order: a different guest gets a different order and token");

// Completion: Stripe collected the email; the webhook copies it on.
await attachStripeSession(db, g1.id, "cs_guest_1");
const done = await processCheckoutCompleted(db, SITE, {
  id: "cs_guest_1",
  amount_total: 899,
  currency: "usd",
  customer_email: null,
  customer_details: { email: "guest-buyer@example.com" },
  metadata: { user_id: GUEST, order_id: g1.id, items: JSON.stringify(cart), slugs: "mastery", shipping_cents: "0" },
});
assert(done.status === "complete", "guest completion: the order completes without any account");
assert(done.email === "guest-buyer@example.com", "guest completion: Stripe's collected email lands on the order");
assert(done.user_id === GUEST, "guest completion: the order stays keyed to the guest, not an account");
const outbox = raw.query("SELECT to_email, body_text FROM email_outbox WHERE order_id = ? AND kind = 'order_confirmation'").get(g1.id) as any;
assert(outbox?.to_email === "guest-buyer@example.com", "guest completion: the confirmation email is addressed to the guest's email");
assert(outbox?.body_text?.includes(`/api/order-download?token=${g1.delivery_token}`), "guest completion: the confirmation carries the token download links");

// Guest physical order: fulfillment state + destination survive.
const pcart = [{ slug: "mastery", format: "printed" }];
const gp = await getOrCreatePendingOrder(db, { userId: GUEST, email: "", items: pcart, amount: 2850 });
await attachStripeSession(db, gp.id, "cs_guest_2");
const pdone = await processCheckoutCompleted(db, SITE, {
  id: "cs_guest_2",
  amount_total: 2850,
  currency: "usd",
  customer_details: { email: "guest-buyer@example.com" },
  metadata: {
    user_id: GUEST, order_id: gp.id, items: JSON.stringify(pcart), slugs: "mastery",
    shipping_cents: "850", ship_name: "Guest Buyer",
    ship_address: JSON.stringify({ line1: "1 Main St", city: "Searcy", state: "AR", postal_code: "72143", country: "US" }),
  },
  shipping_cost: { amount_total: 850 },
});
assert(pdone.physical_status === "preorder_received", "guest physical: completion starts the fulfillment pipeline");
assert(JSON.parse(pdone.ship_address).line1 === "1 Main St", "guest physical: the destination survives completion");

// --- The token download route is session-less by design ----------------------
const dl = read("../src/pages/api/order-download.ts");
assert(!dl.includes("getSession") && !dl.includes("getAuth") && !dl.includes("locals"), "order-download: no session anywhere; the delivery token is the only credential");
assert(dl.includes("delivery_token = ?") && dl.includes("status = 'complete'"), "order-download: token lookup only ever serves completed orders");

// --- Checkout route source pins ----------------------------------------------
const route = read("../src/pages/api/checkout.ts");
assert(!route.includes("Sign in to check out."), "checkout route: the old sign-in 401 is gone");
assert(route.includes("guest:") && route.includes("GUEST_ID_RE"), "checkout route: guest orders key to a sanitized guest id");
assert(route.includes("new Map") && route.includes("entitlements = user"), "checkout route: entitlements are read only when a session exists (guests get an empty map)");
assert(route.includes('if (user) sessionParams.customer_email'), "checkout route: customer_email is set only for signed-in buyers");
assert(route.includes("/order?token=") && route.includes("order.delivery_token"), "checkout route: guests land on the token order page after paying");
assert(route.includes("/account?checkout=success"), "checkout route: signed-in buyers still land in their account");
assert(route.indexOf("getOrCreatePendingOrder") < route.indexOf("STRIPE_SECRET_KEY"), "checkout route: the order builds before the Stripe config check, so anonymous callers reach the 503, never a 401");
assert(route.includes('status: 503') && route.includes("Checkout is not configured yet."), "checkout route: the unconfigured-Stripe boundary is the 503");
assert(route.includes("cover_key IS NOT NULL AND audiobook_key IS NOT NULL"), "checkout route: audio-published books (cover + audio, any status) resolve for purchase");
assert(route.includes("audio_only: true") && route.includes('if (b.audio_only && w.format !== "audio") continue;'), "checkout route: an audio-published row sells ONLY its audio format; digital/printed/giftset stay refused");

// --- Client pins: no page bounces a guest to login anymore --------------------
for (const p of [
  "../src/pages/checkout.astro",
  "../src/pages/index.astro",
  "../src/pages/about.astro",
  "../src/pages/books/[slug].astro",
  "../src/pages/clubs.astro",
]) {
  const src = read(p);
  assert(!src.includes('window.location.href = "/login?next=/cart"'), `client ${p}: the checkout login bounce is gone`);
}
// Checkout calls carry the guest id. The calls live in exactly one
// place now: the /checkout page, which runs the whole flow (the
// drawer's Checkout button only navigates there, and /cart retired
// into a redirect), so the pin follows the calls.
{
  const checkoutSrc = read("../src/pages/checkout.astro");
  assert(checkoutSrc.includes("bbsGuestId") && checkoutSrc.includes("guest_id"), "client checkout page: checkout calls carry the guest id");
  assert(checkoutSrc.includes('action: "quote"'), "client checkout page: the physical-cart shipping quote call lives on the checkout page");
  const sheetSrc = read("../src/components/CartSheet.astro");
  assert(sheetSrc.includes('window.location.href = "/checkout"'), "client cart sheet: its checkout button hands off to the /checkout page");
  for (const p of [
    "../src/pages/index.astro",
    "../src/pages/about.astro",
    "../src/pages/books/[slug].astro",
    "../src/pages/clubs.astro",
    "../src/pages/audiobooks.astro",
    "../src/pages/audiobooks/[slug].astro",
    "../src/pages/merch.astro",
    "../src/pages/meet-the-cast.astro",
    "../src/pages/meet-the-cast/[character].astro",
    "../src/pages/privacy.astro",
    "../src/pages/terms.astro",
    "../src/pages/order.astro",
    "../src/pages/checkout.astro",
  ]) {
    assert(read(p).includes("<CartSheet"), `client ${p}: ships the shared sheet whose checkout carries the guest id`);
  }
}
const checkoutPageSrc = read("../src/pages/checkout.astro");
assert(checkoutPageSrc.includes("No account needed. Your download links arrive by email after checkout."), "checkout page: guests are told delivery is by email, no sign-in promised or required");

// --- The guest order page ------------------------------------------------------
const orderPage = read("../src/pages/order.astro");
assert(orderPage.includes("delivery_token = ?"), "order page: the order is loaded by its delivery token");
assert(orderPage.includes("buildConfirmationEmailModel"), "order page: download links render from the same model as the confirmation email");
assert(orderPage.includes('http-equiv="refresh"'), "order page: a still-confirming payment refreshes itself");

// --- Subscriptions stay account-only -------------------------------------------
const clubCheckout = read("../src/pages/api/club/checkout.ts");
assert(clubCheckout.indexOf("auth.api.getSession") > -1 && clubCheckout.indexOf("auth.api.getSession") < clubCheckout.indexOf("if (!e.STRIPE_SECRET_KEY)"), "club checkout: the session check still runs before everything (anonymous stays 401)");

if (failures) { console.error(`\n${failures} FAILURES`); process.exit(1); }
console.log("\nAll guest checkout tests passed.");
