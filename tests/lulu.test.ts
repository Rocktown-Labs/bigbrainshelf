// Lulu API client (src/lib/lulu.ts) with a stubbed global fetch:
// request shapes, token caching, cost parsing, cancel body, and
// the provider gate. No network and no credentials are involved.
import {
  __clearLuluTokenCacheForTests,
  buildCreateJobBody,
  cancelPrintJob,
  costCalculation,
  createPrintJob,
  luluConfigured,
  luluEnvName,
  normalizeLuluAddress,
  parseCostCalculation,
} from "../src/lib/lulu";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log("  ok:", name); }
  else { failed++; console.error("  FAIL:", name, extra ?? ""); }
}

const originalFetch = globalThis.fetch;
type Captured = { url: string; method: string; headers: any; body: any };
let captured: Captured[] = [];
let tokenCalls = 0;

function installFetch() {
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    let body: any = init.body ?? null;
    if (typeof body === "string" && (init.headers?.["Content-Type"] || "").includes("json")) {
      try { body = JSON.parse(body); } catch { /* keep raw */ }
    }
    captured.push({ url: u, method, headers: init.headers || {}, body });
    if (u.endsWith("/auth/realms/glasstree/protocol/openid-connect/token")) {
      tokenCalls++;
      return new Response(JSON.stringify({ access_token: "tok-test", expires_in: 3600 }), { status: 200 });
    }
    if (u.endsWith("/print-jobs/") && method === "POST") {
      return new Response(JSON.stringify({ id: 555001, status: { name: "CREATED" } }), { status: 201 });
    }
    if (u.endsWith("/print-jobs/555001/status/") && method === "PUT") {
      return new Response(JSON.stringify({ name: "CANCELED" }), { status: 200 });
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
}

const env = {
  FULFILLMENT_PROVIDER: "lulu",
  LULU_ENV: "sandbox",
  LULU_SANDBOX_CLIENT_ID: "cid-sandbox",
  LULU_SANDBOX_CLIENT_SECRET: "secret-sandbox",
};

async function main() {
  // Provider gate.
  check("lane on when provider + sandbox creds present", luluConfigured(env));
  check("lane off without the provider flag", !luluConfigured({ ...env, FULFILLMENT_PROVIDER: "" }));
  check("lane off without credentials", !luluConfigured({ FULFILLMENT_PROVIDER: "lulu", LULU_ENV: "sandbox" }));
  check("production env needs production creds", !luluConfigured({ FULFILLMENT_PROVIDER: "lulu", LULU_ENV: "production", LULU_SANDBOX_CLIENT_ID: "x", LULU_SANDBOX_CLIENT_SECRET: "y" }));
  check("production env honored", luluConfigured({ FULFILLMENT_PROVIDER: "lulu", LULU_ENV: "production", LULU_CLIENT_ID: "p", LULU_CLIENT_SECRET: "s" }));
  check("env name defaults to sandbox", luluEnvName({}) === "sandbox" && luluEnvName(env) === "sandbox");

  // Address normalization to Lulu's hard limits.
  const normalized = normalizeLuluAddress({
    name: "A very long recipient name that exceeds the Lulu limit!!",
    street1: "12345678901234567890123456789012345 Main Street",
    street2: "",
    city: "A Very Long City Name Indeed, Arkansas",
    stateCode: "AR",
    postcode: "72143",
    countryCode: "us",
    phone: "+1 (501) 555-0100 ext 99999",
  });
  check("name truncated to 35", normalized.address.name.length === 35);
  check("street1 truncated to 30", normalized.address.street1.length === 30);
  check("city truncated to 30", normalized.address.city.length === 30);
  check("phone truncated to 20", normalized.address.phone_number.length === 20);
  check("country uppercased", normalized.address.country_code === "US");
  check("empty street2 omitted", !("street2" in normalized.address));
  check("truncations noted", normalized.warnings.length >= 4, JSON.stringify(normalized.warnings));

  // Create body shape.
  const body = buildCreateJobBody({
    contactEmail: "cg@rocktownlabs.com",
    externalId: "order:ord-1",
    productionDelay: 120,
    shippingLevel: "MAIL",
    address: normalized.address,
    lineItems: [{
      externalId: "ord-1:1",
      title: "Mira the Heron",
      quantity: 1,
      podPackageId: "0850X1100.FC.STD.PB.060UW444.GXX",
      interiorUrl: "https://bigbrainshelf.com/api/print-file/tok-i",
      coverUrl: "https://bigbrainshelf.com/api/print-file/tok-c",
    }],
  });
  check("body carries production_delay 120", body.production_delay === 120);
  check("body carries MAIL level", body.shipping_level === "MAIL");
  check("line item normalization shape",
    body.line_items[0].printable_normalization.pod_package_id === "0850X1100.FC.STD.PB.060UW444.GXX" &&
    body.line_items[0].printable_normalization.interior.source_url.endsWith("tok-i") &&
    body.line_items[0].printable_normalization.cover.source_url.endsWith("tok-c"));

  // Live calls against the stub: token, create, cancel, cost.
  installFetch();
  __clearLuluTokenCacheForTests();
  const created: any = await createPrintJob(env, {
    contactEmail: "cg@rocktownlabs.com",
    externalId: "order:ord-1",
    productionDelay: 120,
    shippingLevel: "MAIL",
    shippingAddress: normalized.address,
    lineItems: [{
      externalId: "ord-1:1",
      title: "Mira the Heron",
      quantity: 1,
      podPackageId: "0850X1100.FC.STD.PB.060UW444.GXX",
      interiorUrl: "https://bigbrainshelf.com/api/print-file/tok-i",
      coverUrl: "https://bigbrainshelf.com/api/print-file/tok-c",
    }],
  });
  check("create returns job id and status", created.id === 555001 && created.status?.name === "CREATED");
  const createCall = captured.find((c) => c.url.endsWith("/print-jobs/"));
  check("create hit the sandbox host", !!createCall && createCall.url.startsWith("https://api.sandbox.lulu.com/"));
  check("create sent the bearer token", createCall?.headers?.Authorization === "Bearer tok-test");
  check("create call carried the exact create body",
    createCall?.body?.production_delay === 120 &&
    createCall?.body?.shipping_level === "MAIL" &&
    createCall?.body?.line_items?.[0]?.printable_normalization?.pod_package_id === "0850X1100.FC.STD.PB.060UW444.GXX",
    JSON.stringify(createCall?.body));
  check("token fetched once", tokenCalls === 1, String(tokenCalls));
  const tokenCall = captured.find((c) => c.url.endsWith("/auth/realms/glasstree/protocol/openid-connect/token"));
  const tokenForm = new URLSearchParams(typeof tokenCall?.body === "string" ? tokenCall.body : "");
  check("token form carries the configured client_id", tokenForm.get("client_id") === "cid-sandbox", String(tokenCall?.body));
  check("token form carries the configured client_secret", tokenForm.get("client_secret") === "secret-sandbox", String(tokenCall?.body));
  check("token form carries the client_credentials grant", tokenForm.get("grant_type") === "client_credentials", String(tokenCall?.body));

  const canceled: any = await cancelPrintJob(env, 555001);
  const cancelCall = captured.find((c) => c.method === "PUT");
  check("cancel PUT body is exactly the CANCELED name", JSON.stringify(cancelCall?.body) === JSON.stringify({ name: "CANCELED" }), JSON.stringify(cancelCall?.body));
  check("cancel response parsed", canceled?.name === "CANCELED");
  check("token was cached for the second call", tokenCalls === 1, String(tokenCalls));

  const cost = await costCalculation(env, {
    lineItems: [{ pageCount: 43, podPackageId: "0850X1100.FC.STD.PB.060UW444.GXX", quantity: 1 }],
    address: normalized.address,
    shippingOption: "MAIL",
  });
  check("cost totals parsed", cost.totalCostInclTax === "12.27" && cost.shippingCost === "6.28" && cost.fulfillmentCost === "0.83" && cost.totalTax === "1.14", JSON.stringify(cost));
  check("cost keeps the raw payload", (cost.raw as any)?.currency === "USD");

  const parsed = parseCostCalculation({ total_cost_incl_tax: "9.99" });
  check("parseCostCalculation preserves string decimals", parsed.totalCostInclTax === "9.99");

  globalThis.fetch = originalFetch;
  console.log(`\nlulu.test.ts: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error(err);
  process.exit(1);
});
