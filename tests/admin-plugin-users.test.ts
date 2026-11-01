// Admin users route-2 pins (2026-10-31): /admin/users runs on the
// better-auth admin plugin's endpoints, owner sign-ins mint a real
// better-auth session, and the house users API is gone.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log("PASS:", name);
  else { failures++; console.log("FAIL:", name); }
}

const auth = read("src/lib/auth.ts");
const page = read("src/pages/admin/users.astro");
const pwLogin = read("src/pages/api/admin-auth/login.ts");
const gCallback = read("src/pages/api/auth/callback/google.ts");

// --- plugin-driven page ---
for (const ep of ["list-users", "set-role", "ban-user", "unban-user", "list-user-sessions", "revoke-user-session", "impersonate-user"]) {
  check("users page calls plugin endpoint " + ep, page.includes('"' + ep) || page.includes(ep + "?") || page.includes(ep + '"'));
}
check("users page talks to /api/auth/admin/", page.includes("/api/auth/admin/"));
check("users page no longer uses the house API", !page.includes("/api/admin/users"));
check("house users API deleted", !existsSync(resolve(root, "src/pages/api/admin/users.ts")));

// --- owner scoping stays ---
check("owner list embedded for guards", page.includes("ADMIN_EMAILS") && page.includes("isOwner"));
check("ban hidden for owner accounts", page.includes("else if (!owner)"));
check("make-admin offered only for owners", page.includes('owner && u.role !== "admin"'));

// --- bridge session minting ---
check("bridge helper creates a real session",
  auth.includes("createBridgeSessionCookie") &&
  auth.includes("internalAdapter.createSession") &&
  auth.includes("authCookies.sessionToken.name"));
check("bridge helper requires an existing user row", auth.includes("if (!user?.id) return null"));
check("password owner flow sets the bridge cookie",
  pwLogin.includes("createBridgeSessionCookie") && pwLogin.includes('headers.append("Set-Cookie", bridge)'));
check("google owner flow sets the bridge cookie",
  gCallback.includes("createBridgeSessionCookie") && gCallback.includes('headers.append("Set-Cookie", bridge)'));

// --- stripe id exposure ---
check("stripe_customer_id declared as an additional field",
  auth.includes("stripe_customer_id: { type: \"string\", required: false, input: false }"));
check("users page renders the stripe id", page.includes("u.stripe_customer_id"));

if (failures) { console.log(failures + " FAILURES"); process.exit(1); }
console.log("ALL PASS");
