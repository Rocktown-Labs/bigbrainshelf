import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { publishVerifiedBook, PublishBlocked, type PublishReport } from '../../../lib/publish-gate';
import { stampPublishedAt, enqueueReleaseAnnouncements } from '../../../lib/releases';
import { ensureBookPublicSlug } from '../../../lib/public-slugs';

// POST { book_slug, publishOverride?: { reason, checks: string[], verification } }.
// Inventory and page approvals are mandatory. Readiness exceptions name the
// exact checks waived and are committed atomically with publication.
//
// With { stream: true } the response is NDJSON: one { type: 'step' }
// event per real publish step (gate check, release freeze, artifact
// copy with counts, storefront flip), then a final { type: 'result' }
// event whose body mirrors the JSON contract below. The publish
// modal consumes the stream so progress is truthful, never staged.
// Without it, the plain JSON contract is unchanged.
export const POST: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const db = e.DB;
  const b = await request.json().catch(() => ({}));
  const actor = (locals as any).user?.email ?? null;

  const finish = async (published: any) => {
    const book_slug = published.slug;
    const nowSec = Math.floor(Date.now() / 1000);

    // Public slug: a book going live always owns its title-based
    // public URL (src/lib/public-slugs.ts), minted here from the title
    // when it has none, so no book ever needs a manual slug step.
    // Minting is cosmetic next to the publish itself: a failure leaves
    // publicSlug null and the book still resolves under its internal
    // slug (publicSlugFor's fallback) rather than failing the publish.
    let publicSlug: string | null = null;
    try {
      publicSlug = await ensureBookPublicSlug(db, book_slug);
    } catch { publicSlug = null; }

    let firstPublish = false;
    let announcements: { club: number; public: number } | null = null;
    try {
      firstPublish = await stampPublishedAt(db, book_slug, nowSec);
      if (firstPublish) {
        const site = e.BETTER_AUTH_URL || new URL(request.url).origin;
        announcements = await enqueueReleaseAnnouncements(db, site, book_slug, nowSec);
      }
    } catch {
      // The book is published either way; announcement problems surface
      // as announcements: null rather than a failed publish.
      announcements = null;
    }
    return { ok: true, reason: 'Book published. It now appears on the storefront.', ...published,
      firstPublish, publishedAt: firstPublish ? nowSec : undefined, announcements, publicSlug };
  };

  const refusal = (error: unknown) => error instanceof PublishBlocked
    ? { status: error.status, body: { ok: false, gate: error.gate, reason: error.message, blockers: error.blockers,
        verification: error.verification } }
    : { status: 503, body: { ok: false, reason: 'Publication could not be verified.' } };

  if (b?.stream === true) {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const send = (event: unknown) => { try { controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')); } catch { /* client gone */ } };
    const report: PublishReport = (event) => send({ type: 'step', ...event });
    (async () => {
      try {
        const published = await publishVerifiedBook(db, e.BOOKS, b, actor, undefined, e.BBS_BUILD_PROVENANCE, report);
        send({ type: 'result', status: 200, body: await finish(published) });
      } catch (error) {
        const r = refusal(error);
        send({ type: 'result', status: r.status, body: r.body });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    })();
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
  }

  let published;
  try {
    published = await publishVerifiedBook(db, e.BOOKS, b, actor, undefined, e.BBS_BUILD_PROVENANCE);
  } catch (error) {
    const r = refusal(error);
    return Response.json(r.body, { status: r.status });
  }
  return Response.json(await finish(published));
};
