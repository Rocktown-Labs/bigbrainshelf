import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";

// Change requests from the admin reader. CG flips through the story book,
// flags a page with a note, and the request lands here. For factory-built
// books the matching redo is fired at the factory immediately and the
// request is marked done with the new image/text. For Docker (hand-built),
// requests stay queued for the regeneration pass.

export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const slug = (url.searchParams.get("slug") || "").trim();
  if (!slug) return Response.json({ error: "slug required" }, { status: 400 });
  const { results } = await e.DB.prepare(
    "SELECT * FROM change_requests WHERE book_slug = ? ORDER BY created_at DESC"
  ).bind(slug).all();
  return Response.json(results);
};

async function fireFactoryRedo(e: any, path: string, slug: string, chapterNum: number, pageIndex: number, extra: Record<string, any> = {}) {
  const cfg = await e.DB.prepare("SELECT value FROM settings WHERE key = 'factory_url'").first();
  const factoryUrl = ((cfg?.value as string) || "").replace(/\/+$/, "");
  if (!factoryUrl) throw new Error("factory_url not configured");
  const r = await fetch(`${factoryUrl}/book/${encodeURIComponent(slug)}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chapter: chapterNum, page: pageIndex, ...extra }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `factory ${path} failed`);
  return data;
}

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const b = await request.json().catch(() => ({}));
  const slug = String(b.slug || "").trim();
  const chapterNum = parseInt(b.chapterNum, 10);
  const pageIndex = parseInt(b.pageIndex, 10);
  const kind = ["art", "text", "both"].includes(b.kind) ? b.kind : "art";
  const note = String(b.note || "").slice(0, 1000);
  if (!slug || !(chapterNum >= 0) || !(pageIndex >= 0)) {
    return Response.json({ error: "slug, chapterNum, pageIndex required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  let status = "queued";
  let result = "";

  // chapterNum 0 = the cover. Cover requests never fire a per-page redo;
  // they stay queued for the cover workflow in admin.
  if (slug !== "docker" && chapterNum >= 1) {
    try {
      const outs: any[] = [];
      if (kind === "text" || kind === "both") outs.push(await fireFactoryRedo(e, "redo-text", slug, chapterNum, pageIndex));
      if (kind === "art" || kind === "both") {
        // Per-page fix (CG, 2026-11-02): the note travels with the
        // request and becomes art direction; the factory redoes this
        // one page (line + color) in a workflow and writes the final
        // status back into this row when it lands.
        outs.push(await fireFactoryRedo(e, "page-fix", slug, chapterNum, pageIndex, { note, requestId: id }));
        status = "in_progress";
      } else {
        status = "done";
      }
      result = JSON.stringify(outs);
    } catch (err: any) {
      status = "queued";
      result = "factory redo failed, queued: " + String(err?.message || err);
    }
  }

  await e.DB.prepare(
    "INSERT INTO change_requests (id, book_slug, chapter_num, page_index, kind, note, status, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, slug, chapterNum, pageIndex, kind, note, status, result, now, now).run();

  return Response.json({ ok: true, id, status });
};
