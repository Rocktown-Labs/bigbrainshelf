// Lulu checkout quoting (slice 2): when the lane is on, a physical
// cart's shipping quote comes from Lulu's cost calculation, built
// from the printables registry, the buyer's exact address AND phone.
// Covers: per-format line items (printed, gift set as story +
// coloring in one calculation, quantities grouped), the charge math
// (shipping incl. tax + the $2 fulfilment fee, before the route's
// whole-dollar round-up), the phone riding the cost call, fail-closed
// null on a missing printable, and source pins that the checkout
// route and page wire the lane correctly (flag-gated, phone field,
// dedication names into the items payload).
// Run with: bun tests/lulu-checkout-quote.test.ts
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  quoteLuluShipping,
  resolveLuluQuoteLineItems,
  LULU_FULFILMENT_FEE_CENTS,
} from "../src/lib/print-fulfillment";
import { __clearLuluTokenCacheForTests } from "../src/lib/lulu";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log("  ok:", name); }
  else { failed++; console.error("  FAIL:", name, extra ?? ""); }
}

// In-memory DB with the D1 prepare/bind surface (the repo pattern).
const raw = new Database(":memory:");
function makeStmt(sql: string, params: any[]) {
  const stmt = raw.query(sql);
  return {
    bind: (...next: any[]) => makeStmt(sql, next),
    async run() { stmt.run(...params); return { success: true, meta: { changes: 1 } }; },
    async first<T = any>() { return (stmt.get(...params) as T) ?? null; },
    async all<T = any>() { return { results: stmt.all(...params) as T[] }; },
  };
}
const db: any = { prepare: (sql: string) => makeStmt(sql, []) };

// --- Lulu API stub -----------------------------------------------------------
const originalFetch = globalThis.fetch;
let captured: { url: string; method: string; body: any }[] = [];
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = String(url);
  const method = String(init.method || "GET").toUpperCase();
  let body: any = init.body ?? null;
  if (typeof body === "string" && (init.headers?.["Content-Type"] || "").includes("json")) {
    try { body = JSON.parse(body); } catch { /* keep raw */ }
  }
  captured.push({ url: u, method, body });
  if (u.endsWith("/auth/realms/glasstree/protocol/openid-connect/token")) {
    return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
  }
  if (u.endsWith("/print-job-cost-calculations/") && method === "POST") {
    return new Response(JSON.stringify({
      line_item_costs: [{ total_cost_incl_tax: "5.16" }],
      shipping_cost: { total_cost_excl_tax: "5.69", total_cost_incl_tax: "6.28", total_tax: "0.59" },
      fulfillment_cost: { total_cost_excl_tax: "0.75", total_cost_incl_tax: "0.83", total_tax: "0.08" },
      total_tax: "1.14",
      total_cost_incl_tax: "12.27",
      currency: "USD",
    }), { status: 201 });
  }
  return new Response("unexpected url " + u, { status: 500 });
}) as any;

const env = {
  FULFILLMENT_PROVIDER: "lulu",
  LULU_ENV: "sandbox",
  LULU_SANDBOX_CLIENT_ID: "cid-sandbox",
  LULU_SANDBOX_CLIENT_SECRET: "secret-sandbox",
};
const MIRA = "mira-the-heron-and-the-still-water";
const FC43 = { pageCount: 43, podPackageId: "0850X1100.FC.STD.PB.060UW444.GXX" };
const BW44 = { pageCount: 44, podPackageId: "0850X1100.BW.STD.PB.060UW444.GXX" };
const ADDRESS = { line1: "100 W Race Ave", line2: "", city: "Searcy", state: "AR", postal_code: "72143", country: "US" };

async function main() {
  __clearLuluTokenCacheForTests();

  // --- Line item resolution from the registry -------------------------------
  const printed = await resolveLuluQuoteLineItems(db, [{ slug: MIRA, format: "printed", qty: 1 }]);
  check("printed line resolves to the story printable", JSON.stringify(printed) === JSON.stringify([{ ...FC43, quantity: 1 }]), JSON.stringify(printed));

  const gift = await resolveLuluQuoteLineItems(db, [{ slug: MIRA, format: "giftset", qty: 1 }]);
  check(
    "gift set resolves to story + coloring in one calculation",
    gift !== null && gift.length === 2 && gift.some((li) => li.podPackageId === FC43.podPackageId && li.pageCount === 43) && gift.some((li) => li.podPackageId === BW44.podPackageId && li.pageCount === 44),
    JSON.stringify(gift)
  );

  const twoPrinted = await resolveLuluQuoteLineItems(db, [{ slug: MIRA, format: "printed", qty: 2 }]);
  check("quantities group onto one line item", JSON.stringify(twoPrinted) === JSON.stringify([{ ...FC43, quantity: 2 }]), JSON.stringify(twoPrinted));

  const mixed = await resolveLuluQuoteLineItems(db, [
    { slug: MIRA, format: "printed", qty: 1 },
    { slug: MIRA, format: "giftset", qty: 1 },
    { slug: MIRA, format: "digital", qty: 1 },
  ]);
  check(
    "mixed cart: digital lines contribute nothing, printed + giftset units sum",
    mixed !== null && mixed.length === 2 && mixed.find((li) => li.pageCount === 43)?.quantity === 2 && mixed.find((li) => li.pageCount === 44)?.quantity === 1,
    JSON.stringify(mixed)
  );

  const missing = await resolveLuluQuoteLineItems(db, [{ slug: "docker", format: "printed", qty: 1 }]);
  check("a physical line with no printable fails closed to null", missing === null, JSON.stringify(missing));
  const missingColoring = await resolveLuluQuoteLineItems(db, [{ slug: "richdadpoordad", format: "giftset", qty: 1 }]);
  check("a gift set whose coloring printable is unregistered also fails closed", missingColoring === null, JSON.stringify(missingColoring));

  // --- The quote itself -------------------------------------------------------
  captured = [];
  const q = await quoteLuluShipping(db, env, {
    items: [{ slug: MIRA, format: "giftset", qty: 1 }],
    name: "Test Buyer",
    address: ADDRESS,
    phone: "+1 501 555 0100",
  });
  check("quote returns for a fully registered cart", q !== null);
  check("charge is shipping incl. tax + the $2 fee (pre-round-up)", q?.quote.amountCents === 628 + LULU_FULFILMENT_FEE_CENTS && LULU_FULFILMENT_FEE_CENTS === 200, JSON.stringify(q?.quote));
  check("quote rides the LabelQuote shape as Lulu / MAIL", q?.quote.carrier === "Lulu" && q?.quote.service === "MAIL" && q?.quote.rateId === "" && q?.quote.shipmentId === "", JSON.stringify(q?.quote));
  check(
    "breakdown carries shipping split, tax, fee and total",
    q?.detail.shippingExclTaxCents === 569 && q?.detail.shippingTaxCents === 59 && q?.detail.shippingInclTaxCents === 628 && q?.detail.fulfillmentFeeCents === 200 && q?.detail.chargeCents === 828 && q?.detail.level === "MAIL",
    JSON.stringify(q?.detail)
  );
  const costCall = captured.find((c) => c.url.endsWith("/print-job-cost-calculations/"));
  check("the cost call carries the phone Lulu requires", costCall?.body?.shipping_address?.phone_number === "+1 501 555 0100", JSON.stringify(costCall?.body?.shipping_address));
  check(
    "the cost call prices the gift set as two line items at MAIL",
    Array.isArray(costCall?.body?.line_items) && costCall.body.line_items.length === 2 && costCall.body.shipping_option === "MAIL",
    JSON.stringify(costCall?.body)
  );

  const noPrintable = await quoteLuluShipping(db, env, {
    items: [{ slug: "docker", format: "printed", qty: 1 }],
    name: "Test Buyer",
    address: ADDRESS,
    phone: "+1 501 555 0100",
  });
  check("quoteLuluShipping returns null (not a throw) on a missing printable", noPrintable === null);

  // --- Route + page wiring (source pins) --------------------------------------
  const route = readFileSync(new URL("../src/pages/api/checkout.ts", import.meta.url), "utf8");
  check("route gates the Lulu quote on luluConfigured", route.includes("luluConfigured(e)") && route.includes("quoteLuluShipping"));
  check("route validates address lengths at Lulu's limits on the lane", route.includes("LULU_LIMITS"));
  check("route requires a phone for physical carts", route.includes("Please add a phone number for delivery"));
  check("route fingerprints Lulu quotes under their provider", route.includes('provider: "lulu"'));
  check("route stores the quote breakdown on the order", route.includes("storeOrderShippingQuoteDetail"));
  check("route reads dedicationName into physical lines", route.includes("dedicationName"));

  const page = readFileSync(new URL("../src/pages/checkout.astro", import.meta.url), "utf8");
  check("checkout page collects a phone in the address step", page.includes('id="ship-phone"') && page.includes("phone: document.getElementById(\"ship-phone\")"));
  check("checkout page offers a dedication name per physical line", page.includes("data-dedication=") && page.includes("dedicationName: d"));

  globalThis.fetch = originalFetch;
  console.log(`\nlulu-checkout-quote.test.ts: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
