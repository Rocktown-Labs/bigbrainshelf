import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleLuluWebhookPost } from "../../../lib/print-fulfillment";
import { flushOutbox } from "../../../lib/email";

// POST /api/lulu/webhook — Lulu calls this on PRINT_JOB_STATUS_CHANGED.
// HMAC-verified; reachable without a session (see middleware). The
// handler lives in lib/print-fulfillment (handleLuluWebhookPost): it
// records each event before processing, runs the same sync the cron
// poll runs (so parcel emails fire identically from either path),
// and returns 500 on error so Lulu retries. While LULU_WEBHOOK_SECRET
// is unset the handler answers 404 and the endpoint is dark.
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const SITE = e.BETTER_AUTH_URL || "https://bigbrainshelf.com";
  const res = await handleLuluWebhookPost(e.DB, e, request, SITE);
  if (res.ok) {
    // Best effort, mirroring the Stripe webhook: mail the sync just
    // enqueued starts moving now instead of on the next cron tick.
    // A send failure never fails the webhook; rows stay pending.
    await flushOutbox(e.DB, e, 10, SITE).catch(() => {});
  }
  return res;
};
