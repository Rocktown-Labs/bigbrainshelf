import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { recordOptOutByToken } from "../../lib/marketing";

// GET|POST /api/unsubscribe?token=... — the opt-out link carried by
// every marketing email (the newsletter, release announcements, the
// day-3 club follow-up). Records
// the address in marketing_opt_outs; the follow-up enqueue and the
// outbox flush both respect it. Transactional order mail is unaffected:
// opting out never touches confirmations or shipping updates.
//
// The response is a small self-contained page (inline styles on
// purpose; it must render even if the storefront CSS is mid-deploy).

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · Big Brain Shelf</title>
</head>
<body style="margin:0;background:#faf9f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1917;">
<main style="max-width:520px;margin:48px auto;padding:0 20px;">
  <div style="background:#1a3454;border-radius:12px 12px 0 0;padding:18px 28px;border-bottom:4px solid #fb923c;">
    <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:1.5px;">BIG <span style="color:#fb923c;">BRAIN</span> SHELF</span>
  </div>
  <div style="background:#ffffff;border:1px solid #e7e5e4;border-top:none;border-radius:0 0 12px 12px;padding:28px;">
    ${body}
    <p style="margin:24px 0 0;"><a href="https://bigbrainshelf.com" style="color:#1a3454;font-weight:600;">Back to Big Brain Shelf</a></p>
  </div>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function handle(request: Request): Promise<Response> {
  const e = env as any;
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!token) {
    return page(
      "Unsubscribe",
      `<h1 style="font-size:20px;margin:0 0 12px;">That link looks incomplete</h1>
       <p style="line-height:24px;margin:0;">The unsubscribe link seems to be missing its code. Use the link at the bottom of the email itself, and it will work in one click.</p>`
    );
  }
  try {
    const email = await recordOptOutByToken(e.DB, token);
    if (email) {
      return page(
        "Unsubscribed",
        `<h1 style="font-size:20px;margin:0 0 12px;">You are unsubscribed</h1>
         <p style="line-height:24px;margin:0;">${email} will not get new release news or other marketing email from us. Order confirmations and shipping updates for anything you buy will still arrive as usual.</p>`
      );
    }
  } catch {
    /* fall through to the not-matched page */
  }
  return page(
    "Unsubscribe",
    `<h1 style="font-size:20px;margin:0 0 12px;">We could not match that link</h1>
     <p style="line-height:24px;margin:0;">That unsubscribe link does not match an address on our list. If you keep getting news emails you do not want, reply to the email and we will sort it out.</p>`
  );
}

export const GET: APIRoute = async ({ request }) => handle(request);
export const POST: APIRoute = async ({ request }) => handle(request);
