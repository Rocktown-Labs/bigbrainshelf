import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { verifyPassword } from "../../../lib/adminpass";
import { isAdminEmail } from "../../../lib/admins";
import { createBridgeSessionCookie } from "../../../lib/auth";
import { checkRateLimit, clientIp } from "../../../lib/rate-limit";

// SECURITY (F5, 2026-10-31): the ADMIN_PASSWORD worker secret used to
// be a permanent plaintext second password (checked with === after a
// failed hash check, so it survived every reset), and the route had
// no rate limit at all. Now:
//   - the only credential is the PBKDF2 hash in settings
//     ('admin_password_hash', set via the reset flow);
//   - the bootstrap secret is gone entirely (the owner signs in with
//     Google; the reset flow can still set a break-glass password);
//   - attempts are rate-limited per email and per IP, and failures
//     are logged so `cf` logs show every guess.

async function sign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function createSession(email: string, secret: string): Promise<string> {
  const payload = btoa(JSON.stringify({
    email,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
  }));
  const sig = await sign(payload, secret);
  return `${payload}.${sig}`;
}

const WINDOW_SEC = 15 * 60;
const MAX_PER_EMAIL = 10;
const MAX_PER_IP = 20;

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const { email, password } = await request.json().catch(() => ({}));

  if (!isAdminEmail(email) || !password) {
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }

  // Rate limits first: a locked-out key never even reaches the
  // password check. Per email caps a targeted attack on one owner
  // address; per IP caps spraying across all three.
  const ip = clientIp(request);
  const [byEmail, byIp] = await Promise.all([
    checkRateLimit(e.DB, `admin_login:email:${String(email).toLowerCase()}`, MAX_PER_EMAIL, WINDOW_SEC),
    checkRateLimit(e.DB, `admin_login:ip:${ip}`, MAX_PER_IP, WINDOW_SEC),
  ]);
  if (!byEmail.ok || !byIp.ok) {
    const wait = Math.max(byEmail.retryAfterSec, byIp.retryAfterSec);
    console.warn(`[admin-auth] rate limited: ${String(email).toLowerCase()} from ${ip}`);
    return Response.json(
      { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` },
      { status: 429, headers: { "Retry-After": String(wait) } }
    );
  }

  // Preferred and ONLY credential: password hash in D1 settings
  // (set via the reset flow). No bootstrap secret fallback remains.
  let ok = false;
  try {
    const row: any = await e.DB.prepare(
      "SELECT value FROM settings WHERE key = 'admin_password_hash'"
    ).first();
    if (row?.value) ok = await verifyPassword(password, row.value);
  } catch { /* settings table absent: no credential is set, so no sign-in */ }

  if (!ok) {
    // Audit trail: every failed guess lands in the worker logs with
    // the allowlisted email it targeted and the source IP.
    console.warn(`[admin-auth] failed login: ${String(email).toLowerCase()} from ${ip}`);
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const session = await createSession(email.toLowerCase(), e.BETTER_AUTH_SECRET);
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", `admin_session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
  // Route 2 (2026-10-31): owner sign-ins also carry a better-auth
  // session so the admin plugin endpoints work from /admin.
  const bridge = await createBridgeSessionCookie(email, request);
  if (bridge) headers.append("Set-Cookie", bridge);
  return new Response(JSON.stringify({ ok: true }), { headers });
};
