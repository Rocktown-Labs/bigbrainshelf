import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";

// GET /api/uploads?slug=xxx -> list uploaded source docs for a book
export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const slug = url.searchParams.get("slug");
  if (!slug) return Response.json({ error: "slug required" }, { status: 400 });
  const listed = await e.BOOKS.list({ prefix: `uploads/${slug}/` });
  const files = (listed.objects || []).map((o: any) => ({
    key: o.key,
    name: o.key.split("/").pop(),
    size: o.size,
    uploaded: o.uploaded,
  }));
  return Response.json({ files });
};

// POST /api/uploads (multipart: slug, files[]) -> store in R2 under uploads/{slug}/
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const form = await request.formData();
  const slug = String(form.get("slug") || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  if (!slug) return Response.json({ error: "slug required" }, { status: 400 });
  const files = form.getAll("files").filter((f: any) => f && typeof f.arrayBuffer === "function");
  if (!files.length) return Response.json({ error: "no files" }, { status: 400 });
  const saved: string[] = [];
  for (const f of files as any[]) {
    const name = String(f.name || "upload").replace(/[^a-zA-Z0-9._-]+/g, "_");
    const key = `uploads/${slug}/${Date.now()}-${name}`;
    await e.BOOKS.put(key, await f.arrayBuffer(), {
      httpMetadata: { contentType: f.type || "application/octet-stream" },
    });
    saved.push(key);
  }
  return Response.json({ saved });
};
