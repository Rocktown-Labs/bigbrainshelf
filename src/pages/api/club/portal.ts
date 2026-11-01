import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import Stripe from "stripe";
import { getAuth } from "../../../lib/auth";
import { ensureClubTable, getClubSignup } from "../../../lib/club";

// POST /api/club/portal
// The club page's "Manage billing" button: opens the member's Stripe
// billing portal (update card, switch billing details, cancel) and
// redirects the browser there. Built for the Customer Hub fix pass:
// the button shipped pointing at this route before the route
// existed, so paused members had no working way to fix a card.
// Session-gated and keyed to the signed-in member's own signup row;
// the Stripe customer id comes from that row, never from the body.
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const SITE = e.BETTER_AUTH_URL || "https://bigbrainshelf.com";
  const back = `${SITE}/account/club`;

  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/login?next=${encodeURIComponent("/account/club")}` },
    });
  }
  if (!e.STRIPE_SECRET_KEY) {
    return new Response(null, { status: 302, headers: { Location: back } });
  }

  await ensureClubTable(e.DB);
  const email = String(session.user.email || "").trim().toLowerCase();
  const signup = await getClubSignup(e.DB, email).catch(() => null);
  const customerId = signup?.stripe_customer_id ? String(signup.stripe_customer_id) : "";
  if (!customerId) {
    return new Response(null, { status: 302, headers: { Location: back } });
  }

  const stripe = new Stripe(e.STRIPE_SECRET_KEY);
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: back,
  });
  return new Response(null, { status: 302, headers: { Location: portal.url } });
};
