// Admin cost-price ordering + Stripe Tax wiring (CG, 2026-11-10).
// Covers: the admin gate (session email only), the per-job markup
// (once per job, gift set included), the exact-to-the-cent target
// allocation across print lines and quantities, the full Lulu job
// cost read (and its fail-closed nulls), the order pricing stamp
// round-trip, the Stripe tax code assignments, the TAX_ENABLED gate,
// and source pins that the checkout routes wire all of it
// server-side with no client-reachable flag.
// Run with: bun tests/admin-cost-checkout.test.ts
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  isAdminBuyer,
  allocateAdminCost,
  adminCostTargetCents,
  ADMIN_COST_MARKUP_CENTS,
  PRICING_MODE_ADMIN_COST,
} from "../src/lib/admin-cost";
import {
  taxCodeForBookFormat,
  taxCodeForClubPlan,
  stripeTaxEnabled,
  STRIPE_TAX_CODES,
} from "../src/lib/stripe-tax";
import { quoteLuluJobCost } from "../src/lib/print-fulfillment";
import { ensureOrderPricingColumns, stampOrderPricing } from "../src/lib/orders";
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
raw.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, amount INTEGER)");

// --- Lulu API stub (same fixture family as lulu-checkout-quote) --------------
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = String(url);
  const method = String(init.method || "GET").toUpperCase();
  if (u.endsWith("/auth/realms/glasstree/protocol/openid-connect/token")) {
    return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
  }
  if (u.endsWith("/print-job-cost-calculations/") && method === "POST") {
    return new Response(JSON.stringify({
      line_item_costs: [{ total_cost_incl_tax: "5.16" }],
      shipping_cost: { total_cost_excl_tax: "5.69", total_cost_incl_tax: "6.28", total_tax: "0.59" },
      fulfillment_cost: { total_cost_excl_tax: "0.75", total_cost_incl_tax: "0.83", total_tax: "0.08" },
      total_cost_excl_tax: "11.13",
      total_tax: "1.14",
      total_cost_incl_tax: "12.27",
      currency: "USD",
    }), { status: 201 });
  }
  return new Response("unexpected url " + u, { status: 500 });
}) as any;

const env = {
  LULU_ENV: "sandbox",
  LULU_SANDBOX_CLIENT_ID: "cid-sandbox",
  LULU_SANDBOX_CLIENT_SECRET: "secret-sandbox",
};
const MIRA = "mira-the-heron-and-the-still-water";
const ADDRESS = { line1: "100 W Race Ave", line2: "", city: "Searcy", state: "AR", postal_code: "72143", country: "US" };

async function main() {
  __clearLuluTokenCacheForTests();

  // --- The gate ---------------------------------------------------------------
  check("admin email passes the buyer gate", isAdminBuyer({ email: "cg@rocktownlabs.com" }) === true);
  check("owner gmail passes the buyer gate", isAdminBuyer({ email: "rocktownlabs@gmail.com" }) === true);
  check("a customer email does not pass", isAdminBuyer({ email: "reader@example.com" }) === false);
  check("a guest (no user) does not pass", isAdminBuyer(null) === false && isAdminBuyer(undefined) === false);
  check("a user with no email does not pass", isAdminBuyer({}) === false);

  // --- The markup rule ----------------------------------------------------------
  check("markup is the flat $3 CG named", ADMIN_COST_MARKUP_CENTS === 300);
  check("target = job cost + markup, once", adminCostTargetCents(1227) === 1527);

  // --- Allocation: exact to the cent, always ------------------------------------
  const sum = (gs: { unitCents: number; qty: number }[]) => gs.reduce((a, g) => a + g.unitCents * g.qty, 0);
  const single = allocateAdminCost([{ key: "mira:printed", retailUnitCents: 2499, qty: 1 }], 1527);
  check("single printed book takes the whole target on one line",
    single.length === 1 && single[0].unitCents === 1527 && single[0].qty === 1, JSON.stringify(single));

  const giftOnly = allocateAdminCost([{ key: "mira:giftset", retailUnitCents: 3500, qty: 1 }], 1527);
  check("a gift set is ONE line: the per-job markup lands once, not per book inside it",
    giftOnly.length === 1 && sum(giftOnly) === 1527, JSON.stringify(giftOnly));

  const mixed = allocateAdminCost([
    { key: "mira:printed", retailUnitCents: 2499, qty: 1 },
    { key: "penny:printed", retailUnitCents: 2499, qty: 2 },
  ], 4321);
  check("mixed cart allocation sums to the target exactly", sum(mixed) === 4321, JSON.stringify(mixed));
  const mixedUnits = mixed.map((g) => g.unitCents);
  check("allocation stays proportional to retail weights (equal retail prices -> unit prices within a cent)",
    Math.max(...mixedUnits) - Math.min(...mixedUnits) <= 1,
    JSON.stringify(mixed));

  const indivisible = allocateAdminCost([{ key: "mira:printed", retailUnitCents: 2499, qty: 3 }], 1000);
  check("a qty-3 line with an indivisible share splits into unit groups that still sum exact",
    sum(indivisible) === 1000 && indivisible.every((g) => g.key === "mira:printed") &&
    indivisible.reduce((a, g) => a + g.qty, 0) === 3,
    JSON.stringify(indivisible));

  check("no lines, no groups", allocateAdminCost([], 1527).length === 0);

  // --- The full job cost read -----------------------------------------------------
  const cost = await quoteLuluJobCost(db, env, {
    items: [{ slug: MIRA, format: "giftset", qty: 1 }],
    name: "CG Stewart",
    address: ADDRESS,
    phone: "+1 501 555 0100",
  });
  check("job cost returns for a registered gift set", cost !== null);
  check("job cost is the WHOLE job (printing + shipping + fulfilment, tax in)",
    cost?.totalInclTaxCents === 1227 && cost?.shippingInclTaxCents === 628 && cost?.fulfillmentInclTaxCents === 83,
    JSON.stringify(cost));
  check("job cost names its environment", cost?.envName === "sandbox");

  const noCreds = await quoteLuluJobCost(db, {}, { items: [{ slug: MIRA, format: "printed", qty: 1 }], address: ADDRESS, phone: "+1 501 555 0100" });
  check("no Lulu credentials -> null (the route fails the admin checkout, never silently retail)", noCreds === null);
  const noPrintable = await quoteLuluJobCost(db, env, { items: [{ slug: "docker", format: "printed", qty: 1 }], address: ADDRESS, phone: "+1 501 555 0100" });
  check("a line with no registered printable -> null", noPrintable === null);

  // --- The order stamp --------------------------------------------------------------
  raw.exec("INSERT INTO orders (id, amount) VALUES ('ord-1', 1527)");
  await ensureOrderPricingColumns(db);
  await stampOrderPricing(db, "ord-1", PRICING_MODE_ADMIN_COST, { job_total_cost_incl_tax_cents: 1227, markup_cents: 300 });
  const stamped = await db.prepare("SELECT pricing_mode, pricing_detail FROM orders WHERE id = ?").bind("ord-1").first();
  check("the order row carries the admin_cost mode and its breakdown",
    stamped?.pricing_mode === "admin_cost" && JSON.parse(stamped.pricing_detail).job_total_cost_incl_tax_cents === 1227,
    JSON.stringify(stamped));

  // --- Stripe tax codes ---------------------------------------------------------------
  check("printed book -> Books for Children", taxCodeForBookFormat("printed") === "txcd_35010001");
  check("gift set -> Books for Children", taxCodeForBookFormat("giftset") === "txcd_35010001");
  check("digital book -> Digital Books, permanent", taxCodeForBookFormat("digital") === "txcd_10302000");
  check("audiobook -> Audiobook", taxCodeForBookFormat("audio") === "txcd_10301000");
  check("Book Club -> Books for Children", taxCodeForClubPlan("physical") === "txcd_35010001");
  check("Audio Club -> Digital Books, subscription", taxCodeForClubPlan("audio") === "txcd_10302002");
  check("shipping -> Shipping and Handling", STRIPE_TAX_CODES.shipping === "txcd_92010000");

  // --- The TAX_ENABLED gate --------------------------------------------------------------
  check("tax stays OFF with the flag unset (dashboard activation comes first)",
    stripeTaxEnabled({}) === false && stripeTaxEnabled({ TAX_ENABLED: "0" }) === false);
  check("tax turns on only at the flag", stripeTaxEnabled({ TAX_ENABLED: "1" }) === true && stripeTaxEnabled({ TAX_ENABLED: "true" }) === true);

  // --- Source pins: the routes wire it server-side -----------------------------------------
  const checkoutSrc = readFileSync(new URL("../src/pages/api/checkout.ts", import.meta.url), "utf8");
  check("checkout gates admin pricing on the session identity", checkoutSrc.includes("isAdminBuyer(user)"));
  check("checkout reads no admin flag from the request body", !/body\?\.[a-z_]*admin/i.test(checkoutSrc) && !/body\.[a-z_]*admin/i.test(checkoutSrc));
  check("checkout stamps the Stripe session metadata", checkoutSrc.includes("sessionParams.metadata.pricing_mode = PRICING_MODE_ADMIN_COST"));
  check("checkout stamps the order row", checkoutSrc.includes("stampOrderPricing(e.DB, order.id, PRICING_MODE_ADMIN_COST"));
  check("checkout sends tax codes on book lines", checkoutSrc.includes("tax_code: taxCodeForBookFormat(w.format)"));
  check("checkout refuses the promo combination", checkoutSrc.includes("Promo codes do not combine with admin cost pricing"));
  check("admin mode sends no paid shipping option", checkoutSrc.includes("shippingCents > 0"));
  const clubSrc = readFileSync(new URL("../src/pages/api/club/checkout.ts", import.meta.url), "utf8");
  check("club checkout carries its tax code and reads the shared gate",
    clubSrc.includes("tax_code: taxCodeForClubPlan(clubPlan)") && clubSrc.includes("stripeTaxEnabled(e)"));
  const dashSrc = readFileSync(new URL("../src/lib/admin-dashboard.ts", import.meta.url), "utf8");
  check("dashboard revenue excludes admin cost orders", dashSrc.includes("COALESCE(pricing_mode, '') != 'admin_cost'"));
  const ordersApiSrc = readFileSync(new URL("../src/pages/api/admin/orders.ts", import.meta.url), "utf8");
  check("orders admin revenue excludes admin cost orders", ordersApiSrc.includes("COALESCE(pricing_mode, '') != 'admin_cost'"));

  globalThis.fetch = originalFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
