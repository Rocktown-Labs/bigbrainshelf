import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { loadCastGallery, poseKey } from '../../../lib/cast-gallery';
import { decodeImage } from '../../../lib/crops';
import {
  ensureLiftJobsTable,
  enqueueSegmentJob,
  listLiftJobs,
  decodePngBase64,
  eraseSrcKey,
} from '../../../lib/lift-jobs';

// Erase (click-to-remove) queue admin API for the cast crop editor.
// Gated by the middleware's admin session cookie, with the
// locals.user check as defense in depth (same shape as
// /api/admin/cast-lift).
//
// GET  ?slug= -> { jobs } recent segment jobs for a character
// POST { slug, poseIndex, x, y, sourcePng? } -> enqueue a SAM 2
//      remove of whatever sits at pixel (x, y) of the pose's image.
//      x/y are POSE-IMAGE pixels (the editor's canvas is the pose at
//      natural size). sourcePng (base64) is the editor's current
//      working image when it has brush edits the remove should build
//      on; it is staged at a scratch key and the worker erases from
//      that. Without it the worker erases from the saved pose file.
//      The result never touches the live gallery: it lands at the
//      job's out_key and the editor stages it as a working edit that
//      only a gallery save publishes.

function guard(locals: any) {
  return !(locals as any)?.user;
}

/** Pixel size a box crops to, same round() convention as
 * cropDecodedBox in lib/cast-gallery. */
function posePixelSize(
  sheetSize: { w: number; h: number },
  box: { x: number; y: number; w: number; h: number }
): { w: number; h: number } {
  const x0 = Math.max(0, Math.min(sheetSize.w - 1, Math.round(box.x * sheetSize.w)));
  const y0 = Math.max(0, Math.min(sheetSize.h - 1, Math.round(box.y * sheetSize.h)));
  const w = Math.max(1, Math.min(sheetSize.w - x0, Math.round(box.w * sheetSize.w)));
  const h = Math.max(1, Math.min(sheetSize.h - y0, Math.round(box.h * sheetSize.h)));
  return { w, h };
}

export const GET: APIRoute = async ({ url, locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  const slug = (url.searchParams.get("slug") || "").trim();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ error: "bad slug" }, { status: 400 });
  }
  await ensureLiftJobsTable(e.DB);
  const jobs = await listLiftJobs(e.DB, slug, 20, "segment");
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
  if (!box || !entry.sheetSize) {
    return Response.json({ error: `pose ${poseIndex + 1} has no saved box for '${slug}'` }, { status: 404 });
  }
  const size = posePixelSize(entry.sheetSize, box);
  const x = Number(b.x);
  const y = Number(b.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= size.w || y >= size.h) {
    return Response.json(
      { error: `click point must land inside the pose image (${size.w}x${size.h}px)` },
      { status: 400 }
    );
  }

  const jobId = crypto.randomUUID();
  let srcKey = poseKey(slug, poseIndex + 1);
  if (b.sourcePng !== undefined && b.sourcePng !== null && b.sourcePng !== "") {
    const png = decodePngBase64(b.sourcePng);
    if (!png) {
      return Response.json({ error: "sourcePng must be a base64 PNG (<=10MB)" }, { status: 400 });
    }
    let dims: { width: number; height: number };
    try {
      dims = decodeImage(png);
    } catch {
      return Response.json({ error: "sourcePng is not a readable image" }, { status: 400 });
    }
    if (dims.width !== size.w || dims.height !== size.h) {
      return Response.json(
        { error: `sourcePng is ${dims.width}x${dims.height}px but the pose is ${size.w}x${size.h}px; reload the character and erase again` },
        { status: 400 }
      );
    }
    srcKey = eraseSrcKey(slug, jobId);
    await e.BOOKS.put(srcKey, png, { httpMetadata: { contentType: "image/png" } });
  }

  const result = await enqueueSegmentJob(e.DB, {
    slug,
    poseIndex,
    point: { x: Math.round(x), y: Math.round(y) },
    srcKey,
    sheetKey: entry.sheetKey || "",
    id: jobId,
  });
  if (!result.ok) {
    return Response.json(
      { error: result.error, job: result.existing ?? null },
      { status: result.existing ? 409 : 400 }
    );
  }
  return Response.json({ ok: true, job: result.job }, { status: 201 });
};
