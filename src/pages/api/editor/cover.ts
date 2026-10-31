import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

// POST /api/editor/cover (multipart: slug, file) -> stores books/{slug}/cover.jpg in R2, updates books.cover_key.
// Admin-gated by the middleware (requires admin_session cookie).
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const form = await request.formData();
  const slug = String(form.get("slug") || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  if (!slug) return Response.json({ error: "slug required" }, { status: 400 });
  const file = form.get("file") as any;
  if (!file || typeof file.arrayBuffer !== "function") {
    return Response.json({ error: "file required" }, { status: 400 });
  }
  const buf = await file.arrayBuffer();
  if (buf.byteLength > 8 * 1024 * 1024) {
    return Response.json({ error: "file too large (8MB max)" }, { status: 400 });
  }
  const type = String(file.type || "");
  const contentType = type.startsWith("image/") ? type : "image/jpeg";
  const key = `books/${slug}/cover.jpg`;
  await e.BOOKS.put(key, buf, { httpMetadata: { contentType } });
  await e.DB.prepare("UPDATE books SET cover_key = ?, updated_at = ? WHERE slug = ?")
    .bind(key, Math.floor(Date.now() / 1000), slug).run();
  return Response.json({ key });
};
