// Pass-through shipping tests (CG, 2026-10-28: the customer pays the
// real carrier rate). Covers: destination normalization, checkout
// quoting via the shared pickRate rule (stubbed Shippo), the one-retry
// fallback, client-amount tamper resistance, storing the quote on the
// pending order, webhook completion keeping the quoted numbers (the
// receipt invariant: item lines + shipping_cents == amount), the
// digital path staying shipping-free, fulfillment preferring the
// stored checkout rate, and the confirmation email carrying the same
// shipping + total as the receipt. Run: bun tests/checkout-shipping.test.ts
import { Database } from "bun:sqlite";
import {
  normalizeShipDestination,
  quoteShipping,
  quoteShippingWithRetry,
  storeCheckoutQuote,
  getLabelQuote,
  missingAddressFields,
  isAddressInvalidError,
} from "../src/lib/shippo";
import {
  getOrCreatePendingOrder,
  attachStripeSession,
  completeOrder,
  buildConfirmationEmailModel,
  buildConfirmationEmail,
} from "../src/lib/orders";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const ENV = {
  SHIPPO_API_KEY: "shippo_test_x",
  SHIPPO_FROM_NAME: "Big Brain Shelf",
  SHIPPO_FROM_STREET1: "100 Main St",
  SHIPPO_FROM_CITY: "Searcy",
  SHIPPO_FROM_STATE: "AR",
  SHIPPO_FROM_ZIP: "72143",
  SHIPPO_FROM_PHONE: "5015551234",
  SHIPPO_FROM_EMAIL: "orders@bigbrainshelf.com",
};

// --- Shippo stub -----------------------------------------------------------
// Rates fixture: the pickRate tests' shape. Cheapest USPS/UPS timely
// rate is USPS 8.50; the cheaper FedEx rate must be ignored.
const RATES = [
  { object_id: "rate_ups", provider: "UPS", servicelevel: { name: "Ground", token: "ups_ground" }, amount: "12.00", currency: "USD", estimated_days: 3 },
  { object_id: "rate_usps", provider: "USPS", servicelevel: { name: "Ground Advantage", token: "usps_ga" }, amount: "8.50", currency: "USD", estimated_days: 4 },
  { object_id: "rate_fedex", provider: "FedEx", servicelevel: { name: "Ground", token: "fedex" }, amount: "5.00", currency: "USD", estimated_days: 2 },
];
let fetchCalls: { method: string; url: string }[] = [];
let failNextPosts = 0;
let storedShipmentRates: any[] | null = null; // when set, GET shipment returns these
let shipAddressTo: any = null; // when set, POST shipment carries this address_to (the full created Address object, as Shippo returns it)

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = String(url);
  const method = String(init.method || "GET");
  fetchCalls.push({ method, url: u });
  const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  if (u.endsWith("/shipments/") && method === "POST") {
    if (failNextPosts > 0) { failNextPosts -= 1; throw new Error("network down"); }
    return json({ object_id: "shp_fresh", rates: RATES, ...(shipAddressTo ? { address_to: shipAddressTo } : {}) });
  }
  if (u.includes("/shipments/") && method === "GET") {
    return json({ object_id: "shp_checkout", rates: storedShipmentRates ?? RATES });
  }
  throw new Error("unexpected fetch: " + method + " " + u);
}) as any;

// --- Destination normalization ---------------------------------------------
{
  const dest = normalizeShipDestination({
    name: " Pat Buyer ",
    street1: "1200 President Clinton Avenue",
    city: "Little Rock",
    state: "ar",
    zip: "72201",
    shipping_cents: 1, // tamper attempt: must be dropped, never read
    amount: 1,
  });
  assert(dest.address.line1 === "1200 President Clinton Avenue", "normalize: street1 alias maps to line1");
  assert(dest.address.postal_code === "72201", "normalize: zip alias maps to postal_code");
  assert(dest.address.state === "AR", "normalize: state uppercased");
  assert(dest.name === "Pat Buyer", "normalize: name trimmed");
  assert(!("shipping_cents" in dest) && !("amount" in dest) && !("shipping_cents" in dest.address), "normalize: client-sent amounts are dropped");
  assert(missingAddressFields(dest.address).length === 0, "normalize: a full address misses nothing");
  const partial = normalizeShipDestination({ line1: "1 A St" });
  assert(JSON.stringify(missingAddressFields(partial.address)) === JSON.stringify(["city", "state", "postal_code"]), "normalize: partial address names the missing fields");
}

const DEST = normalizeShipDestination({
  name: "Pat Buyer",
  email: "buyer@example.com",
  line1: "1200 President Clinton Avenue",
  city: "Little Rock",
  state: "AR",
  postal_code: "72201",
});
const PRINTED = [{ format: "printed" }];

// --- Checkout quote: pickRate reuse + tamper resistance ---------------------
{
  fetchCalls = [];
  const q = await quoteShipping(ENV, DEST, PRINTED);
  assert(q.amountCents === 850 && q.carrier === "USPS" && q.service === "Ground Advantage", "quote: cheapest qualifying USPS/UPS rate wins (pickRate reused, cheaper FedEx ignored)");
  assert(q.shipmentId === "shp_fresh" && q.rateId === "rate_usps", "quote: carries the Shippo shipment + rate ids fulfillment needs");
  const tampered = normalizeShipDestination({ ...DEST, address: { ...DEST.address }, shipping_cents: 1, amount_cents: 1 });
  const q2 = await quoteShipping(ENV, tampered, PRINTED);
  assert(q2.amountCents === 850, "quote: a client-sent amount in the payload changes nothing");
}

// --- Retry + fallback --------------------------------------------------------
{
  fetchCalls = []; failNextPosts = 1;
  const q = await quoteShippingWithRetry(ENV, DEST, PRINTED);
  assert(q.amountCents === 850, "retry: a transient Shippo failure is retried and the quote lands");
  assert(fetchCalls.filter((c) => c.method === "POST").length === 2, "retry: exactly two attempts were made");

  fetchCalls = []; failNextPosts = 10;
  let threw = false;
  try { await quoteShippingWithRetry(ENV, DEST, PRINTED); } catch { threw = true; }
  assert(threw, "fallback: with Shippo down the quote throws (checkout fails plainly, never guesses a fee)");
  assert(fetchCalls.filter((c) => c.method === "POST").length === 2, "fallback: gives up after the one retry");
  failNextPosts = 0;
}

// --- Address validation gate (CG, 2026-10-30) --------------------------------
// The quote asks Shippo to validate the destination; the verdict
// rides back on the shipment response itself, on the address_to
// Address object. Valid: quote flows and carries the standardized
// address. Invalid: the quote fails with Shippo's own explanation,
// marked buyer-fixable, and the retry wrapper never burns a second
// shipment on it. No verdict at all: never blocks.
{
  shipAddressTo = {
    object_id: "adr_dest",
    street1: "1200 PRESIDENT CLINTON AVE", street2: "", city: "LITTLE ROCK", state: "AR", zip: "72201", country: "US",
    validation_results: { is_valid: true, messages: [] },
  };
  const qv = await quoteShipping(ENV, DEST, PRINTED);
  assert(qv.amountCents === 850, "validation: a valid verdict lets the quote through");
  assert(qv.validatedAddress && qv.validatedAddress.line1 === "1200 PRESIDENT CLINTON AVE" && qv.validatedAddress.postal_code === "72201", "validation: the quote carries Shippo's standardized address");

  shipAddressTo = {
    object_id: "adr_dest",
    street1: "999 Nowhere St", street2: "", city: "Little Rock", state: "AR", zip: "72201", country: "US",
    validation_results: { is_valid: false, messages: [{ source: "USPS", code: "Address Not Found", type: "address_error", text: "The address as submitted could not be found." }] },
  };
  let invalidErr: any = null;
  try { await quoteShipping(ENV, DEST, PRINTED); } catch (e) { invalidErr = e; }
  assert(invalidErr && /could not be found/.test(invalidErr.message), "validation: an invalid verdict fails the quote with Shippo's explanation");
  assert(isAddressInvalidError(invalidErr), "validation: the failure is marked buyer-fixable (the route maps it to 400)");

  fetchCalls = [];
  let retryErr: any = null;
  try { await quoteShippingWithRetry(ENV, DEST, PRINTED); } catch (e) { retryErr = e; }
  assert(isAddressInvalidError(retryErr), "validation: the retry wrapper surfaces the invalid verdict");
  assert(fetchCalls.filter((c) => c.method === "POST").length === 1, "validation: an undeliverable address is never retried (no second shipment)");

  shipAddressTo = { object_id: "adr_dest", street1: "1200 President Clinton Avenue" }; // no validation_results at all
  const qn = await quoteShipping(ENV, DEST, PRINTED);
  assert(qn.amountCents === 850 && !qn.validatedAddress, "validation: a missing verdict never blocks a quote");
  shipAddressTo = null;
}

// --- Order storage + completion (receipt invariant) --------------------------
const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, picture_book_key TEXT, coloring_book_key TEXT, epub_key TEXT, color_book_key TEXT, audiobook_key TEXT);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL, book_slugs TEXT NOT NULL, stripe_session_id TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'usd', status TEXT NOT NULL DEFAULT 'complete', created_at INTEGER NOT NULL, items TEXT DEFAULT '', delivery_token TEXT, cart_fingerprint TEXT, physical_status TEXT, ship_name TEXT, ship_address TEXT, shipping_cents INTEGER NOT NULL DEFAULT 0, quoted_carrier TEXT, quoted_service TEXT, carrier TEXT, carrier_service TEXT, tracking_number TEXT, label_url TEXT, label_cost_cents INTEGER, shippo_shipment_id TEXT, shippo_transaction_id TEXT, shippo_rate_id TEXT);
CREATE UNIQUE INDEX orders_pending_fp_idx ON orders(user_id, cart_fingerprint) WHERE status = 'pending';
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

{
  const cart = [{ slug: "mastery", format: "printed" }];
  const itemsTotal = 2000;
  const quote = await quoteShipping(ENV, DEST, PRINTED);
  const order = await getOrCreatePendingOrder(db, { userId: "u1", email: "buyer@example.com", items: cart, amount: itemsTotal + quote.amountCents });
  await storeCheckoutQuote(db, order.id, { dest: DEST, quote, amount: itemsTotal + quote.amountCents });

  let row: any = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(order.id).first();
  assert(row.shipping_cents === 850, "store: pending order carries the quoted shipping charge");
  assert(row.quoted_carrier === "USPS" && row.quoted_service === "Ground Advantage", "store: quoted carrier + service recorded");
  assert(row.shippo_rate_id === "rate_usps" && row.shippo_shipment_id === "shp_fresh", "store: Shippo rate + shipment ids recorded for fulfillment");
  assert(JSON.parse(row.ship_address).postal_code === "72201" && row.ship_name === "Pat Buyer", "store: destination recorded on the order");
  assert(row.amount - row.shipping_cents === itemsTotal, "store: receipt invariant holds pre-payment (lines + shipping == total)");

  // Webhook completion: the session reports the same shipping via
  // shipping_cost; the stored destination must survive (no Stripe
  // shipping_details on the new flow), and quoted fields stay intact.
  await attachStripeSession(db, order.id, "cs_ship_1");
  const done = await completeOrder(db, {
    id: "cs_ship_1",
    amount_total: itemsTotal + 850,
    currency: "usd",
    customer_email: "buyer@example.com",
    metadata: { user_id: "u1", order_id: order.id, items: JSON.stringify(cart), slugs: "mastery", shipping_cents: "850", ship_name: DEST.name, ship_address: JSON.stringify(DEST.address) },
    shipping_cost: { amount_total: 850 },
  });
  assert(done.status === "complete" && done.shipping_cents === 850, "complete: shipping charge confirmed from the session");
  assert(JSON.parse(done.ship_address).line1 === "1200 President Clinton Avenue", "complete: the checkout destination survives completion");
  assert(done.quoted_carrier === "USPS" && done.amount - done.shipping_cents === itemsTotal, "complete: quote + receipt invariant intact after payment");

  // Confirmation email shows the same shipping + total as the receipt.
  const books = [{ slug: "mastery", title: "Mira the Heron and the Still Water", picture_book_key: "k", coloring_book_key: "k", audiobook_key: "a" }];
  const model = buildConfirmationEmailModel("https://bigbrainshelf.com", done, books as any);
  assert(model.shipping?.cents === 850 && model.shipping?.carrier === "USPS" && model.totalCents === 2850, "email model: shipping + total match the order");
  const text = buildConfirmationEmail("https://bigbrainshelf.com", done, books as any).text;
  assert(text.includes("Shipping (USPS Ground Advantage): $8.50"), "email text: names the quoted carrier + service and amount");
  assert(text.includes("Total charged: $28.50"), "email text: total matches the receipt total");

  // Fulfillment continuity: the stored checkout rate is the label quote.
  fetchCalls = []; storedShipmentRates = RATES;
  const labelQuote = await getLabelQuote(db, ENV, done);
  assert(labelQuote.stored === true && labelQuote.rateId === "rate_usps" && labelQuote.amountCents === 850, "fulfillment: label quote is the rate the buyer was charged");
  assert(fetchCalls.filter((c) => c.method === "POST").length === 0, "fulfillment: stored quote needs no fresh shipment");

  // If the stored rate has vanished from its shipment, a fresh quote
  // is taken instead (difference then surfaces on the admin order).
  storedShipmentRates = RATES.filter((r) => r.object_id !== "rate_usps");
  fetchCalls = [];
  const fresh = await getLabelQuote(db, ENV, done);
  assert(!fresh.stored && fresh.rateId === "rate_usps" && fetchCalls.some((c) => c.method === "POST"), "fulfillment: a vanished stored rate falls back to a fresh quote");
  storedShipmentRates = null;
}

// --- Digital path: no shipping anywhere --------------------------------------
{
  const cart = [{ slug: "mastery", format: "digital" }];
  const done = await completeOrder(db, {
    id: "cs_digital_1",
    amount_total: 899,
    currency: "usd",
    customer_email: "buyer@example.com",
    metadata: { user_id: "u1", items: JSON.stringify(cart), slugs: "mastery", shipping_cents: "0" },
  });
  assert(done.shipping_cents === 0 && !done.ship_address && !done.physical_status, "digital: no shipping charged, no address, no fulfillment status");
  const model = buildConfirmationEmailModel("https://bigbrainshelf.com", done, [{ slug: "mastery", title: "Mira" }] as any);
  assert(model.shipping === null, "digital: confirmation model carries no shipping line");
}

globalThis.fetch = realFetch;
if (failures) { console.error(failures + " checkout-shipping test(s) failed"); process.exit(1); }
console.log("All checkout-shipping tests passed.");
