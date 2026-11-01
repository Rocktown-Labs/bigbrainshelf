import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getEffectiveSession } from "../../lib/auth";
import {
  getPhygitalClaim,
  mintPhygitalClaimToken,
  redeemPhygitalClaim,
} from "../../lib/fulfillment-router";
import { streamToBasinPipeline } from "../../lib/telemetry";

export const prerender = false;

// GET /api/claim?token=...
export const GET: APIRoute = async ({ url }) => {
  const db = (env as any).DB;
  const token = (url.searchParams.get("token") || "").trim();
  if (!token) {
    return Response.json({ error: "token required" }, { status: 400 });
  }
  const claim = await getPhygitalClaim(db, token);
  if (!claim) {
    return Response.json({ error: "Claim code not found" }, { status: 404 });
  }
  return Response.json({ ok: true, claim });
};

// POST /api/claim { action: "redeem" | "mint", token, ... }
export const POST: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const db = e.DB;
  const session = await getEffectiveSession(request, locals, db);
  if (!session?.user?.id || !session?.user?.email) {
    return Response.json({ error: "Please sign in to your family account to claim your book or plush unlock." }, { status: 401 });
  }

  const body: any = await request.json().catch(() => ({}));
  const action = String(body?.action || "redeem");

  if (action === "mint") {
    const isAdmin =
      Boolean((locals as any)?.isAdmin) ||
      (session.user as any)?.role === "admin";
    if (!isAdmin) {
      return Response.json({ error: "Admin access required to mint Phygital tokens" }, { status: 403 });
    }
    const minted = await mintPhygitalClaimToken(db, {
      token: body.token ? String(body.token) : undefined,
      skuType: body.sku_type || "giftset",
      bookSlug: String(body.book_slug || "mastery"),
      characterSlug: body.character_slug ? String(body.character_slug) : null,
      bonusTitle: body.bonus_title ? String(body.bonus_title) : undefined,
    });
    return Response.json({ ok: true, claim: minted });
  }

  const token = String(body?.token || "").trim();
  if (!token) {
    return Response.json({ error: "Claim token is required" }, { status: 400 });
  }

  const res = await redeemPhygitalClaim(db, token, {
    id: String(session.user.id),
    email: String(session.user.email),
  });
  if (!res.ok) {
    return Response.json({ error: res.error || "Could not redeem claim" }, { status: 400 });
  }

  try {
    await streamToBasinPipeline(db, e, {
      tableTarget: "orders_iceberg",
      eventName: "phygital_claimed",
      payload: {
        token,
        bookSlug: res.claim?.book_slug,
        skuType: res.claim?.sku_type,
      },
    });
  } catch {}

  return Response.json(res);
};
