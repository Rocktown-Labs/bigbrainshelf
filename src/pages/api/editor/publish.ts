import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { countBookPages, countApprovedPages } from '../../../lib/book-plans';
import { publishPriceStamp } from '../../../lib/offers';
import { getPdfStaleness } from '../../../lib/takes';
import {
  stampPublishedAt,
  enqueueReleaseAnnouncements,
} from '../../../lib/releases';
import {
  getPublishReadiness,
  audioGateDecision,
  recordPublishOverride,
  type PublishReadiness,
} from '../../../lib/publish-readiness';
import { ensureBookPublicSlug } from '../../../lib/public-slugs';

// POST /api/editor/publish { book_slug, audioGateOverride? } -> sets books.status='complete' only if every page approved.
//
// AUDIO GATE (checked first): the book's protagonist must be cast and
// the audiobook's voice stamp must match the cast voice (a draft read
// in a placeholder voice is a QC tool, not a shippable final). An
// unready book is refused with 409 and plain-language reasons, UNLESS
// the caller passes audioGateOverride: true, CG's deliberate
// "let it ride" click. The override waives ONLY the audio reasons;
// the page-approval requirement below is a pre-existing hard rule and
// is never bypassed by it. Every override that actually publishes is
// recorded in publish_overrides with the state it waived.
// Publishing also stamps the standard prices (offers.ts) onto any price
// field still 0/NULL, so a book can never go live sellable at $0; a
// non-zero price is deliberate and is never overwritten.
//
// A book's FIRST publish also stamps books.published_at (once, never
// overwritten) and enqueues the two release announcement waves (Book
// Club members first, subscribers after the members-first window).
// Announcements are marketing: any failure there is reported in the
// response but never fails the publish itself.
//
// The response carries pdfStaleWarning when page takes were applied
// after the last PDF assembly (the store PDFs still show the previous
// art). It is a warning only: it never blocks publishing, and any
// failure computing it leaves it null rather than breaking the publish.
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const db = e.DB;
  const b = await request.json().catch(() => ({}));
  const book_slug = b.book_slug || 'docker';
  const audioGateOverride = b.audioGateOverride === true;

  // --- Audio gate ---------------------------------------------------
  // A readiness computation failure never invents a block: readiness
  // comes back null and the gate is skipped (the readiness checklist
  // in the editor still surfaces the state on its own reads).
  let readiness: PublishReadiness | null = null;
  try {
    readiness = await getPublishReadiness(db, e.BOOKS, book_slug);
  } catch { readiness = null; }
  const gate = audioGateDecision(readiness, audioGateOverride);
  if (gate.block && readiness) {
    return Response.json(
      {
        ok: false,
        gate: 'audio',
        reason: readiness.blockers.join(' '),
        blockers: readiness.blockers,
        readiness: {
          state: readiness.state,
          protagonist: readiness.protagonist,
          castVoiceName: readiness.castVoiceName,
          audiobookVoiceName: readiness.audiobookVoiceName,
          statusLabel: readiness.statusLabel,
        },
      },
      { status: 409 }
    );
  }

  let pdfStaleWarning: string | null = null;
  try {
    const s = await getPdfStaleness(e.BOOKS, db, book_slug);
    pdfStaleWarning = s.warning;
  } catch { pdfStaleWarning = null; }

  // The book's OWN page total, from its plans in storage. (This
  // used to read a static chapters file from one book, so the
  // gate compared every book against the wrong total.)
  const totalPages = await countBookPages(e.BOOKS, book_slug);
  const approvedCount = await countApprovedPages(db, e.BOOKS, book_slug);

  if (approvedCount < totalPages) {
    return Response.json(
      { ok: false, reason: `Only ${approvedCount} of ${totalPages} pages are approved. Approve every page before publishing.`, approvedCount, totalPages, pdfStaleWarning },
      { status: 400 }
    );
  }

  const book = await db.prepare(
    'SELECT price, price_print FROM books WHERE slug = ?'
  ).bind(book_slug).first();
  const stamped = publishPriceStamp(book ?? {});

  const now = Date.now();
  await db.prepare(
    'UPDATE books SET status = ?, price = ?, price_print = ?, updated_at = ? WHERE slug = ?'
  ).bind('complete', stamped.price, stamped.price_print, now, book_slug).run();

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

  const nowSec = Math.floor(now / 1000);

  // A let-it-ride publish leaves its paper trail: what was waived and
  // the cast/audio state at the time, so the book is never later
  // mistaken for a final-voice book. Recorded only when the override
  // actually waived something and the publish itself succeeded.
  let overrideRecorded = false;
  if (gate.recordOverride && readiness) {
    try {
      await recordPublishOverride(db, readiness, nowSec);
      overrideRecorded = true;
    } catch { overrideRecorded = false; }
  }

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
  return Response.json({ ok: true, reason: 'Book published. It now appears on the storefront.', approvedCount, totalPages, pdfStaleWarning, firstPublish, publishedAt: firstPublish ? nowSec : undefined, announcements, publicSlug, audioState: readiness?.state ?? null, audioOverride: gate.recordOverride ? { recorded: overrideRecorded, state: readiness?.state ?? null } : null });
};
