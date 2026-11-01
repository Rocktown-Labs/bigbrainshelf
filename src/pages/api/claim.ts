import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getEffectiveSession } from "../../lib/auth";
import { getPhygitalClaim, redeemPhygitalClaim } from "../../lib/fulfillment-router";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const token = (url.searchParams.get("token") || "").trim();
  const claim = await getPhygitalClaim(e.DB, token);
  if (!claim) {
    return Response.json({ ok: false, error: "Claim token not found" }, { status: 404 });
  }
  return Response.json({ ok: true, claim });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const session = await getEffectiveSession(request, locals, e.DB);
  const body = (await request.json().catch(() => ({}))) as Record<string, any>;

  const token = String(body.token || "").trim();
  const email = String(body.email || session?.user?.email || "").trim();

  const res = await redeemPhygitalClaim(e.DB, {
    token,
    userId: session?.user?.id ? String(session.user.id) : null,
    email,
  });

  if (!res.ok) {
    return Response.json({ ok: false, error: res.reason || "Unable to redeem token" }, { status: 400 });
  }
  return Response.json({ ok: true, claim: res.claim });
};
