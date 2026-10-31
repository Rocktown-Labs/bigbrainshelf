import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";

// GET /api/generation-status?slug=xxx -> latest job + live factory workflow status
export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const db = e.DB;
  const slug = url.searchParams.get("slug");
  if (!slug) return Response.json({ error: "slug required" }, { status: 400 });

  const job = await db.prepare(
    "SELECT * FROM generation_jobs WHERE book_slug = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(slug).first();
  if (!job) return Response.json({ job: null });

  let live: any = null;
  let liveError: string | null = null;
  const cfg = await db.prepare("SELECT value FROM settings WHERE key = 'factory_url'").first();
  const factoryUrl = (cfg?.value || "").replace(/\/+$/, "");
  if (factoryUrl && job.instance_id) {
    try {
      const r = await fetch(factoryUrl + "/status?instanceId=" + encodeURIComponent(job.instance_id));
      live = await r.json().catch(() => ({}));
      if (!r.ok) { liveError = "factory status " + r.status; live = null; }
      else {
        const s = String(live.status || live.state || "unknown");
        await db.prepare("UPDATE generation_jobs SET status = ?, updated_at = ? WHERE id = ?")
          .bind(s, Date.now(), job.id).run();
        job.status = s;
      }
    } catch (err: any) {
      liveError = "could not reach factory: " + String(err?.message || err);
    }
  } else if (!factoryUrl) {
    liveError = "Factory worker URL not configured.";
  }

  return Response.json({ job, live, liveError });
};
