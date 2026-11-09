import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { readReviewSession } from '../../../lib/review-book';

export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const slug = (url.searchParams.get('slug') || 'docker').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return Response.json({ error: 'bad slug' }, { status: 400 });
  try {
    const book = await e.DB.prepare('SELECT title, status, cover_key FROM books WHERE slug = ?').bind(slug).first();
    const review = await readReviewSession(e.DB, e.BOOKS, slug);
    // Change notes ride along with the review payload (viewer speed fix,
    // 2026-11-09): the viewer used to fetch the whole catalog for the
    // title/status chip, then poll /api/change-requests every 25s for
    // notes. One response now carries everything the first paint needs.
    // Notes are best-effort: a notes read failure must never fail the
    // identity-checked review load, so it degrades to an empty list and
    // the viewer falls back to fetching them on its own.
    let changeRequests: unknown[] = [];
    try {
      const { results } = await e.DB.prepare(
        'SELECT * FROM change_requests WHERE book_slug = ? ORDER BY created_at DESC'
      ).bind(slug).all();
      changeRequests = results ?? [];
    } catch { /* notes degrade to empty; identity load stands */ }
    return Response.json({ title: book?.title ?? slug, bookStatus: book?.status ?? null, coverKey: book?.cover_key ?? null, changeRequests, ...review });
  } catch {
    return Response.json({ error: 'Review inventory or artifact identity is unverified. Check plans and artifacts, then reload.' }, { status: 409 });
  }
};
