import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { coverDerivative } from '../../lib/derivatives';
import { listPublicBooks, listCartBooks, withAvailabilityFlags } from '../../lib/books-public';
import { bookHref } from '../../lib/public-slugs';

export const GET: APIRoute = async ({ url, locals }) => {
  const db = env.DB;
  // Two audiences, two shapes. Admin sessions (locals.user, set by the
  // middleware from the admin cookie) get the full rows the admin
  // pages consume, every status included. Everyone else gets the
  // public projection from src/lib/books-public.ts: status='complete'
  // only, display fields only, availability booleans instead of the
  // raw R2 storage keys. A caller-supplied ?status= never widens the
  // public shape; it only filters the admin one. The one opt-in
  // widening is ?scope=cart (cart scripts only): the catalog plus the
  // audio-published books in audio-only projection, so a cart can
  // price an audiobook whose book edition is not published yet.
  const isAdmin = !!(locals as any)?.user;
  let results: any[];
  if (isAdmin) {
    const status = url.searchParams.get('status');
    if (status) {
      ({ results } = await db.prepare('SELECT * FROM books WHERE status = ?').bind(status).all());
    } else {
      ({ results } = await db.prepare('SELECT * FROM books').all());
    }
  } else if (url.searchParams.get('scope') === 'cart') {
    results = await listCartBooks(db);
  } else {
    results = await listPublicBooks(db);
  }
  // One availability contract for both shapes: full (admin) rows
  // gain the has_* booleans from their raw key columns, so the
  // storefront cart scripts resolve audio / gift set availability
  // identically no matter who is asking.
  results = results.map(withAvailabilityFlags);
  // A draft's title is just its slug until the factory's bookinfo stage
  // runs, but an attached bible already carries the real title. Show
  // that instead of the raw slug everywhere this list is consumed.
  try {
    const { results: bibles } = await db
      .prepare('SELECT book_slug, book_title FROM bibles ORDER BY created_at ASC')
      .all();
    const titleBySlug = new Map<string, string>();
    for (const b of bibles as any[]) {
      if (b.book_slug && b.book_title) titleBySlug.set(b.book_slug, b.book_title);
    }
    for (const row of results as any[]) {
      if ((!row.title || row.title === row.slug) && titleBySlug.has(row.slug)) {
        row.title = titleBySlug.get(row.slug);
      }
    }
    // Right-sized WebP cover derivatives for card/thumb contexts
    // (null when none exist for the book; consumers fall back to
    // cover_key). Full URLs, same shape style as cover_key consumers
    // expect from R2 + key, but pre-joined for the derivative host path.
    for (const row of results as any[]) {
      row.cover_card = coverDerivative(row.slug, 'card', row.cover_key);
      row.cover_hero = coverDerivative(row.slug, 'hero', row.cover_key);
      // Every shape carries the ready-made public link (built from
      // public_slug; see src/lib/public-slugs.ts). The public
      // projection already stamps it in toPublicBook; this covers
      // the admin full-row shape and keeps the two in agreement.
      row.href = bookHref(row);
    }
  } catch { /* bibles table unavailable: raw titles stand */ }
  return Response.json(results);
};

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await request.json();
  const db = env.DB;
  const id = crypto.randomUUID();
  const now = Date.now();
  const allowed = ['draft', 'queued', 'building', 'ready_for_qa', 'in_progress', 'complete'];
  const status = allowed.includes(body.status) ? body.status : 'draft';
  const allowedTopics = ['tech', 'money', 'courage'];
  // An explicit category wins. Anything else ('auto', missing) stores ''
  // so the factory infers the category from the document during its build.
  const topic = allowedTopics.includes(body.topic) ? body.topic : '';
  const tier = [1, 2, 3].includes(body.tier) ? body.tier : 1;
  const series = String(body.series || '').slice(0, 120);
  // Title defaults to the slug: bookbuild's bookinfo stage replaces a
  // slug-equal title with one extracted from the document itself.
  const title = String(body.title || body.slug || '').trim() || body.slug;
  // Subject topics (docker, python, javascript...): free-form slugs, comma-joined.
  const rawSubjects = Array.isArray(body.topics) ? body.topics.join(',') : String(body.topics || '');
  const subjects = [...new Set(rawSubjects.split(',').map((s: string) => s.trim().toLowerCase().replace(/[^a-z0-9+#.-]/g, '')).filter(Boolean))].join(',');
  await db.prepare(
    'INSERT INTO books (id, slug, title, bible_id, status, price, description, topic, topics, tier, series, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, body.slug, title, body.bibleId, status, body.price || 0, body.description || '', topic, subjects, tier, series, now, now).run();
  return Response.json({ id });
};
