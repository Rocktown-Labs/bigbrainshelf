import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { validateEmail, INVALID_EMAIL_MESSAGE } from "../../lib/email-validate";
import { turnstileEnforced, verifyTurnstileToken, TURNSTILE_FAILED_MESSAGE } from "../../lib/turnstile";
import { enqueueEmail } from "../../lib/orders";

// POST /api/contact { name, email, message, turnstile_token? }
// The site's contact form (CG, 2026-10-31: it must actually
// reach us). Enqueues one outbox email to the owner's inbox
// with the sender as reply-to, so answering is one click. The
// outbox sends it from orders@bigbrainshelf.com. Public route
// (middleware-whitelisted next to /api/subscribe); Turnstile
// enforced when configured, exactly like subscribe.
const CONTACT_FORWARD_TO = "rocktownlabs@gmail.com";

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  let body: any = {};
  try { body = await request.json(); } catch { /* validation below handles it */ }
  const name = String(body?.name || "").trim().slice(0, 120);
  const email = String(body?.email || "").trim();
  const message = String(body?.message || "").trim().slice(0, 5000);
  if (!validateEmail(email).ok) {
    return Response.json({ ok: false, error: INVALID_EMAIL_MESSAGE }, { status: 400 });
  }
  if (message.length < 3) {
    return Response.json({ ok: false, error: "Please write a short message so we know how to help." }, { status: 400 });
  }
  if (turnstileEnforced(e)) {
    const token = body?.turnstile_token ?? body?.["cf-turnstile-response"];
    const verified = await verifyTurnstileToken(e, token, request.headers.get("CF-Connecting-IP"));
    if (!verified) {
      return Response.json({ ok: false, error: TURNSTILE_FAILED_MESSAGE }, { status: 403 });
    }
  }
  await enqueueEmail(e.DB, {
    orderId: null,
    kind: "contact_form",
    to: CONTACT_FORWARD_TO,
    subject: `Contact form: ${name || email}`,
    text:
      `New message from the Big Brain Shelf contact form.\n\n` +
      `From: ${name || "(no name)"} <${email}>\n\n` +
      `${message}\n`,
    replyTo: email,
  });
  return Response.json({ ok: true });
};
