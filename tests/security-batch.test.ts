// SECURITY batch (2026-10-31): F11 edge-cache query skip, F13 timing
// compares, F14 username enumeration, F16 Turnstile partial-config
// warning, F17 auth origin defaults, N1 semantic-search cost guards.
// Live timing-helper run + source pins.
// Run with: bun tests/security-batch.test.ts
import { timingSafeEqualStr } from "../src/lib/timing";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const read = async (rel: string) =>
  Bun.file(new URL(rel, import.meta.url)).text();

// ---- F13: timing helper -----------------------------------------------------
assert(await timingSafeEqualStr("abc", "abc"), "timing: equal strings match");
assert(!(await timingSafeEqualStr("abc", "abd")), "timing: different strings differ");
assert(!(await timingSafeEqualStr("abc", "abcd")), "timing: different lengths differ");
assert(!(await timingSafeEqualStr("", "x")), "timing: empty vs non-empty differ");
assert(await timingSafeEqualStr("", ""), "timing: empty equals empty");

const middlewareSrc = await read("../src/middleware.ts");
assert(
  middlewareSrc.includes("timingSafeEqualStr(expected, sigB64)"),
  "F13: admin_session HMAC compare is constant-time"
);
assert(
  !middlewareSrc.includes("expected !== sigB64"),
  "F13: no raw !== HMAC compare remains"
);
const resetSrc = await read("../src/pages/api/admin-auth/reset.ts");
assert(
  resetSrc.includes("timingSafeEqualStr(String(token), savedToken"),
  "F13: the reset token compare is constant-time"
);

// ---- F11: edge cache never keys a URL with a query --------------------------
assert(
  middlewareSrc.includes("!context.url.search &&"),
  "F11: cacheable GETs skip whenever a query string is present"
);

// ---- F14: no unauthenticated username probes --------------------------------
const meSrc = await read("../src/pages/api/account/me.ts");
assert(
  meSrc.indexOf('json({ error: "Sign in required" }, 401)') <
    meSrc.indexOf('action === "check_username"'),
  "F14: the session gate runs before the username availability action"
);

// ---- F16: partial Turnstile config warns ------------------------------------
const authSrc = await read("../src/lib/auth.ts");
assert(
  authSrc.includes("PARTIALLY configured"),
  "F16: one-key-only Turnstile logs a loud deployment error"
);

// ---- F17: auth origins --------------------------------------------------------
assert(
  !authSrc.includes('e.BETTER_AUTH_URL || "https://bookstore'),
  "F17: the legacy host is no longer the baseURL fallback"
);
assert(
  authSrc.includes('"https://bigbrainshelf.com"'),
  "F17: the canonical site is the baseURL fallback"
);
assert(
  authSrc.includes("trustedOrigins:"),
  "F17: trustedOrigins is configured (apex + www + explicit override)"
);

// ---- N1: semantic search cost guards ---------------------------------------
const braintrustSrc = await read("../src/lib/braintrust.ts");
assert(
  braintrustSrc.includes("VECTOR_CACHE_TTL_MS"),
  "N1: the catalog document set + embeddings are cached per isolate"
);
assert(
  braintrustSrc.includes("docVectorFor(doc)"),
  "N1: document embeddings come from the cache, not per-request compute"
);
assert(
  braintrustSrc.includes(".slice(0, 300)"),
  "N1: the semantic query is length-capped"
);
const searchSrc = await read("../src/pages/api/search.ts");
assert(
  searchSrc.includes("search_semantic:"),
  "N1: the semantic branch is per-IP rate-limited"
);
assert(
  searchSrc.includes("if (!limitCheck || limitCheck.ok)"),
  "N1: an over-limit client still gets keyword sections (graceful degrade)"
);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll security batch tests passed.");
