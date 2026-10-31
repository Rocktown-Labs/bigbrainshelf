import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

// POST /api/editor/redo-text { slug, chapterNum, pageIndex } ->
// asks the factory to regenerate that page's story text with full context
// (bible, ladder entry, story-so-far, neighbors), then clears the approval.
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const db = e.DB;
  const b = await request.json().catch(() => ({}));
  const slug = String(b.slug || "").trim();
  const chapterNum = parseInt(b.chapterNum, 10);
  const pageIndex = parseInt(b.pageIndex, 10);
  if (!slug || !(chapterNum >= 1) || !(pageIndex >= 0)) {
    return Response.json({ error: "slug, chapterNum, pageIndex required" }, { status: 400 });
  }

  const cfg = await db.prepare("SELECT value FROM settings WHERE key = 'factory_url'").first();
  const factoryUrl = ((cfg?.value as string) || "").replace(/\/+$/, "");
  if (!factoryUrl) return Response.json({ error: "factory_url not configured" }, { status: 400 });

  let r: Response;
  try {
    r = await fetch(`${factoryUrl}/book/${encodeURIComponent(slug)}/redo-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapter: chapterNum, page: pageIndex }),
    });
  } catch (err: any) {
    return Response.json({ error: "factory unreachable: " + String(err?.message || err) }, { status: 502 });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return Response.json({ error: data.error || "redo failed" }, { status: 502 });

  // A redone page is no longer approved.
  await db.prepare(
    `INSERT INTO page_approvals (book_slug, chapter_num, page_index, approved, approved_at)
     VALUES (?, ?, ?, 0, NULL)
     ON CONFLICT (book_slug, chapter_num, page_index) DO UPDATE SET approved=0, approved_at=NULL`
  ).bind(slug, chapterNum, pageIndex).run();

  return Response.json({ ok: true, text: data.text });
};
