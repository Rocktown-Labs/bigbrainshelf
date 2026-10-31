// Turnstile on login / signup tests: the better-auth captcha
// plugin (Cloudflare Turnstile provider) is exercised directly
// against a stubbed siteverify endpoint to prove it rejects
// missing and bogus tokens BEFORE any credential handler runs, and
// passes valid tokens through. Source pins cover the wiring in
// src/lib/auth.ts (conditional registration, same keys as the
// newsletter form) and in the /login and /signup pages (widget
// markup, x-captcha-response header, widget reset on failure).
// Run with: bun tests/auth-turnstile.test.ts
import { readFileSync } from "node:fs";
import { captcha } from "better-auth/plugins";
import {
  turnstileEnforced,
  TURNSTILE_FAILED_MESSAGE,
} from "../src/lib/turnstile";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

// --- Stubbed siteverify: only "good-token" verifies.
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const body: any = await req.json().catch(() => ({}));
    if (body.response === "good-token") {
      return Response.json({ success: true, hostname: "bigbrainshelf.com" });
    }
    return Response.json({ success: false, "error-codes": ["invalid-input-response"] });
  },
});
const siteVerifyURLOverride = `http://127.0.0.1:${stub.port}/siteverify`;

const plugin: any = captcha({
  provider: "cloudflare-turnstile",
  secretKey: "test-secret",
  endpoints: ["/sign-in/email", "/sign-up/email", "/request-password-reset"],
  siteVerifyURLOverride,
} as any);

const ctx: any = {
  options: {},
  logger: { warn: () => {}, error: () => {} },
};

// Dispatch mimics better-auth: plugin onRequest hooks run first;
// the endpoint handler (here, a flag-setting stand-in for the
// credential check) runs only when onRequest lets the request
// through. So handlerRan === false on a rejection IS the proof
// that the credential check never ran.
let handlerRan = false;
async function dispatch(path: string, token?: string): Promise<Response> {
  handlerRan = false;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers["x-captcha-response"] = token;
  const req = new Request(`https://bigbrainshelf.com/api/auth${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "reader@example.com", password: "whatever123" }),
  });
  const pre = await plugin.onRequest(req, ctx);
  if (pre && pre.response) return pre.response as Response;
  handlerRan = true;
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

async function codeOf(res: Response): Promise<string> {
  const d: any = await res.clone().json().catch(() => ({}));
  return String(d?.code || "");
}

// --- sign-in/email
{
  const res = await dispatch("/sign-in/email");
  assert(res.status === 400, "sign-in: no token is rejected at the captcha layer (400)");
  assert((await codeOf(res)) === "MISSING_RESPONSE", "sign-in: no token reports MISSING_RESPONSE, not invalid credentials");
  assert(handlerRan === false, "sign-in: credential handler never runs without a token");
}
{
  const res = await dispatch("/sign-in/email", "bogus-token");
  assert(res.status === 403, "sign-in: bogus token is rejected at the captcha layer (403)");
  assert((await codeOf(res)) === "VERIFICATION_FAILED", "sign-in: bogus token reports VERIFICATION_FAILED");
  assert(handlerRan === false, "sign-in: credential handler never runs on a bogus token");
}
{
  const res = await dispatch("/sign-in/email", "good-token");
  assert(res.status === 200 && handlerRan === true, "sign-in: valid token passes through to the credential handler");
}

// --- sign-up/email
{
  const res = await dispatch("/sign-up/email");
  assert(res.status === 400 && handlerRan === false, "sign-up: no token rejected before the handler");
}
{
  const res = await dispatch("/sign-up/email", "bogus-token");
  assert(res.status === 403 && handlerRan === false, "sign-up: bogus token rejected before the handler");
}
{
  const res = await dispatch("/sign-up/email", "good-token");
  assert(res.status === 200 && handlerRan === true, "sign-up: valid token passes through to the handler");
}

// --- request-password-reset (better-auth endpoint, same abuse class)
{
  const res = await dispatch("/request-password-reset", "bogus-token");
  assert(res.status === 403 && handlerRan === false, "password reset: bogus token rejected before the handler");
}
{
  const res = await dispatch("/request-password-reset", "good-token");
  assert(res.status === 200 && handlerRan === true, "password reset: valid token passes through");
}

// --- Ungated endpoints pass through untouched (Google OAuth, session)
{
  const res = await dispatch("/sign-in/social");
  assert(res.status === 200 && handlerRan === true, "social sign-in is not captcha-gated (OAuth redirect flow)");
}
{
  const res = await dispatch("/get-session");
  assert(res.status === 200 && handlerRan === true, "get-session is not captcha-gated");
}

// --- Enforcement gate (same helper the newsletter form uses)
assert(!turnstileEnforced({}), "auth turnstile: no keys means the plugin stays unregistered");
assert(!turnstileEnforced({ TURNSTILE_SITE_KEY: "site" }), "auth turnstile: site key alone does not enforce");
assert(turnstileEnforced({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" }), "auth turnstile: both keys means enforcement on");
assert(TURNSTILE_FAILED_MESSAGE === "Please complete the check and try again.", "auth turnstile: the plain failure message matches the newsletter copy");

// --- Source pins: auth wiring
const authSrc = readFileSync(new URL("../src/lib/auth.ts", import.meta.url), "utf8");
assert(authSrc.includes('from "better-auth/plugins"') && authSrc.includes("captcha"), "auth.ts registers the better-auth captcha plugin");
assert(authSrc.includes('"cloudflare-turnstile"'), "auth.ts uses the Cloudflare Turnstile provider (same widget as the newsletter)");
assert(authSrc.includes("turnstileEnforced(e)"), "auth.ts registers the plugin only when Turnstile is enforced (unkeyed env unchanged)");
assert(authSrc.includes("TURNSTILE_SECRET_KEY"), "auth.ts reads the shared TURNSTILE_SECRET_KEY");
for (const ep of ["/sign-in/email", "/sign-up/email", "/request-password-reset"]) {
  assert(authSrc.includes(`"${ep}"`), `auth.ts gates ${ep}`);
}
assert(!authSrc.includes("sign-in/social"), "auth.ts does not gate the social sign-in endpoint");

// --- Source pins: login + signup pages
for (const [name, path] of [["login", "../src/pages/login.astro"], ["signup", "../src/pages/signup.astro"]] as const) {
  const src = readFileSync(new URL(path, import.meta.url), "utf8");
  assert(src.includes("TURNSTILE_SITE_KEY"), `${name}: page reads the Turnstile site key from the worker env`);
  assert(src.includes("cf-turnstile") && src.includes("data-sitekey"), `${name}: form renders the Turnstile widget`);
  assert(src.includes("challenges.cloudflare.com/turnstile/v0/api.js"), `${name}: page loads the Turnstile script`);
  assert(src.includes("cf-turnstile-response"), `${name}: submit reads the widget token field`);
  const headerUses = src.split('headers["x-captcha-response"]').length - 1;
  assert(headerUses === 1, `${name}: the token header is attached exactly once (the email endpoint, not Google)`);
  assert(src.includes("MISSING_RESPONSE") && src.includes("VERIFICATION_FAILED"), `${name}: captcha rejections map to the plain message`);
  assert(src.includes("Please complete the check and try again."), `${name}: the plain check message is the inline error copy`);
  assert(src.includes("turnstile.reset"), `${name}: the widget resets after a failed attempt (tokens are single-use)`);
  assert(src.includes("/api/auth/sign-in/social"), `${name}: Google button still uses the ungated social flow`);
}

stub.stop(true);

if (failures) { console.error(`\n${failures} FAILURES`); process.exit(1); }
console.log("\nAll auth Turnstile tests passed.");
