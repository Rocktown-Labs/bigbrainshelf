import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { loadCastGallery } from '../../../lib/cast-gallery';
import {
  ensureLiftJobsTable,
  enqueueLiftJob,
  listLiftJobs,
} from '../../../lib/lift-jobs';

// Lift queue admin API (cast crop editor). Gated by the middleware's
// admin session cookie, with the locals.user check as defense in depth
// (same shape as /api/admin/review-notes).
//
// GET  ?slug=              -> { jobs } recent lift jobs for a character
// POST { slug, poseIndex } -> enqueue a lift for the pose's SAVED box
//      (0-based poseIndex, matching the editor). The editor must have
//      saved first: the box snapshot comes from the stored manifest,
//      never from the client's working copy.

function guard(locals: any) {
  return !(locals as any)?.user;
}

export const GET: APIRoute = async ({ url, locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  const slug = (url.searchParams.get("slug") || "").trim();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "bad slug" }, { status: 400 });
  }
  await ensureLiftJobsTable(e.DB);
  const jobs = await listLiftJobs(e.DB, slug);
  return Response.json({ jobs });
};

export const POST: APIRoute = async ({ request, locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  await ensureLiftJobsTable(e.DB);
  const b = await request.json().catch(() => ({}));
  const slug = String(b.slug || "").trim();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "bad slug" }, { status: 400 });
  }
  const poseIndex = Number(b.poseIndex);
  if (!Number.isInteger(poseIndex) || poseIndex < 0) {
    return Response.json({ error: "bad poseIndex" }, { status: 400 });
  }
  const manifest = await loadCastGallery(e.BOOKS);
  const entry = manifest.characters[slug];
  if (!entry) return Response.json({ error: `no gallery entry for '${slug}'` }, { status: 404 });
  const box = entry.boxes?.[poseIndex];
  if (!box) {
    return Response.json({ error: `pose ${poseIndex + 1} has no saved box for '${slug}'` }, { status: 404 });
  }
  const result = await enqueueLiftJob(e.DB, {
    slug,
    poseIndex,
    box,
    sheetKey: entry.sheetKey || "",
  });
  if (!result.ok) {
    return Response.json(
      { error: result.error, job: result.existing ?? null },
      { status: result.existing ? 409 : 400 }
    );
  }
  return Response.json({ ok: true, job: result.job }, { status: 201 });
};
