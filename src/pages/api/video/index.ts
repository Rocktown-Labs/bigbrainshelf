import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

// Books eligible for a story video (finished artifacts exist), each with
// its latest video job and its finished video key when one is built.
export const GET: APIRoute = async () => {
  const db = env.DB;
  const { results: books } = await db
    .prepare(
      `SELECT slug, title, status, topic, cover_key, video_key FROM books
       WHERE status IN ('ready_for_qa', 'complete', 'in_progress')
       ORDER BY created_at ASC`
    )
    .all();
  const { results: jobs } = await db
    .prepare('SELECT * FROM video_jobs ORDER BY created_at DESC')
    .all();
  const latest = new Map<string, any>();
  for (const j of jobs as any[]) {
    if (!latest.has(j.book_slug)) latest.set(j.book_slug, j);
  }
  return Response.json(
    (books as any[]).map((b) => ({ ...b, video_job: latest.get(b.slug) ?? null }))
  );
};
