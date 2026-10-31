import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";

// POST /api/generate { slug } -> queue the book for autonomous generation.
// The factory worker's cron picks up `queued` books and runs the full
// BookBuildWorkflow (extract -> split -> bookinfo -> bible -> plan ->
// images -> assemble -> register). Idempotent: re-queueing a queued or
// building book is a no-op.
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const db = e.DB;
  const body = await request.json().catch(() => ({}));
  const slug = String(body.slug || "").trim();
  if (!slug) return Response.json({ error: "slug required" }, { status: 400 });

  const book = await db.prepare("SELECT slug, status FROM books WHERE slug = ?").bind(slug).first();
  if (!book) return Response.json({ error: "book not found" }, { status: 404 });

  // Need at least one source document.
  const listed = await e.BOOKS.list({ prefix: `uploads/${slug}/` });
  const objects: any[] = listed.objects || [];
  if (!objects.length) {
    return Response.json({ error: "No source documents uploaded yet." }, { status: 400 });
  }

  if (book.status === "queued" || book.status === "building") {
    return Response.json({ queued: true, already: book.status });
  }

  const now = Date.now();
  await db.prepare(
    "UPDATE books SET status = 'queued', stage = 'extract', stage_detail = '', updated_at = ? WHERE slug = ?"
  ).bind(now, slug).run();

  return Response.json({ queued: true });
};
