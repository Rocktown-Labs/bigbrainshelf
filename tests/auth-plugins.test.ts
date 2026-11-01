// Better-auth batch pins (2026-10-31): session management, captcha on
// magic-link, last-login-method, passkey, rate limit. Source-pin style
// (like auth-turnstile) because lib/auth imports cloudflare:workers
// and cannot load under the plain Bun runner.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log("PASS:", name);
  else { failures++; console.log("FAIL:", name); }
}

const auth = read("src/lib/auth.ts");
const authUsers = read("src/lib/auth-users.ts");
const client = read("src/lib/auth-client.ts");
const login = read("src/pages/login.astro");
const account = read("src/pages/account/index.astro");

// --- session management ---
check("session: 30-day expiry kept", auth.includes("expiresIn: 60 * 60 * 24 * 30"));
check("session: updateAge refreshes at most daily", auth.includes("updateAge: 60 * 60 * 24"));
check("account: sessions listed with revoke", account.includes("authClient.listSessions()") && account.includes("authClient.revokeSession("));

// --- captcha ---
check("captcha: magic-link endpoint gated", auth.includes('"/sign-in/magic-link"'));
check("captcha: all five endpoints gated",
  ["/sign-in/email", "/sign-in/username", "/sign-up/email", "/request-password-reset", "/sign-in/magic-link"]
    .every((e) => auth.includes(`"${e}"`)));
check("login: magic-link request sends the captcha token",
  login.includes('mHeaders["x-captcha-response"] = mToken'));

// --- last login method ---
check("server: lastLoginMethod plugin registered", auth.includes("lastLoginMethod()"));
check("client: lastLoginMethodClient registered", client.includes("lastLoginMethodClient()"));
check("login: last-used badges wired",
  login.includes("getLastUsedLoginMethod()") && login.includes('data-last-used-badge="google"') &&
  login.includes('data-last-used-badge="magic-link"') && login.includes('data-last-used-badge="passkey"'));

// --- passkey ---
check("server: passkey plugin bound to the real domain",
  auth.includes('rpID: "bigbrainshelf.com"') && auth.includes('origin: "https://bigbrainshelf.com"'));
check("client: passkeyClient registered", client.includes("passkeyClient()"));
check("login: passkey sign-in button + conditional UI",
  login.includes('id="passkey-btn"') && login.includes("authClient.signIn.passkey()") &&
  login.includes("autoFill: true") && login.includes('autocomplete="username webauthn"'));
check("account: passkey management wired",
  account.includes("authClient.passkey.listUserPasskeys()") &&
  account.includes("authClient.passkey.addPasskey(") &&
  account.includes("authClient.passkey.deletePasskey("));
check("schema: passkey table self-heals", authUsers.includes('CREATE TABLE IF NOT EXISTS "passkey"'));
check("schema: passkey aaguid field name", authUsers.includes('"aaguid" TEXT'));

// --- rate limit ---
check("rateLimit: enabled with database storage",
  auth.includes('storage: "database"') && auth.includes("rateLimit: {"));
check("rateLimit: custom rules for magic-link + reset",
  auth.includes('"/sign-in/magic-link": { window: 60, max: 5 }') &&
  auth.includes('"/request-password-reset": { window: 60, max: 5 }'));
check("rateLimit: client IP from cf-connecting-ip",
  auth.includes('ipAddressHeaders: ["cf-connecting-ip"]'));
check("schema: rateLimit table self-heals", authUsers.includes('CREATE TABLE IF NOT EXISTS "rateLimit"'));

if (failures) { console.log(failures + " FAILURES"); process.exit(1); }
console.log("ALL PASS");
