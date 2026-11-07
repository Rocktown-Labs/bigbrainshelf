// Stored checkout shipping quotes (fix, 2026-10-31): the pay call
// must charge the exact quote the buyer confirmed in the preview,
// never a fresh re-quote that picked a different cheapest rate.
// Run with: bun tests/shipping-quotes.test.ts
import { Database } from "bun:sqlite";
import {
  shippingQuoteFingerprint,
  shippingQuoteFresh,
  storeShippingQuote,
  loadShippingQuote,
  storeOrderShippingQuoteDetail,
  SHIPPING_QUOTE_TTL_SECONDS,
} from "../src/lib/shipping-quotes";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
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

const base = {
  buyerKey: "user-1",
  state: "AR",
  zip: "72202-5934",
  country: "US",
  items: [{ slug: "mastery", format: "giftset", qty: 1 }],
};

// Fingerprints: formatting noise must not break the match; real
// changes must.
assert(shippingQuoteFingerprint(base) === shippingQuoteFingerprint({ ...base, zip: "72202" }), "ZIP+4 vs ZIP5 fingerprint matches");
assert(shippingQuoteFingerprint(base) === shippingQuoteFingerprint({ ...base, state: "ar" }), "state case does not change the fingerprint");
assert(shippingQuoteFingerprint(base) !== shippingQuoteFingerprint({ ...base, zip: "72543" }), "different ZIP changes the fingerprint");
assert(shippingQuoteFingerprint(base) !== shippingQuoteFingerprint({ ...base, buyerKey: "guest:xyz" }), "different buyer changes the fingerprint");
assert(
  shippingQuoteFingerprint(base) !== shippingQuoteFingerprint({ ...base, items: [{ slug: "mastery", format: "giftset", qty: 2 }] }),
  "quantity change changes the fingerprint"
);

// Freshness window.
const now = Math.floor(Date.now() / 1000);
assert(shippingQuoteFresh(now - 60, now), "one-minute-old quote is fresh");
assert(!shippingQuoteFresh(now - SHIPPING_QUOTE_TTL_SECONDS - 1, now), "quote past the TTL is stale");
assert(!shippingQuoteFresh(0, now), "zero timestamp is never fresh");

// Roundtrip: store the preview quote, load it back verbatim.
const quote: any = {
  carrier: "UPS",
  service: "Ground Saver",
  amount: "6.28",
  amountCents: 628,
  currency: "usd",
  estimatedDays: 2,
  shipmentId: "shp_123",
  rateId: "rate_123",
  validatedAddress: { line1: "2310 W 18th St", city: "Little Rock", state: "AR", postal_code: "72202-5934", country: "US" },
};
const fp = shippingQuoteFingerprint(base);
const id = await storeShippingQuote(db, quote, fp);
assert(typeof id === "string" && id.length > 10, "store returns a quote id");
const loaded: any = await loadShippingQuote(db, id, fp);
assert(loaded && loaded.amountCents === 628 && loaded.carrier === "UPS" && loaded.service === "Ground Saver", "loaded quote matches the preview exactly");
assert(loaded && loaded.rateId === "rate_123" && loaded.shipmentId === "shp_123", "Shippo ids survive the roundtrip");
assert(loaded && loaded.validatedAddress?.postal_code === "72202-5934", "validated address survives the roundtrip");
assert((await loadShippingQuote(db, id, shippingQuoteFingerprint({ ...base, zip: "72543" }))) === null, "fingerprint mismatch refuses the reuse");
assert((await loadShippingQuote(db, "no-such-id", fp)) === null, "unknown id loads nothing");
assert((await loadShippingQuote(db, "", fp)) === null, "empty id loads nothing");

// Provider namespacing (Lulu slice 2): a Lulu quote keys on its
// provider and the full normalized address, so it can never collide
// with a Shippo quote for the same buyer, cart and ZIP, and a change
// of street or phone re-keys it. The no-provider form is the legacy
// Shippo fingerprint and stays identical to itself across calls.
const addrA = "Test Buyer|100 W Race Ave||Searcy|AR|72143|US|+1 501 555 0100";
const addrB = "Test Buyer|200 W Race Ave||Searcy|AR|72143|US|+1 501 555 0100";
const addrC = "Test Buyer|100 W Race Ave||Searcy|AR|72143|US|+1 501 555 0199";
const luluBase = { ...base, provider: "lulu", addressKey: addrA };
assert(shippingQuoteFingerprint(luluBase) !== fp, "lulu fingerprint differs from the shippo fingerprint for the same cart");
assert(shippingQuoteFingerprint(luluBase) === shippingQuoteFingerprint({ ...luluBase }), "lulu fingerprint is stable");
assert(shippingQuoteFingerprint(luluBase) !== shippingQuoteFingerprint({ ...luluBase, addressKey: addrB }), "lulu fingerprint changes with the street address");
assert(shippingQuoteFingerprint(luluBase) !== shippingQuoteFingerprint({ ...luluBase, addressKey: addrC }), "lulu fingerprint changes with the phone");
assert(shippingQuoteFingerprint(base) !== shippingQuoteFingerprint({ ...base, provider: "lulu" }), "naming a provider alone re-keys the fingerprint");

// A stored Lulu quote round-trips its breakdown, and a Shippo
// fingerprint can never load it (nor the reverse).
const luluQuote: any = {
  carrier: "Lulu",
  service: "MAIL",
  amount: "8.28",
  amountCents: 828,
  currency: "usd",
  estimatedDays: null,
  shipmentId: "",
  rateId: "",
  validatedAddress: null,
};
const luluDetail = {
  provider: "lulu",
  level: "MAIL",
  currency: "USD",
  shippingExclTaxCents: 569,
  shippingTaxCents: 59,
  shippingInclTaxCents: 628,
  fulfillmentFeeCents: 200,
  chargeCents: 828,
};
const luluFp = shippingQuoteFingerprint(luluBase);
const luluId = await storeShippingQuote(db, luluQuote, luluFp, luluDetail);
const loadedLulu: any = await loadShippingQuote(db, luluId, luluFp);
assert(loadedLulu && loadedLulu.amountCents === 828 && loadedLulu.carrier === "Lulu", "stored lulu quote loads under its own fingerprint");
assert(loadedLulu?.quoteDetail?.shippingInclTaxCents === 628 && loadedLulu?.quoteDetail?.fulfillmentFeeCents === 200, "lulu breakdown survives the roundtrip");
assert((await loadShippingQuote(db, luluId, fp)) === null, "a shippo fingerprint can never load a lulu quote");
assert((await loadShippingQuote(db, id, luluFp)) === null, "a lulu fingerprint can never load a shippo quote");

// The breakdown lands on the (pending) order row as one JSON column.
raw.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', shipping_quote_detail TEXT)");
raw.query("INSERT INTO orders (id, status) VALUES ('ord-1', 'pending'), ('ord-2', 'complete')").run();
await storeOrderShippingQuoteDetail(db, "ord-1", { ...luluDetail, total_cents: 900, fingerprint: luluFp });
const ord1: any = raw.query("SELECT shipping_quote_detail FROM orders WHERE id = 'ord-1'").get();
const parsedDetail = JSON.parse(ord1.shipping_quote_detail);
assert(parsedDetail.provider === "lulu" && parsedDetail.total_cents === 900 && parsedDetail.fingerprint === luluFp, "order carries the quote breakdown (provider, total, fingerprint)");
await storeOrderShippingQuoteDetail(db, "ord-2", { provider: "lulu" });
const ord2: any = raw.query("SELECT shipping_quote_detail FROM orders WHERE id = 'ord-2'").get();
assert(ord2.shipping_quote_detail === null, "a completed order's breakdown is never rewritten");

if (failures) { console.error(failures + " FAILURES"); process.exit(1); }
console.log("ALL SHIPPING QUOTE TESTS PASSED");
