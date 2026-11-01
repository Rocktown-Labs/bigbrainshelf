import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import {
  buildHyperFramesComposition,
  ensureVideoJobsTable,
  type VideoAspectFormat,
} from '../../../lib/hyperframes-video';

// Queue a story-video build for a finished book and generate its deterministic
// HyperFrames composition (16:9 YouTube Episode or 9:16 YouTube Short).
export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const slug = String(body?.slug ?? '').trim();
  const aspect: VideoAspectFormat = body?.aspect === '9:16' ? '9:16' : '16:9';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return Response.json({ error: 'a valid book slug is required' }, { status: 400 });
  }
  const db = env.DB;
  await ensureVideoJobsTable(db);
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

  // Build the HyperFrames HTML/GSAP composition & scene manifest in R2
  let composition: any = null;
  try {
    const bundle = await buildHyperFramesComposition(db, env as any, slug, { aspect });
    composition = {
      aspect: bundle.aspect,
      width: bundle.width,
      height: bundle.height,
      fps: bundle.fps,
      totalDurationSec: bundle.totalDurationSec,
      sceneCount: bundle.scenes.length,
      htmlKey: bundle.htmlKey,
      manifestKey: bundle.manifestKey,
    };
  } catch {}

  const active: any = await db
    .prepare(
      "SELECT id, status FROM video_jobs WHERE book_slug = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1"
    )
    .bind(slug)
    .first();
  if (active) {
    return Response.json({ ok: true, already: true, job: active, composition });
  }
  const now = Date.now();
  const id = `vj-${slug}-${now}`;
  await db
    .prepare(
      "INSERT INTO video_jobs (id, book_slug, status, detail, video_key, aspect, engine, composition_key, created_at, updated_at) VALUES (?, ?, 'queued', ?, NULL, ?, 'hyperframes', ?, ?, ?)"
    )
    .bind(
      id,
      slug,
      composition ? `HyperFrames ${aspect} (${composition.sceneCount} scenes, ${composition.totalDurationSec}s)` : null,
      aspect,
      composition?.htmlKey || null,
      now,
      now
    )
    .run()
    .catch(() =>
      db
        .prepare(
          "INSERT INTO video_jobs (id, book_slug, status, detail, video_key, created_at, updated_at) VALUES (?, ?, 'queued', NULL, NULL, ?, ?)"
        )
        .bind(id, slug, now, now)
        .run()
    );
  return Response.json({ ok: true, job: { id, status: 'queued', aspect, engine: 'hyperframes' }, composition });
};
