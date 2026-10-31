import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { addSubscriber, validateEmail, INVALID_EMAIL_MESSAGE } from "../../lib/email-validate";
import { turnstileEnforced, verifyTurnstileToken, TURNSTILE_FAILED_MESSAGE } from "../../lib/turnstile";

// POST /api/subscribe { email, source?, name?, turnstile_token? }
//   -> { ok: true, already?: boolean }
// Public by design (whitelisted in middleware.ts next to the Stripe
// webhook). Adds the address to the free NEWSLETTER list in the D1
// `subscribers` table (new release announcements; the release wave 2
// in lib/releases.ts reads this list). This is not the paid Book
// Club: club membership lives in club_signups. Validation is strict
// and lives in lib/email-validate.ts; an invalid address gets a 400
// and no row is written. The optional name is stored on the row.
//
// Bot check: when TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY are both
// set on the worker, Cloudflare Turnstile is enforced (lib/
// turnstile.ts): a missing or unverified token gets a 403 and no row
// is written. With no keys set, the form behaves as it always has.

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const db = e.DB;
  let body: any = {};
  try { body = await request.json(); } catch { /* handled by validation below */ }
  if (!validateEmail(body?.email).ok) {
    return Response.json(
      { ok: false, error: INVALID_EMAIL_MESSAGE },
      { status: 400 }
    );
  }
  if (turnstileEnforced(e)) {
    const token = body?.turnstile_token ?? body?.["cf-turnstile-response"];
    const verified = await verifyTurnstileToken(
      e,
      token,
      request.headers.get("CF-Connecting-IP")
    );
    if (!verified) {
      return Response.json(
        { ok: false, error: TURNSTILE_FAILED_MESSAGE },
        { status: 403 }
      );
    }
  }
  const result = await addSubscriber(db, body?.email, body?.source, body?.name);
  if (!result.ok) {
    return Response.json(
      { ok: false, error: INVALID_EMAIL_MESSAGE },
      { status: 400 }
    );
  }
  // The worker has no cron, so due outbox rows (the day-3 club
  // follow-up) flush on store events like this one. Best effort only.
  try {
    const { flushOutbox } = await import("../../lib/email");
    await flushOutbox(db, e, 10, e.BETTER_AUTH_URL || "https://bigbrainshelf.com");
  } catch { /* subscribing must never fail on email plumbing */ }
  return Response.json({ ok: true, already: result.already });
};
