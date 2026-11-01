import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

// GET /api/order-download?token=&slug=&format=...
// Legacy emailed download links. This route used to serve the book
// files directly to anyone holding the order's delivery token. CG's
// ruling (2026-10-31): emailed links must be auth-backed, so the
// files now live only behind the signed-in library (/api/download,
// entitlement-checked and buyer-stamped). This endpoint validates
// the token exactly as before, then redirects into the library:
// a signed-in buyer lands on their books; a signed-out one lands on
// the sign-in page with their library one sign-in away (guest buyers
// also get a one-click sign-in link by email at checkout). Old
// emails keep working as a route in, but no link is a bearer
// credential for the files anymore.
export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const token = String(url.searchParams.get("token") || "");
  const slug = String(url.searchParams.get("slug") || "");
  if (!token || !slug) {
    return Response.json({ error: "token and slug required" }, { status: 400 });
  }

  const order = await e.DB.prepare(
    "SELECT id, book_slugs FROM orders WHERE delivery_token = ? AND status = 'complete'"
  ).bind(token).first() as any;
  if (!order) return Response.json({ error: "Download link not recognized." }, { status: 404 });

  let owned: string[] = [];
  try { owned = JSON.parse(order.book_slugs || "[]").map(String); } catch { /* ignore */ }
  if (!owned.includes(slug)) {
    return Response.json({ error: "That book is not part of this order." }, { status: 403 });
  }

  return new Response(null, {
    status: 302,
    headers: { Location: "/account", "Cache-Control": "private, no-store" },
  });
};
