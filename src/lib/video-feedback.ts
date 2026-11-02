// Promo QC feedback tags (/admin/videos).
//
// While CG reviews a promo in the QC viewer, he tags what needs work:
// a whole video, one scene, or one element inside a scene (picked from
// the frame or the element list). A tag is one of fix / steal / keep /
// question plus an optional note. Rows are capture only, like the
// Story Review notes: nothing here re-renders anything. A fix pass
// reads them back through GET /api/admin/video-feedback?all=1 (or the
// per-video list in the viewer) and works the queue.
//
// Scope identity: video slug (the QC data slug, e.g.
// "audiobooks-style-a"), scene_id ("" for a whole-video tag), and
// element_id ("" for a whole-scene tag). Both empty = whole video.

import type { DBLike } from "./orders";

export const VIDEO_FEEDBACK_TAGS = ["fix", "steal", "keep", "question"] as const;
export type VideoFeedbackTag = (typeof VIDEO_FEEDBACK_TAGS)[number];

export interface VideoFeedback {
  id: string;
  video_slug: string;
  scene_id: string;
  element_id: string;
  tag: VideoFeedbackTag;
  note: string;
  created_at: number; // unix seconds
}

let ensured = false;

export async function ensureVideoFeedbackTable(db: DBLike): Promise<void> {
  if (ensured) return;
  ensured = true;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS video_feedback (
         id TEXT PRIMARY KEY,
         video_slug TEXT NOT NULL,
         scene_id TEXT NOT NULL DEFAULT '',
         element_id TEXT NOT NULL DEFAULT '',
         tag TEXT NOT NULL,
         note TEXT NOT NULL DEFAULT '',
         created_at INTEGER NOT NULL
       )`
    )
    .bind()
    .run();
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS video_feedback_slug_idx ON video_feedback(video_slug, scene_id)"
    )
    .bind()
    .run();
}

export function isVideoFeedbackTag(raw: unknown): raw is VideoFeedbackTag {
  return typeof raw === "string" && (VIDEO_FEEDBACK_TAGS as readonly string[]).includes(raw);
}

function rowToFeedback(row: any): VideoFeedback {
  return {
    id: String(row.id),
    video_slug: String(row.video_slug),
    scene_id: String(row.scene_id || ""),
    element_id: String(row.element_id || ""),
    tag: isVideoFeedbackTag(row.tag) ? row.tag : "question",
    note: String(row.note || ""),
    created_at: Number(row.created_at || 0),
  };
}

export async function listVideoFeedback(
  db: DBLike,
  videoSlug?: string
): Promise<VideoFeedback[]> {
  const stmt = videoSlug
    ? db
        .prepare("SELECT * FROM video_feedback WHERE video_slug = ? ORDER BY created_at ASC")
        .bind(videoSlug)
    : db.prepare("SELECT * FROM video_feedback ORDER BY video_slug ASC, created_at ASC").bind();
  const res = await stmt.all();
  return (res.results || []).map(rowToFeedback);
}

export interface AddVideoFeedbackArgs {
  videoSlug: string;
  sceneId?: string;
  elementId?: string;
  tag: unknown;
  note?: string;
  now?: number; // unix seconds, injectable for tests
  id?: string; // injectable for tests
}

const ID_OK = /^[A-Za-z0-9_-]*$/;

export async function addVideoFeedback(
  db: DBLike,
  args: AddVideoFeedbackArgs
): Promise<{ ok: true; feedback: VideoFeedback } | { ok: false; error: string }> {
  const videoSlug = String(args.videoSlug || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(videoSlug)) return { ok: false, error: "bad video slug" };
  const sceneId = String(args.sceneId || "").trim();
  const elementId = String(args.elementId || "").trim();
  if (!ID_OK.test(sceneId) || sceneId.length > 80) return { ok: false, error: "bad scene_id" };
  if (!ID_OK.test(elementId) || elementId.length > 120) return { ok: false, error: "bad element_id" };
  if (!isVideoFeedbackTag(args.tag)) return { ok: false, error: "bad tag" };
  const note = String(args.note || "").trim().slice(0, 1000);
  const feedback: VideoFeedback = {
    id: args.id || crypto.randomUUID(),
    video_slug: videoSlug,
    scene_id: sceneId,
    element_id: elementId,
    tag: args.tag,
    note,
    created_at: args.now ?? Math.floor(Date.now() / 1000),
  };
  await db
    .prepare(
      `INSERT INTO video_feedback (id, video_slug, scene_id, element_id, tag, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      feedback.id,
      feedback.video_slug,
      feedback.scene_id,
      feedback.element_id,
      feedback.tag,
      feedback.note,
      feedback.created_at
    )
    .run();
  return { ok: true, feedback };
}
