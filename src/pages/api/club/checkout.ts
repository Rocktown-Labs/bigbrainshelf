import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import Stripe from "stripe";
import { getAuth } from "../../../lib/auth";
import {
  ensureClubTable,
  upsertClubReservation,
  getClubSignup,
  clubPlanOf,
  isShelf,
  type ClubPlanId,
} from "../../../lib/club";
import {
  clubSignupStatus,
  CLUB_PRICE_CENTS,
  CLUB_ANNUAL_PRICE_CENTS,
  AUDIO_CLUB_PRICE_CENTS,
  AUDIO_CLUB_ANNUAL_PRICE_CENTS,
} from "../../../lib/offers";

// POST /api/club/checkout { name, shelf, plan, club_plan } -> { url }
// Starts a club membership: a Stripe Checkout SUBSCRIPTION at the
// plan's price (src/lib/offers.ts). Two plans (club_plan):
//
//   physical  the Book Club: printed sets quarterly + all-access
//             digital while active. Billing period plan is
//             quarterly | annual. The member cap applies.
//   audio     the Audio Club: every audiobook in the library while
//             active, nothing else. Billing period plan is
//             monthly | annual. No member cap, no boxes.
//
// Membership requires a store account, no guest checkout: the account
// is where the member's library and grants live. The signup row is
// keyed to the SESSION user (id + account email); nothing in the
// request body can name a different member. The row is written as a
// reservation first; only the Stripe webhook marks it paid (see
// lib/club.ts activateClubFromSession, which records both the plan
// dimension and the billing period from session metadata).
//
// No member cap (CG, 2026-10-31): joining is open to whoever checks
// out, physical and audio alike.

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const SITE = e.BETTER_AUTH_URL || "https://bigbrainshelf.com";
  // Auth first, before any config or payload handling: an anonymous
  // caller gets 401 no matter what state the server is in, and never
  // creates a reservation or a checkout session.
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json(
      { error: "Create your account or sign in to join the Book Club.", needsAccount: true },
      { status: 401 }
    );
  }
  // SECURITY (F1): club rows are keyed by email, and paid join drives
  // upsertClubReservation, which writes this session's user_id onto
  // the existing row for the address. The email-keyed claim requires a
  // verified inbox, so registering someone else's address can neither
  // see nor subscribe over their membership.
  if ((session.user as any).emailVerified !== true) {
    return Response.json(
      {
        error: "Verify your email first (check your inbox for the verification link) to join the club.",
        needsVerification: true,
      },
      { status: 403 }
    );
  }
  if (!e.STRIPE_SECRET_KEY) {
    return Response.json({ error: "Checkout is not configured yet." }, { status: 503 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* validation below */ }
  const clubPlan: ClubPlanId = body?.club_plan === "audio" ? "audio" : "physical";
  // Billing period: physical bills quarterly or annually; audio bills
  // monthly or annually. Anything unrecognized falls back to the
  // plan's default period, as the pre-Audio-Club endpoint did.
  const period =
    body?.plan === "annual"
      ? "annual"
      : clubPlan === "audio"
        ? "monthly"
        : body?.plan === "monthly"
          ? "monthly"
          : "quarterly";
  const email = String(session.user.email || "").trim().toLowerCase();

  await ensureClubTable(e.DB);
  const existing = await getClubSignup(e.DB, email);

  // The starting shelf drives the physical club's first box, but the
  // plans page no longer asks visitors to pick one before subscribing
  // (owner, 2026-10-29): members configure their offering after
  // joining, in their account. Like the Audio Club (no boxes, no
  // shelf pick), a missing or invalid pick reuses the member's
  // existing shelf when there is one, else the default, just to fill
  // the ledger's NOT NULL column. An explicit valid shelf in the body
  // is still honored for older clients.
  let shelf = String(body?.shelf || "").trim().toLowerCase();
  if (!isShelf(shelf)) {
    shelf = existing?.shelf && isShelf(String(existing.shelf)) ? String(existing.shelf) : "tech";
  }
  const name =
    String(body?.name || "").trim().slice(0, 120) ||
    String((session.user as any).name || "").trim() ||
    email.split("@")[0];

  // A paid member of the SAME plan is done. A paid Book Club member
  // asking for audio is also done: the Book Club already includes
  // every audiobook. The one live path through this guard is the
  // upgrade CG ruled on 2026-10-31: a paid AUDIO member joining the
  // Book Club. Their row keeps saying "audio" until the upgrade's
  // webhook activation flips it (the reservation below passes no
  // clubPlan, so an abandoned upgrade checkout changes nothing), and
  // activation cancels the old Audio subscription in Stripe.
  const existingPlan: ClubPlanId | null =
    existing?.status === "paid" ? clubPlanOf(existing) : null;
  if (existingPlan === clubPlan || (existingPlan === "physical" && clubPlan === "audio")) {
    return Response.json({ ok: true, alreadyMember: true });
  }
  const isUpgrade = existingPlan === "audio" && clubPlan === "physical";
  const signup = await upsertClubReservation(e.DB, {
    name,
    email,
    shelf,
    status: existing?.status || clubSignupStatus(),
    userId: session.user.id,
    clubPlan: isUpgrade ? null : clubPlan,
  });

  let priceCents: number;
  let recurring: { interval: "month" | "year"; interval_count?: number };
  let productName: string;
  let productDescription: string;
  if (clubPlan === "audio") {
    priceCents = period === "annual" ? AUDIO_CLUB_ANNUAL_PRICE_CENTS : AUDIO_CLUB_PRICE_CENTS;
    recurring = period === "annual" ? { interval: "year" } : { interval: "month" };
    productName =
      period === "annual" ? "Big Brain Shelf Audio Club (Annual)" : "Big Brain Shelf Audio Club";
    productDescription =
      "Every Big Brain Shelf audiobook in your library while your membership is active: listen in the reader, as much as you like. Listening only; no printed sets ship on this plan.";
  } else {
    priceCents = period === "annual" ? CLUB_ANNUAL_PRICE_CENTS : CLUB_PRICE_CENTS;
    recurring =
      period === "annual"
        ? { interval: "year" }
        : { interval: "month", interval_count: 3 };
    productName =
      period === "annual" ? "Big Brain Shelf Book Club (Annual)" : "Big Brain Shelf Book Club";
    productDescription =
      "A printed set each quarter: the full color storybook plus its printed coloring book, with a bonus back catalog coloring book and the digital editions in your library. Shipping included.";
  }
  const meta = {
    club: "1",
    club_signup_id: signup.id,
    club_plan: clubPlan,
    user_id: session.user.id,
    email,
    name,
    shelf,
    plan: period,
  };
  const taxEnabled =
    String(e.TAX_ENABLED || "").toLowerCase() === "1" ||
    String(e.TAX_ENABLED || "").toLowerCase() === "true";
  const sessionParams: any = {
    mode: "subscription",
    customer_email: email,
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: priceCents,
          recurring,
          product_data: {
            name: productName,
            description: productDescription,
          },
        },
        quantity: 1,
      },
    ],
    metadata: meta,
    subscription_data: { metadata: meta },
    // In-account joins (return_to: "account") come back to the club
    // page inside the account, never the public join page (CG's hub
    // brief, 2026-11-01). Public /clubs joins keep the public URLs.
    success_url:
      body?.return_to === "account" ? `${SITE}/account/club?joined=1` : `${SITE}/clubs?joined=1`,
    cancel_url:
      body?.return_to === "account" ? `${SITE}/account/club?join=cancelled` : `${SITE}/clubs?join=cancelled`,
  };
  if (taxEnabled) sessionParams.automatic_tax = { enabled: true };
  // The Book Club ships boxes from day one, so its checkout collects
  // the shipping address (CG's club fix, 2026-10-31: members who had
  // never bought a printed book had a first box due with no address
  // anywhere). Activation stores it on the signup row from
  // session.shipping_details. Audio collects nothing: nothing ships.
  if (clubPlan === "physical") {
    sessionParams.shipping_address_collection = { allowed_countries: ["US"] };
  }

  const stripe = new Stripe(e.STRIPE_SECRET_KEY);
  const hour = Math.floor(Date.now() / 3600000);
  const checkout = await stripe.checkout.sessions.create(sessionParams, {
    idempotencyKey: `club_${signup.id}_${clubPlan}_${period}_${hour}`,
  });
  // No cron on this worker: due outbox rows flush on store events.
  try {
    const { flushOutbox } = await import("../../../lib/email");
    await flushOutbox(e.DB, e, 10, SITE);
  } catch { /* joining must never fail on email plumbing */ }
  return Response.json({ url: checkout.url });
};
