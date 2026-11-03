import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { publishVerifiedBook, PublishBlocked } from '../../../lib/publish-gate';
import { stampPublishedAt, enqueueReleaseAnnouncements } from '../../../lib/releases';
import { ensureBookPublicSlug } from '../../../lib/public-slugs';

// POST { book_slug, publishOverride?: { reason, checks: string[], verification } }.
// Inventory and page approvals are mandatory. Readiness exceptions name the
// exact checks waived and are committed atomically with publication.
export const POST: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const db = e.DB;
  const b = await request.json().catch(() => ({}));
  let published;
  try {
    published = await publishVerifiedBook(db, e.BOOKS, b, (locals as any).user?.email ?? null);
  } catch (error) {
    if (error instanceof PublishBlocked)
      return Response.json({ ok: false, gate: error.gate, reason: error.message, blockers: error.blockers,
        verification: error.verification }, { status: error.status });
    return Response.json({ ok: false, reason: 'Publication could not be verified.' }, { status: 503 });
  }
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
  return Response.json({ ok: true, reason: 'Book published. It now appears on the storefront.', ...published,
    firstPublish, publishedAt: firstPublish ? nowSec : undefined, announcements, publicSlug });
};
