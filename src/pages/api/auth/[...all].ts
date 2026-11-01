import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getAuth, ensureAuthUserSchema } from "../../../lib/auth";

// Better-auth handler: customer signup/signin/sessions for the storefront.
// Note: /api/auth/callback/google is the admin Google OAuth route (a more
// specific file route, so Astro sends that path there, not here).
export const ALL: APIRoute = async ({ request }) => {
  const e = env as any;
  if (e?.DB) {
    await ensureAuthUserSchema(e.DB).catch(() => {});
  }
  const auth = getAuth();
  return auth.handler(request);
};
