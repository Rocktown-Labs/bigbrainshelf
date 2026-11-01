import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import Stripe from "stripe";
import {
  recordWebhookEvent,
  markWebhookEventProcessed,
  processCheckoutCompleted,
  expireOrderBySession,
} from "../../../lib/orders";
import {
  activateClubFromSession,
  cancelClubBySubscription,
  updateClubSubscriptionStatus,
  recordClubInvoicePayment,
} from "../../../lib/club";
import { enqueueClubFollowup } from "../../../lib/marketing";
import { flushOutbox } from "../../../lib/email";
import { routePhysicalOrderFulfillment } from "../../../lib/fulfillment-router";
import { streamToBasinPipeline } from "../../../lib/telemetry";

// POST /api/stripe/webhook — Stripe calls this after checkout.
// Signature-verified; reachable without a session (see middleware).
//
// Idempotent end to end: the event id is recorded before processing and a
// fully processed event is never processed twice; orders converge on the
// Stripe session id; the confirmation email is enqueued at most once per
// order (email_outbox unique index) and marked sent only on acceptance.
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  if (!e.STRIPE_SECRET_KEY || !e.STRIPE_WEBHOOK_SECRET) {
    return new Response("webhook not configured", { status: 503 });
  }
  const SITE = e.BETTER_AUTH_URL || "https://bigbrainshelf.com";
  const stripe = new Stripe(e.STRIPE_SECRET_KEY);
  const sig = request.headers.get("stripe-signature") || "";
  const body = await request.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, e.STRIPE_WEBHOOK_SECRET);
  } catch {
    return new Response("bad signature", { status: 400 });
  }

  const seen = await recordWebhookEvent(e.DB, { id: event.id, type: event.type });
  if (seen === "duplicate") {
    return new Response("ok (duplicate)");
  }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object as Stripe.Checkout.Session;
      if ((s.metadata as any)?.club === "1" || s.mode === "subscription") {
        // Book Club membership: activate (or upgrade the founding
        // reservation) instead of completing a store order.
        if (s.payment_status === "paid") {
          await activateClubFromSession(e.DB, s);
          await markWebhookEventProcessed(e.DB, event.id, "club membership activated");
        } else {
          await markWebhookEventProcessed(e.DB, event.id, `club ignored: payment_status=${s.payment_status}`);
        }
      } else if (s.payment_status === "paid") {
        const order = await processCheckoutCompleted(e.DB, SITE, s);
        // Book Club funnel (Workstream 3): schedule the day-3 follow-up
        // from news@ for buyers who are not paid members and have not
        // unsubscribed. Marketing must never break an order, so any
        // failure here is logged and swallowed; the outbox's unique
        // (order_id, kind) index keeps replays to one row regardless.
        if (order) {
          try {
            await enqueueClubFollowup(e.DB, SITE, order);
          } catch (err: any) {
            console.error("club followup enqueue failed", err?.message || err);
          }
          try {
            await routePhysicalOrderFulfillment(e.DB, order as any);
          } catch (err: any) {
            console.error("fulfillment router failed", err?.message || err);
          }
          try {
            await streamToBasinPipeline(e.DB, e, {
              tableTarget: "orders_iceberg",
              eventName: "order_completed",
              payload: {
                orderId: (order as any).id,
                amountCents: (order as any).amount,
                bookSlugs: (order as any).book_slugs,
              },
            });
          } catch {}
        }
        // Best effort: email delivery must never fail the webhook. If the
        // send cannot happen (no email transport configured yet), rows
        // stay pending in the outbox and go out on a later flush.
        await flushOutbox(e.DB, e, 10, SITE).catch(() => {});
        await markWebhookEventProcessed(e.DB, event.id, "order completed, confirmation enqueued");
      } else {
        await markWebhookEventProcessed(e.DB, event.id, `ignored: payment_status=${s.payment_status}`);
      }
    } else if (event.type === "checkout.session.expired") {
      const s = event.data.object as Stripe.Checkout.Session;
      await expireOrderBySession(e.DB, s.id);
      await markWebhookEventProcessed(e.DB, event.id, "pending order expired");
    } else if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      await cancelClubBySubscription(e.DB, sub.id);
      await markWebhookEventProcessed(e.DB, event.id, "club membership canceled (subscription deleted)");
    } else if (event.type === "customer.subscription.updated") {
      const sub = event.data.object as Stripe.Subscription;
      // Book Club V2: track every subscription status on the member row
      // (cycle generation and locking read subscription_status), and
      // cancel the membership outright on terminal states.
      const result = await updateClubSubscriptionStatus(e.DB, sub);
      await markWebhookEventProcessed(
        e.DB,
        event.id,
        result.canceled
          ? `club membership canceled (subscription ${sub.status})`
          : result.tracked
            ? `club subscription status tracked: ${sub.status}`
            : `subscription status ${sub.status} (no club member)`
      );
    } else if (event.type === "invoice.payment_failed") {
      // Book Club V2 billing health: a failed renewal parks the member
      // as past_due, which pauses cycle generation and locking, so no
      // box ships on a membership that is not paying.
      const invoice = event.data.object as Stripe.Invoice;
      const tracked = await recordClubInvoicePayment(e.DB, invoice, "failed");
      await markWebhookEventProcessed(
        e.DB,
        event.id,
        tracked ? "club member marked past_due (invoice payment failed)" : "invoice payment failed (no club member)"
      );
    } else if (event.type === "invoice.payment_succeeded" || event.type === "invoice.paid") {
      const invoice = event.data.object as Stripe.Invoice;
      const tracked = await recordClubInvoicePayment(e.DB, invoice, "paid");
      await markWebhookEventProcessed(
        e.DB,
        event.id,
        tracked ? "club member billing restored (invoice paid)" : "invoice paid (no club member)"
      );
    } else {
      await markWebhookEventProcessed(e.DB, event.id, "ignored event type");
    }
  } catch (err: any) {
    // Leave processed_at null so a Stripe retry re-runs the (idempotent)
    // processing instead of being skipped as a duplicate.
    console.error("webhook processing failed", event.id, err?.message || err);
    return new Response("processing error", { status: 500 });
  }
  return new Response("ok");
};
