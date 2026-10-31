import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { ensureReviewsTable, reviewMediaKey } from "../../../lib/reviews";
import { contentTypeForKey } from "../../../lib/character-sheets";

// GET /api/admin/review-media?review=<id>&which=<photo index|video>
//
// Admin-only preview of review attachments in ANY status, so the
// moderation queue can show pending photos and videos before a decision.
// The public twin (/api/review-media) serves approved reviews only.
export const GET: APIRoute = async ({ url, locals }) => {
  if (!(locals as any)?.user) return new Response("Unauthorized", { status: 401 });
  const e = env as any;
  const id = String(url.searchParams.get("review") || "").trim();
  const which = String(url.searchParams.get("which") || "").trim();
  if (!id || !which) return new Response("Not found", { status: 404 });

  await ensureReviewsTable(e.DB);
  const review = await e.DB.prepare("SELECT * FROM reviews WHERE id = ?").bind(id).first();
  if (!review) return new Response("Not found", { status: 404 });

  const key = reviewMediaKey(review, which);
  if (!key) return new Response("Not found", { status: 404 });
  const obj = await e.BOOKS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  return new Response(obj.body, {
    headers: {
      "Content-Type": contentTypeForKey(key, obj.httpMetadata?.contentType),
      "Cache-Control": "private, no-store",
    },
  });
};
