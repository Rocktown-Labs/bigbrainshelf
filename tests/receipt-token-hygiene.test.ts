// SECURITY F3 + F12 (2026-10-31): the guest receipt's delivery_token
// is a permanent credential, and /order used to send it to Meta and
// Traks with the page URL, keep it in browser history, and offer the
// page to shared caches with no headers. Source pins.
// Run with: bun tests/receipt-token-hygiene.test.ts
let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const read = async (rel: string) =>
  Bun.file(new URL(rel, import.meta.url)).text();

const orderSrc = await read("../src/pages/order.astro");
assert(
  orderSrc.includes("history.replaceState(null, \"\", location.pathname)"),
  "F3: the token is stripped from the URL before analytics runs"
);
// The strip script must render BEFORE the Tracking component so the
// pixel and Traks never record the token.
assert(
  orderSrc.indexOf("history.replaceState") < orderSrc.indexOf("<Tracking traksEvent"),
  "F3: the strip script sits above Tracking in the head"
);
assert(
  orderSrc.includes("Cache-Control\", \"private, no-store"),
  "F3: /order responses are never stored in a shared cache"
);
assert(
  orderSrc.includes("X-Robots-Tag\", \"noindex"),
  "F3: /order responses are marked noindex"
);
// The pending state keeps the token (its meta-refresh reloads the
// tokenized URL until the webhook lands); only the completed receipt
// strips.
assert(
  orderSrc.includes("{complete && token && (") && orderSrc.includes('http-equiv="refresh"'),
  "F3: the strip runs on the completed receipt only; pending keeps its reload credential"
);

const middlewareSrc = await read("../src/middleware.ts");
assert(
  middlewareSrc.includes("Referrer-Policy\", \"strict-origin-when-cross-origin"),
  "F12: strict-origin-when-cross-origin Referrer-Policy on every response"
);
assert(
  middlewareSrc.includes("X-Content-Type-Options\", \"nosniff"),
  "F12: nosniff on every response"
);
assert(
  middlewareSrc.includes("Permissions-Policy\", \"camera=(), microphone=(), geolocation=()"),
  "F12: unused capabilities disabled on every response"
);
assert(
  middlewareSrc.includes("withSecurityHeaders(res)"),
  "F12: the header pass wraps every response, cached or not"
);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll receipt-token hygiene tests passed.");
