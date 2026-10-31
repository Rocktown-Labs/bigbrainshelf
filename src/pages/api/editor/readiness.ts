import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import {
  getPublishReadiness,
  getPublishOverrides,
} from '../../../lib/publish-readiness';
import { getDeliveryReadiness } from '../../../lib/delivery-readiness';

// GET /api/editor/readiness?book_slug=docker -> the book's publish
// readiness (the audio gate's view: protagonist, cast voice, audiobook
// voice stamp, state, blockers) plus its let-it-ride override history,
// newest first, so the editor's publish area can show both the live
// checklist and the paper trail of any placeholder-voice publish.
export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const db = e.DB;
  const book_slug = url.searchParams.get('book_slug') || 'docker';
  const readiness = await getPublishReadiness(db, e.BOOKS, book_slug);
  if (!readiness) {
    return Response.json({ error: 'book not found' }, { status: 404 });
  }
  const overrides = await getPublishOverrides(db, book_slug);
  // Delivery readiness (the whole advertised bundle, not just the
  // audio gate) rides along; a failure computing it must never
  // break the publish gate's own view.
  let delivery = null;
  try {
    delivery = await getDeliveryReadiness(db, e.BOOKS, book_slug);
  } catch {
    delivery = null;
  }
  return Response.json({ readiness, overrides, delivery });
};
