import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";

import { isAdminEmail } from "../../../../lib/admins";

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

// Step 2: Google redirects back here with ?code=...&state=...
// Two flows share this callback path (the URI registered in the Google
// Cloud Console): the owner flow, started by /api/admin-auth/google,
// which sets an oauth_state cookie equal to the state it sent; and the
// customer flow (better-auth social sign-in), which does not. A matching
// oauth_state cookie means owner flow; anything else is handed to the
// better-auth handler untouched.
export const GET: APIRoute = async ({ request, url }) => {
  const e = env as any;
  const stateParam = url.searchParams.get("state");
  const cookieHeader = request.headers.get("cookie") || "";
  const stateCookie = cookieHeader.match(/(?:^|;\s*)oauth_state=([^;]+)/)?.[1];
  const isOwnerFlow = !!(
    stateParam &&
    stateCookie &&
    decodeURIComponent(stateCookie) === stateParam
  );
  if (!isOwnerFlow) {
    const { getAuth } = await import("../../../../lib/auth");
    return getAuth().handler(request);
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  // Stay on whichever domain the flow started on (see admin-auth/google).
  const origin = url.origin;

  if (error || !code) {
    return Response.redirect(`${origin}/admin/login?error=no_code`, 302);
  }

  const redirectUri = `${origin}/api/auth/callback/google`;

  // Exchange code for tokens.
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: e.GOOGLE_CLIENT_ID || "",
      client_secret: e.GOOGLE_CLIENT_SECRET || "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    return Response.redirect(`${origin}/admin/login?error=token_exchange`, 302);
  }

  const tokens = await tokenRes.json() as any;

  // Get user info.
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) {
    return Response.redirect(`${origin}/admin/login?error=userinfo`, 302);
  }
  const user = await userRes.json() as any;

  // Only an admin email is allowed.
  if (!isAdminEmail(user.email)) {
    return Response.redirect(`${origin}/admin/login?error=not_admin`, 302);
  }

  const session = await createSession(user.email.toLowerCase(), e.BETTER_AUTH_SECRET);
  // Response.redirect() returns immutable headers in Workers; build a fresh
  // Response so the session cookie can be attached.
  const headers = new Headers({ Location: `${origin}/admin` });
  headers.append("Set-Cookie", `admin_session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
  // Route 2 (2026-10-31): also mint a better-auth session so the
  // admin plugin endpoints work from /admin for owner sign-ins.
  const { createBridgeSessionCookie } = await import("../../../../lib/auth");
  const bridge = await createBridgeSessionCookie(user.email, request);
  if (bridge) headers.append("Set-Cookie", bridge);
  return new Response(null, { status: 302, headers });
};
