import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import {
  loadCastGallery,
  applyLiftedPose,
  poseKey,
} from '../../../lib/cast-gallery';
import { isSafeMediaKey, mediaContentType } from '../../../lib/media';
import {
  ensureLiftJobsTable,
  claimNextLiftJob,
  completeLiftJob,
  failLiftJob,
  getLiftJob,
  liftWorkerTokenOk,
  decodePngBase64,
  eraseOutKey,
} from '../../../lib/lift-jobs';

// Worker-facing Lift API. The middleware allowlists this path; every
// action verifies the LIFT_WORKER_TOKEN bearer secret (the VM lift
// worker service holds the same token in its env file). One route,
// POST with an `action` field:
//
// { action: "claim" } -> the oldest queued job + everything the worker
//      needs (sheet key, current pose key, box snapshot), or {job:null}.
//      Segment jobs (Erase click-to-remove) instead carry kind, the
//      click point in pose-image pixels, and sourceKey, the pose
//      image to erase from (a saved pose key, or a scratch key
//      holding the editor's working copy).
// { action: "asset", key } -> the object's bytes as base64 JSON. The
//      bucket's public r2.dev domain is disabled, so the worker pulls
//      its inputs (character sheets, gallery poses) through this
//      token-gated action instead of public URLs. Keys are confined to
//      the two trees the pipeline legitimately reads: character
//      sheets (characters/) and gallery poses (cast-gallery/).
// { action: "complete", jobId, cutoutPng, placedPng } (base64 PNGs)
//      -> writes the cutout to R2 and lands the placed art on the
//         gallery via applyLiftedPose, then marks the job done.
// { action: "complete", jobId, resultPng } for a segment job
//      -> stores the erased pose at the job's out_key (staging only;
//         the live gallery is untouched) and marks the job done.
// { action: "fail", jobId, error } -> marks the job failed with the
//      worker's error text, which the editor surfaces verbatim.

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  if (!liftWorkerTokenOk(request, e)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureLiftJobsTable(e.DB);
  const b = await request.json().catch(() => ({}));
  const action = String(b?.action || "");
  const now = Math.floor(Date.now() / 1000);

  try {
    if (action === "claim") {
      const job = await claimNextLiftJob(e.DB, now);
      if (!job) return Response.json({ job: null });
      const manifest = await loadCastGallery(e.BOOKS);
      const entry = manifest.characters[job.slug];
      return Response.json({
        job: {
          id: job.id,
          kind: job.kind,
          slug: job.slug,
          poseIndex: job.pose_index,
          poseNumber: job.pose_index + 1,
          box: job.box,
          sheetKey: job.sheet_key || entry?.sheetKey || "",
          poseKey: poseKey(job.slug, job.pose_index + 1),
          point: job.point,
          sourceKey: job.src_key || poseKey(job.slug, job.pose_index + 1),
          outKey: job.out_key || "",
          name: entry?.name || job.slug,
          bookSlug: entry?.bookSlug || "",
          sheetSize: entry?.sheetSize || null,
        },
      });
    }

    if (action === "asset") {
      const key = String(b?.key || "");
      const allowedPrefix = /^(characters|cast-gallery)\//.test(key);
      if (!isSafeMediaKey(key) || !allowedPrefix) {
        return Response.json({ error: "key not allowed" }, { status: 400 });
      }
      const obj = await e.BOOKS.get(key).catch(() => null);
      if (!obj) return Response.json({ error: "object not found" }, { status: 404 });
      const buf = new Uint8Array(await obj.arrayBuffer());
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
      }
      return Response.json({
        key,
        contentType: mediaContentType(key, obj.httpMetadata?.contentType),
        size: buf.length,
        dataBase64: btoa(binary),
      });
    }

    if (action === "complete") {
      const jobId = String(b?.jobId || "");
      const job = jobId ? await getLiftJob(e.DB, jobId) : null;
      if (!job) return Response.json({ error: "job not found" }, { status: 404 });
      if (job.status !== "running") {
        return Response.json({ error: `job is ${job.status}, not running` }, { status: 409 });
      }
      if (job.kind === "segment") {
        const result = decodePngBase64(b?.resultPng);
        if (!result) {
          return Response.json({ error: "resultPng must be a base64 PNG (<=10MB)" }, { status: 400 });
        }
        const outKey = job.out_key || eraseOutKey(job.slug, job.id);
        await e.BOOKS.put(outKey, result, {
          httpMetadata: { contentType: "image/png" },
        });
        const done = await completeLiftJob(e.DB, job.id, Math.floor(Date.now() / 1000));
        if (!done.ok) {
          return Response.json({ error: `result stored but job completion failed: ${done.error}` }, { status: 500 });
        }
        return Response.json({ ok: true, outKey });
      }
      const cutout = decodePngBase64(b?.cutoutPng);
      const placed = decodePngBase64(b?.placedPng);
      if (!cutout || !placed) {
        return Response.json({ error: "cutoutPng and placedPng must be base64 PNGs (<=10MB each)" }, { status: 400 });
      }
      const { entry, backupTs } = await applyLiftedPose(
        e.BOOKS, job.slug, job.pose_index, placed, cutout, job.box
      );
      const done = await completeLiftJob(e.DB, job.id, Math.floor(Date.now() / 1000));
      if (!done.ok) {
        return Response.json({ error: `art applied but job completion failed: ${done.error}` }, { status: 500 });
      }
      return Response.json({ ok: true, v: entry.v || 1, backupTs });
    }

    if (action === "fail") {
      const jobId = String(b?.jobId || "");
      if (!jobId) return Response.json({ error: "jobId required" }, { status: 400 });
      const res = await failLiftJob(e.DB, jobId, String(b?.error || "worker reported failure"), now);
      if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
      return Response.json({ ok: true });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (err: any) {
    return Response.json({ error: String(err?.message || err) }, { status: 422 });
  }
};
