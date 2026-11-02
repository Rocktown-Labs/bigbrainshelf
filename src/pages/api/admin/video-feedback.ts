import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  ensureVideoFeedbackTable,
  listVideoFeedback,
  addVideoFeedback,
} from "../../../lib/video-feedback";

// Promo QC feedback API. Gated by the middleware's admin session, with
// the locals.user check as defense in depth (same shape as
// /api/admin/review-notes).
//
// GET  ?video=<slug>  -> { feedback } for one video
// GET  ?all=1         -> { feedback } across all videos (fix-pass export)
// POST { video_slug, scene_id, element_id, tag, note } -> create a tag

function guard(locals: any) {
  return !(locals as any)?.user;
}

export const GET: APIRoute = async ({ url, locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  await ensureVideoFeedbackTable(e.DB);
  const video = (url.searchParams.get("video") || "").trim();
  if (video) {
    if (!/^[A-Za-z0-9_-]+$/.test(video)) {
      return Response.json({ error: "bad slug" }, { status: 400 });
    }
    return Response.json({ feedback: await listVideoFeedback(e.DB, video) });
  }
  if (url.searchParams.get("all") === "1") {
    return Response.json({ feedback: await listVideoFeedback(e.DB) });
  }
  return Response.json({ error: "pass ?video=<slug> or ?all=1" }, { status: 400 });
};

export const POST: APIRoute = async ({ request, locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  await ensureVideoFeedbackTable(e.DB);
  const body = await request.json().catch(() => ({}));
  const result = await addVideoFeedback(e.DB, {
    videoSlug: String(body?.video_slug || ""),
    sceneId: String(body?.scene_id || ""),
    elementId: String(body?.element_id || ""),
    tag: body?.tag,
    note: String(body?.note || ""),
  });
  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ ok: true, feedback: result.feedback }, { status: 201 });
};
