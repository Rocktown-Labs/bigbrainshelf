import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { readReviewSession } from '../../../lib/review-book';

export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const slug = (url.searchParams.get('slug') || 'docker').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return Response.json({ error: 'bad slug' }, { status: 400 });
  try {
    const book = await e.DB.prepare('SELECT title FROM books WHERE slug = ?').bind(slug).first();
    const review = await readReviewSession(e.DB, e.BOOKS, slug);
    return Response.json({ title: book?.title ?? slug, ...review });
  } catch {
    return Response.json({ error: 'Review inventory or artifact identity is unverified. Check plans and artifacts, then reload.' }, { status: 409 });
  }
};
