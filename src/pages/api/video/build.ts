import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

// Queue a story-video build for a finished book. The VM-side runner
// polls video_jobs and does the work (HeyGen animation per page, Gemini
// Lite narration, ffmpeg assembly). One active job per book.
export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const slug = String(body?.slug ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return Response.json({ error: 'a valid book slug is required' }, { status: 400 });
  }
  const db = env.DB;
  const book: any = await db
    .prepare('SELECT slug, status FROM books WHERE slug = ?')
    .bind(slug)
    .first();
  if (!book) return Response.json({ error: 'book not found' }, { status: 404 });
  if (!['ready_for_qa', 'complete', 'in_progress'].includes(book.status)) {
    return Response.json(
      { error: `book is '${book.status}'; a video needs a finished book` },
      { status: 409 }
    );
  }
  const active: any = await db
    .prepare(
      "SELECT id, status FROM video_jobs WHERE book_slug = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1"
    )
    .bind(slug)
    .first();
  if (active) {
    return Response.json({ ok: true, already: true, job: active });
  }
  const now = Date.now();
  const id = `vj-${slug}-${now}`;
  await db
    .prepare(
      "INSERT INTO video_jobs (id, book_slug, status, detail, video_key, created_at, updated_at) VALUES (?, ?, 'queued', NULL, NULL, ?, ?)"
    )
    .bind(id, slug, now, now)
    .run();
  // Optional Cloudflare Queue dispatch for the external Remotion (`kidsbook-video`) consumer
  // when `VIDEO_QUEUE` is bound; `video_jobs` in D1 remains the canonical record.
  let queueDispatched = false;
  try {
    const q = (env as any).VIDEO_QUEUE;
    if (q && typeof q.send === "function") {
      await q.send({ jobId: id, bookSlug: slug, pipeline: "remotion-kidsbook-video", queuedAt: now });
      queueDispatched = true;
    }
  } catch {
    // D1 `video_jobs` remains queued for the VM runner
  }
  return Response.json({ ok: true, job: { id, status: 'queued', queueDispatched } });
};
