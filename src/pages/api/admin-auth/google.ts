import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";

// Step 1: Redirect to Google OAuth.
export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const clientId = e?.GOOGLE_CLIENT_ID || "";
  // Origin-derived so sign-in works on whichever domain serves the
  // store (bigbrainshelf.com canonical, bookstore.rocktownlabs.app
  // legacy). Each origin's callback URI must be registered in the
  // Google Cloud Console.
  const redirectUri = `${url.origin}/api/auth/callback/google`;

  // CSRF state token (simple random, validated loosely on callback).
  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });

  const resp = new Response(null, { status: 302 });
  resp.headers.set("Location", `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  resp.headers.set(
    "Set-Cookie",
    `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  return resp;
};
