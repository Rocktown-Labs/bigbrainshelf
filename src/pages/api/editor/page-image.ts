import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { adminMediaUrl } from '../../../lib/media';

// POST /api/editor/page-image (multipart: slug, chapter, page, file)
// Stores {slug}/{chapter}-page-{page}-r{ts}.jpg in R2 (never overwrites;
// the editor caches images by URL). Returns the R2 key + the
// admin-gated media URL for it (the bucket's public domain is off).
// Admin-gated by the middleware (requires admin_session cookie).
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const form = await request.formData();
  const slug = String(form.get("slug") || "").trim().toLowerCase();
  const chapter = String(form.get("chapter") || "").trim().toUpperCase();
  const page = Number(form.get("page"));
  if (!/^[a-z0-9-]+$/.test(slug) || !/^S\d+$/.test(chapter) || !Number.isInteger(page) || page < 0) {
    return Response.json({ error: "slug, chapter (S#), page (0-based) required" }, { status: 400 });
  }
  const file = form.get("file") as any;
  if (!file || typeof file.arrayBuffer !== "function") {
    return Response.json({ error: "file required" }, { status: 400 });
  }
  const buf = await file.arrayBuffer();
  if (buf.byteLength > 8 * 1024 * 1024) {
    return Response.json({ error: "file too large (8MB max)" }, { status: 400 });
  }
  const key = `${slug}/${chapter}-page-${page}-r${Date.now()}.jpg`;
  await e.BOOKS.put(key, buf, { httpMetadata: { contentType: "image/jpeg" } });
  return Response.json({
    key,
    url: adminMediaUrl(key),
  });
};
