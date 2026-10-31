import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { ensureReviewsTable, reviewMediaKey } from "../../lib/reviews";
import { contentTypeForKey } from "../../lib/character-sheets";

// GET /api/review-media?review=<id>&which=<photo index|video>
//
// Public review media. Serves an attachment ONLY when its review is
// approved: pending and rejected reviews' photos and videos are never
// reachable here, and the admin preview lives behind the admin gate in
// /api/admin/review-media.
export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const id = String(url.searchParams.get("review") || "").trim();
  const which = String(url.searchParams.get("which") || "").trim();
  if (!id || !which) return new Response("Not found", { status: 404 });

  await ensureReviewsTable(e.DB);
  const review = await e.DB.prepare("SELECT * FROM reviews WHERE id = ?").bind(id).first();
  if (!review || review.status !== "approved") return new Response("Not found", { status: 404 });

  const key = reviewMediaKey(review, which);
  if (!key) return new Response("Not found", { status: 404 });
  const obj = await e.BOOKS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  return new Response(obj.body, {
    headers: {
      "Content-Type": contentTypeForKey(key, obj.httpMetadata?.contentType),
      "Cache-Control": "public, max-age=86400",
    },
  });
};
