// SECURITY F10 (2026-10-31): open redirect on /login, /signup, and
// /auth/land via next=//host (protocol-relative) and next=/\host
// (the backslash form browsers normalize to a foreign origin).
// Live run of the shared helper + source pins for every hop.
// Run with: bun tests/open-redirect.test.ts
import { safeNextPath, isSafeNextPath } from "../src/lib/redirects";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const read = async (rel: string) =>
  Bun.file(new URL(rel, import.meta.url)).text();

// ---- Live helper ------------------------------------------------------------
assert(safeNextPath("//evil.com", "/admin") === "/admin", "rejects //evil.com");
assert(safeNextPath("/\\evil.com", "/admin") === "/admin", "rejects /\\evil.com");
assert(safeNextPath("\\\\evil.com", "/admin") === "/admin", "rejects \\\\evil.com");
assert(safeNextPath("https://evil.com", "/admin") === "/admin", "rejects absolute https URLs");
assert(safeNextPath("https://bigbrainshelf.com/account", "/account") === "/account", "rejects even same-host absolute URLs (paths only)");
assert(safeNextPath("/r/n\r\nSet-Cookie:x", "/x") === "/x", "rejects literal control characters");
assert(safeNextPath("/ok%0d%0aencoded", "/keep") === "/ok%0d%0aencoded", "URL-encoded (inert) characters pass through");
assert(safeNextPath("/account", "/admin") === "/account", "keeps a plain same-origin path");
assert(safeNextPath("/read/docker?format=audio", "/x") === "/read/docker?format=audio", "keeps query strings");
assert(safeNextPath("/admin?next=/login", "/account", ["/admin"]) === "/account", "blocked prefix with query is refused");
assert(safeNextPath("/admins", "/account", ["/admin"]) === "/admins", "a longer path sharing the prefix is NOT blocked");
assert(safeNextPath("", "/fallback") === "/fallback", "empty falls back");
assert(safeNextPath(null, "/fallback") === "/fallback", "null falls back");
assert(safeNextPath("x".repeat(600), "/fallback") === "/fallback", "oversized input falls back");
assert(!isSafeNextPath("/\t"), "tab inside a path is not safe");

// ---- Source pins: every `next` hop goes through the guard -------------------
const loginSrc = await read("../src/pages/login.astro");
assert(
  loginSrc.includes('safeNextPath(next, "/admin", ["/login"])'),
  "login server redirect uses the guard"
);
assert(
  !loginSrc.includes("window.location.href = next &&"),
  "no raw client-side next assignment remains in login"
);
const signupSrc = await read("../src/pages/signup.astro");
assert(
  signupSrc.includes('safeNext(next, "/auth/land", ["/admin", "/login"])'),
  "signup success hop uses the guard (blocks /admin, routes through the isOnboarded gate)"
);
assert(
  !signupSrc.includes("window.location.href = next &&"),
  "no raw client-side next assignment remains in signup"
);
const landSrc = await read("../src/pages/auth/land.astro");
assert(
  landSrc.includes('safeNextPath(next, "", ["/login", "/signup", "/admin"])'),
  "land customer redirect uses the guard"
);
assert(
  landSrc.includes('safeNextPath(next, "", ["/login", "/signup"])'),
  "land admin redirect uses the guard"
);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll open redirect tests passed.");
