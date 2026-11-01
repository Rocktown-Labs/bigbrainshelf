// SECURITY F5 (2026-10-31): admin password login hardening.
// - the ADMIN_PASSWORD plaintext bootstrap fallback is gone;
// - the D1 PBKDF2 hash (set via the reset flow) is the only credential;
// - attempts are rate-limited per email and per IP and failures are logged.
// Live rate-limiter run against in-memory sqlite + source pins.
// Run with: bun tests/admin-login-hardening.test.ts
import { Database } from "bun:sqlite";
import { checkRateLimit } from "../src/lib/rate-limit";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const read = async (rel: string) =>
  Bun.file(new URL(rel, import.meta.url)).text();

// ---- Source pins -----------------------------------------------------------
const loginSrc = await read("../src/pages/api/admin-auth/login.ts");
assert(!loginSrc.includes("e?.ADMIN_PASSWORD"), "F5: no ADMIN_PASSWORD fallback in the login route");
assert(!loginSrc.includes("password === expected"), "F5: no plaintext password comparison");
assert(loginSrc.includes("checkRateLimit"), "F5: the login route rate-limits attempts");
assert(loginSrc.includes("admin_login:email:"), "F5: attempts limited per admin email");
assert(loginSrc.includes("admin_login:ip:"), "F5: attempts limited per source IP");
assert(loginSrc.includes("failed login"), "F5: failed attempts are logged");
// The only credential check runs through the PBKDF2 verifier.
assert(loginSrc.includes("verifyPassword(password, row.value)"), "F5: the hash is the only credential");
const adminpassSrc = await read("../src/lib/adminpass.ts");
assert(adminpassSrc.includes("pbkdf2$"), "F5: PBKDF2 hash format unchanged");

// ---- Live rate limiter (fixed window) --------------------------------------
const raw = new Database(":memory:");
const db = {
  prepare(sql: string) {
    return {
      bind(...args: any[]) {
        const stmt = raw.query(sql);
        return {
          async run() { const r = stmt.run(...args) as any; return { meta: { changes: r?.changes ?? 0 } }; },
          async first() { return stmt.get(...args) ?? null; },
          async all() { return { results: stmt.all(...args) }; },
        };
      },
    };
  },
} as any;

const KEY = "unit:limit";
let r = await checkRateLimit(db, KEY, 3, 60);
assert(r.ok && r.count === 1, "first attempt passes");
r = await checkRateLimit(db, KEY, 3, 60);
assert(r.ok && r.count === 2, "second attempt passes");
r = await checkRateLimit(db, KEY, 3, 60);
assert(r.ok && r.count === 3, "third attempt passes at exactly the limit");
r = await checkRateLimit(db, KEY, 3, 60);
assert(!r.ok && r.count === 4 && r.retryAfterSec > 0, "fourth attempt is refused with a retry window");
r = await checkRateLimit(db, KEY, 3, 60);
assert(!r.ok, "fifth attempt still refused (no window widening)");

// A different key has its own counter.
r = await checkRateLimit(db, "unit:other", 3, 60);
assert(r.ok && r.count === 1, "independent counters per key");

// The window resets when the start is moved back.
await db
  .prepare("UPDATE app_rate_limits SET window_start = ? WHERE key = ?")
  .bind(Math.floor(Date.now() / 1000) - 61, KEY)
  .run();
r = await checkRateLimit(db, KEY, 3, 60);
assert(r.ok && r.count === 1, "a new window passes again");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll admin login hardening tests passed.");
