// Lift jobs: the async queue behind the cast crop editor's "Lift
// this pose" action (admin/characters/cast-crops).
//
// The hub Worker cannot run the matte (rembg + alpha matting on CPU),
// so lifting is a job: the editor enqueues a row here with a snapshot
// of the pose's SAVED box; a small worker service on the VM
// (~/workspace/lift-worker) claims jobs over the token-gated
// /api/lift/worker route, runs the pipeline, and posts the cutout +
// placed PNGs back. The hub then lands them on the gallery through
// applyLiftedPose (src/lib/cast-gallery.ts), backup-first like a save.
//
// A job is pinned to the box snapshot it was enqueued with: if the
// gallery has moved on by completion time, the apply still records
// that box as liftedBox, and the next save's box comparison decides
// whether the lifted state survives (it will not, if the box moved).

import type { DBLike } from "./orders";
import { validBoxes, type GalleryBox } from "./cast-gallery";

export type LiftJobStatus = "queued" | "running" | "done" | "failed";

/** Two job families share this queue and the /api/lift/worker
 * protocol. "lift" is the original matte-and-place job. "segment" is
 * the crop editor's Erase click-to-remove: the worker runs SAM 2 with
 * a single point prompt on ONE pose image and posts back the pose
 * with the clicked thing filled in with the background color. A
 * segment job never touches the live gallery: its result lands at
 * out_key and the editor stages it as a working edit that only a
 * gallery Save can publish. */
export type LiftJobKind = "lift" | "segment";

export interface LiftJob {
  id: string;
  kind: LiftJobKind;
  slug: string;
  pose_index: number; // 0-based, parallel to the manifest's boxes/poseMeta
  box: GalleryBox; // snapshot of the saved box at enqueue time
  sheet_key: string;
  point: { x: number; y: number } | null; // segment: click point, pose-image pixels
  src_key: string | null; // segment: the image the worker erases from
  out_key: string | null; // segment: where the erased result lands
  status: LiftJobStatus;
  error: string | null;
  created_at: number; // unix seconds
  started_at: number | null;
  finished_at: number | null;
}

/** Scratch source key for a segment job whose source is the editor's
 * working image (brush edits included) rather than the saved pose. */
export function eraseSrcKey(slug: string, jobId: string): string {
  return `cast-gallery/${slug}/erase-src-${jobId}.png`;
}

/** Where a segment job's erased pose lands. Staging only: the public
 * gallery never reads this key; a gallery save publishes the edit. */
export function eraseOutKey(slug: string, jobId: string): string {
  return `cast-gallery/${slug}/erase/${jobId}.png`;
}

/** A running job older than this is treated as abandoned (worker died
 * mid-lift) and returns to the queue on the next claim. */
export const LIFT_STALE_RUNNING_S = 1800;

export async function ensureLiftJobsTable(db: DBLike): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS lift_jobs (
         id TEXT PRIMARY KEY,
         slug TEXT NOT NULL,
         pose_index INTEGER NOT NULL,
         box TEXT NOT NULL,
         sheet_key TEXT NOT NULL DEFAULT '',
         status TEXT NOT NULL DEFAULT 'queued',
         error TEXT,
         created_at INTEGER NOT NULL,
         started_at INTEGER,
         finished_at INTEGER
       )`
    )
    .bind()
    .run();
  await db
    .prepare("CREATE INDEX IF NOT EXISTS lift_jobs_slug_idx ON lift_jobs(slug, created_at)")
    .bind()
    .run();
  await db
    .prepare("CREATE INDEX IF NOT EXISTS lift_jobs_status_idx ON lift_jobs(status, created_at)")
    .bind()
    .run();
  // Segment-job columns, added after the fact: SQLite has no
  // ADD COLUMN IF NOT EXISTS, so a duplicate-column error just means
  // the migration already ran.
  for (const col of [
    "kind TEXT NOT NULL DEFAULT 'lift'",
    "point TEXT",
    "src_key TEXT",
    "out_key TEXT",
  ]) {
    try {
      await db.prepare(`ALTER TABLE lift_jobs ADD COLUMN ${col}`).bind().run();
    } catch {
      /* column already present */
    }
  }
}

function rowToJob(row: any): LiftJob {
  let box: GalleryBox = { x: 0, y: 0, w: 0, h: 0 };
  try {
    const parsed = validBoxes([JSON.parse(row.box || "null")]);
    if (parsed) box = parsed[0];
  } catch {
    /* keep the zero box; a job with an unreadable box fails at apply */
  }
  let point: { x: number; y: number } | null = null;
  try {
    const p = JSON.parse(row.point || "null");
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) point = { x: p.x, y: p.y };
  } catch {
    /* an unreadable point fails the job at the worker */
  }
  return {
    id: String(row.id),
    kind: row.kind === "segment" ? "segment" : "lift",
    slug: String(row.slug),
    pose_index: Number(row.pose_index || 0),
    box,
    sheet_key: String(row.sheet_key || ""),
    point,
    src_key: row.src_key != null && row.src_key !== "" ? String(row.src_key) : null,
    out_key: row.out_key != null && row.out_key !== "" ? String(row.out_key) : null,
    status: (["queued", "running", "done", "failed"].includes(row.status)
      ? row.status
      : "queued") as LiftJobStatus,
    error: row.error != null ? String(row.error) : null,
    created_at: Number(row.created_at || 0),
    started_at: row.started_at != null ? Number(row.started_at) : null,
    finished_at: row.finished_at != null ? Number(row.finished_at) : null,
  };
}

export function isActiveLiftStatus(s: LiftJobStatus): boolean {
  return s === "queued" || s === "running";
}

export interface EnqueueLiftArgs {
  slug: string;
  poseIndex: number; // 0-based
  box: unknown;
  sheetKey: string;
  now?: number; // unix seconds, injectable for tests
  id?: string; // injectable for tests
}

export async function enqueueLiftJob(
  db: DBLike,
  args: EnqueueLiftArgs
): Promise<{ ok: true; job: LiftJob } | { ok: false; error: string; existing?: LiftJob }> {
  const slug = String(args.slug || "").trim();
  if (!/^[a-z0-9-]+$/.test(slug)) return { ok: false, error: "bad slug" };
  if (!Number.isInteger(args.poseIndex) || args.poseIndex < 0 || args.poseIndex > 11) {
    return { ok: false, error: "bad pose_index" };
  }
  const boxes = validBoxes([args.box]);
  if (!boxes) return { ok: false, error: "bad box" };
  const existing = await db
    .prepare(
      "SELECT * FROM lift_jobs WHERE slug = ? AND pose_index = ? AND kind = 'lift' AND status IN ('queued','running') ORDER BY created_at ASC LIMIT 1"
    )
    .bind(slug, args.poseIndex)
    .first();
  if (existing) {
    return {
      ok: false,
      error: "a lift for this pose is already queued or running",
      existing: rowToJob(existing),
    };
  }
  const job: LiftJob = {
    id: args.id || crypto.randomUUID(),
    kind: "lift",
    slug,
    pose_index: args.poseIndex,
    box: boxes[0],
    sheet_key: String(args.sheetKey || ""),
    point: null,
    src_key: null,
    out_key: null,
    status: "queued",
    error: null,
    created_at: args.now ?? Math.floor(Date.now() / 1000),
    started_at: null,
    finished_at: null,
  };
  await db
    .prepare(
      `INSERT INTO lift_jobs (id, slug, pose_index, box, sheet_key, status, error, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, 'queued', NULL, ?, NULL, NULL)`
    )
    .bind(job.id, job.slug, job.pose_index, JSON.stringify(job.box), job.sheet_key, job.created_at)
    .run();
  return { ok: true, job };
}

export async function listLiftJobs(
  db: DBLike,
  slug: string,
  limit = 20,
  kind?: LiftJobKind
): Promise<LiftJob[]> {
  const res = await db
    .prepare("SELECT * FROM lift_jobs WHERE slug = ? ORDER BY created_at DESC LIMIT ?")
    .bind(slug, Math.max(1, Math.min(50, limit)))
    .all();
  const jobs = (res.results || []).map(rowToJob);
  return kind ? jobs.filter((j) => j.kind === kind) : jobs;
}

export interface EnqueueSegmentArgs {
  slug: string;
  poseIndex: number; // 0-based
  point: { x: number; y: number }; // click point in pose-image pixels
  srcKey: string; // pose image the worker erases from (saved pose or scratch working copy)
  sheetKey?: string;
  now?: number; // unix seconds, injectable for tests
  id?: string; // injectable for tests
}

/** Enqueue an Erase click-to-remove job. The point is validated
 * against the pose image's pixel size by the caller (the admin route
 * knows the saved box + sheet size); here it only needs to be a
 * finite, non-negative point. One active segment job per pose, same
 * discipline as lifts; a lift and a segment job for the same pose may
 * be active at once (they land in different places). */
export async function enqueueSegmentJob(
  db: DBLike,
  args: EnqueueSegmentArgs
): Promise<{ ok: true; job: LiftJob } | { ok: false; error: string; existing?: LiftJob }> {
  const slug = String(args.slug || "").trim();
  if (!/^[a-z0-9-]+$/.test(slug)) return { ok: false, error: "bad slug" };
  if (!Number.isInteger(args.poseIndex) || args.poseIndex < 0 || args.poseIndex > 11) {
    return { ok: false, error: "bad pose_index" };
  }
  const p = args.point;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0) {
    return { ok: false, error: "bad point" };
  }
  const srcKey = String(args.srcKey || "");
  if (!srcKey.startsWith("cast-gallery/")) return { ok: false, error: "bad src_key" };
  const existing = await db
    .prepare(
      "SELECT * FROM lift_jobs WHERE slug = ? AND pose_index = ? AND kind = 'segment' AND status IN ('queued','running') ORDER BY created_at ASC LIMIT 1"
    )
    .bind(slug, args.poseIndex)
    .first();
  if (existing) {
    return {
      ok: false,
      error: "a remove for this pose is already queued or running",
      existing: rowToJob(existing),
    };
  }
  const id = args.id || crypto.randomUUID();
  const job: LiftJob = {
    id,
    kind: "segment",
    slug,
    pose_index: args.poseIndex,
    box: { x: 0, y: 0, w: 0, h: 0 }, // segment jobs carry no box snapshot
    sheet_key: String(args.sheetKey || ""),
    point: { x: p.x, y: p.y },
    src_key: srcKey,
    out_key: eraseOutKey(slug, id),
    status: "queued",
    error: null,
    created_at: args.now ?? Math.floor(Date.now() / 1000),
    started_at: null,
    finished_at: null,
  };
  await db
    .prepare(
      `INSERT INTO lift_jobs (id, slug, pose_index, box, sheet_key, status, error, created_at, started_at, finished_at, kind, point, src_key, out_key)
       VALUES (?, ?, ?, ?, ?, 'queued', NULL, ?, NULL, NULL, 'segment', ?, ?, ?)`
    )
    .bind(
      job.id, job.slug, job.pose_index, JSON.stringify(job.box), job.sheet_key,
      job.created_at, JSON.stringify(job.point), job.src_key, job.out_key
    )
    .run();
  return { ok: true, job };
}

export async function getLiftJob(db: DBLike, id: string): Promise<LiftJob | null> {
  const row = await db.prepare("SELECT * FROM lift_jobs WHERE id = ?").bind(id).first();
  return row ? rowToJob(row) : null;
}

/** Claim the oldest queued job (after returning stale running jobs to
 * the queue). Returns null when the queue is empty. */
export async function claimNextLiftJob(
  db: DBLike,
  now: number
): Promise<LiftJob | null> {
  await db
    .prepare(
      "UPDATE lift_jobs SET status = 'queued', started_at = NULL WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?"
    )
    .bind(now - LIFT_STALE_RUNNING_S)
    .run();
  const row = await db
    .prepare("SELECT * FROM lift_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
    .bind()
    .first();
  if (!row) return null;
  const res: any = await db
    .prepare("UPDATE lift_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
    .bind(now, row.id)
    .run();
  if (Number(res?.meta?.changes ?? 0) === 0) return null; // lost a race; next poll retries
  const claimed = rowToJob(row);
  claimed.status = "running";
  claimed.started_at = now;
  return claimed;
}

export async function completeLiftJob(
  db: DBLike,
  id: string,
  now: number
): Promise<{ ok: boolean; error?: string }> {
  const res: any = await db
    .prepare("UPDATE lift_jobs SET status = 'done', error = NULL, finished_at = ? WHERE id = ? AND status = 'running'")
    .bind(now, id)
    .run();
  if (Number(res?.meta?.changes ?? 0) === 0) return { ok: false, error: "job not running" };
  return { ok: true };
}

export async function failLiftJob(
  db: DBLike,
  id: string,
  error: string,
  now: number
): Promise<{ ok: boolean; error?: string }> {
  const message = String(error || "unknown error").slice(0, 1000);
  const res: any = await db
    .prepare("UPDATE lift_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status IN ('queued','running')")
    .bind(message, now, id)
    .run();
  if (Number(res?.meta?.changes ?? 0) === 0) return { ok: false, error: "job not found or already finished" };
  return { ok: true };
}

/** Bearer-token check for the worker-facing route. The token lives in
 * the LIFT_WORKER_TOKEN worker secret and in the VM service's env
 * file; without the secret set, the route is closed entirely. */
export function liftWorkerTokenOk(request: Request, e: any): boolean {
  const expected = typeof e?.LIFT_WORKER_TOKEN === "string" ? e.LIFT_WORKER_TOKEN : "";
  if (!expected) return false;
  const header = request.headers.get("Authorization") || "";
  const got = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!got || got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decode a base64 PNG payload from the worker, with a hard size cap
 * and a magic-byte check. Returns null for anything else. */
export function decodePngBase64(raw: unknown, maxBytes = 10 * 1024 * 1024): Uint8Array | null {
  if (typeof raw !== "string" || !raw) return null;
  let bytes: Uint8Array;
  try {
    const bin = atob(raw.replace(/\s+/g, ""));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return null;
  }
  if (bytes.length < 8 || bytes.length > maxBytes) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_MAGIC[i]) return null;
  return bytes;
}
