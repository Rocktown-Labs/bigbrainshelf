import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import Stripe from "stripe";
import { getAuth } from "../../../lib/auth";
import { ensureClubTable, getClubSignup, clubPlanOf } from "../../../lib/club";

// POST /api/club/downgrade { action: "schedule" | "undo", plan? }
//
// The downgrade path (CG, 2026-11-01: the club page is where members
// manage everything). A paid Book Club member schedules a switch to
// The Audio Club: Stripe sets cancel_at_period_end on the Book Club
// subscription, so the member keeps every Book Club benefit until
// the day they already paid for, and the signup row remembers the
// intent. When the subscription actually ends, the webhook's
// cancelClubBySubscription sees the intent and sends the switch
// email (club_downgrade_ready) instead of a cancellation note; the
// member then starts The Audio Club from this same page in one tap.
// Undo clears cancel_at_period_end in Stripe and the intent locally.
//
// Keyed to the SESSION user's signup row (looked up by account
// email, the club system's own key), never to body identifiers.
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "Sign in to manage your membership." }, { status: 401 });
  }
  if (!e.STRIPE_SECRET_KEY) {
    return Response.json({ error: "Membership changes are not configured yet." }, { status: 503 });
  }
  let body: any = {};
  try { body = await request.json(); } catch { /* validation below */ }
  const action = body?.action === "undo" ? "undo" : "schedule";
  const period = body?.plan === "annual" ? "annual" : "monthly";

  await ensureClubTable(e.DB);
  const email = String(session.user.email || "").trim().toLowerCase();
  const signup: any = await getClubSignup(e.DB, email).catch(() => null);
  if (!signup || signup.status !== "paid" || clubPlanOf(signup) !== "physical") {
    return Response.json(
      { error: "Only a Book Club member can schedule a switch to The Audio Club." },
      { status: 400 }
    );
  }
  const subscriptionId = signup.stripe_subscription_id ? String(signup.stripe_subscription_id) : "";
  if (!subscriptionId) {
    return Response.json({ error: "We could not find your subscription. Use Manage billing instead." }, { status: 400 });
  }

  const stripe = new Stripe(e.STRIPE_SECRET_KEY);
  try {
    if (action === "undo") {
      await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
      await e.DB.prepare(
        "UPDATE club_signups SET downgrade_to_audio_at = NULL, downgrade_audio_period = NULL WHERE id = ?"
      )
        .bind(signup.id)
        .run();
      return Response.json({ ok: true, scheduled: false });
    }
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const periodEnd = Number((sub as any).current_period_end || 0);
    if (!periodEnd) {
      return Response.json({ error: "We could not read your current billing period. Use Manage billing instead." }, { status: 502 });
    }
    await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
    await e.DB.prepare(
      "UPDATE club_signups SET downgrade_to_audio_at = ?, downgrade_audio_period = ? WHERE id = ?"
    )
      .bind(periodEnd, period, signup.id)
      .run();
    return Response.json({ ok: true, scheduled: true, endsAt: periodEnd, period });
  } catch (err: any) {
    return Response.json(
      { error: "Stripe could not update your membership. Please try again in a moment." },
      { status: 502 }
    );
  }
};
