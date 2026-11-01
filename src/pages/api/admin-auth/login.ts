import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { verifyPassword } from "../../../lib/adminpass";
import { isAdminEmail } from "../../../lib/admins";
import { createBridgeSessionCookie } from "../../../lib/auth";

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

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const { email, password } = await request.json().catch(() => ({}));

  if (!isAdminEmail(email) || !password) {
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }

  // Preferred: password hash in D1 settings (set via the reset flow).
  let ok = false;
  try {
    const row: any = await e.DB.prepare(
      "SELECT value FROM settings WHERE key = 'admin_password_hash'"
    ).first();
    if (row?.value) ok = await verifyPassword(password, row.value);
  } catch { /* settings row absent: fall through to bootstrap secret */ }

  // Bootstrap fallback: the ADMIN_PASSWORD worker secret.
  if (!ok) {
    const expected = e?.ADMIN_PASSWORD || "";
    ok = !!expected && password === expected;
  }

  if (!ok) {
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
