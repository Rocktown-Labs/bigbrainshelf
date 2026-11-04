import { captureApprovalRevision, assertApprovedAssembly, approvalCountSql, orderedApprovalBindings } from './approval-identity';
import { assertRevisionUnchanged, revisionHash } from '../../packages/core/src/book-revision';
import { countApprovedInventory } from './book-plans';
import { getPublishReadiness } from './publish-readiness';
import { getDeliveryReadiness } from './delivery-readiness';
import { publishPriceStamp } from './offers';
import { colorEditionComplete, getSignoffStates, signoffBlockers } from './qc-signoffs';
import { recordWorkerRun } from '../../packages/core/src/run-provenance';

export class PublishBlocked extends Error {
  constructor(public gate: string, message: string, public blockers: { id: string; detail: string }[] = [], public status = 409,
    public verification?: string) {
    super(message);
  }
}

export async function publishVerifiedBook(
  db: any, books: any, input: any, actor: string | null,
  checks = { audio: getPublishReadiness, delivery: getDeliveryReadiness }, provenanceBinding?: string
) {
  const slug = typeof input.book_slug === 'string' ? input.book_slug.trim() : '';
  if (!slug) throw new PublishBlocked('request', 'book_slug is required.', [], 400);
  const book = await db.prepare('SELECT * FROM books WHERE slug = ?').bind(slug).first();
  if (!book) throw new PublishBlocked('book', 'Book not found.', [], 404);

  let captured;
  try {
    captured = await captureApprovalRevision(db, books, slug);
  } catch {
    throw new PublishBlocked('inventory', 'The book revision could not be verified. Check its bible, plans and artifacts.');
  }
  const { manifest, observations } = captured;
  try { await assertApprovedAssembly(books, manifest); }
  catch { throw new PublishBlocked('assembly', 'Assembled PDFs are stale or unverified against the current plan and artifacts. Reassemble and review before publishing.'); }
  let approvedCount: number;
  try { approvedCount = await countApprovedInventory(db, manifest); }
  catch { throw new PublishBlocked('approvals', 'Page approvals could not be verified.'); }
  if (approvedCount !== manifest.pages.length)
    throw new PublishBlocked('approvals', `Only ${approvedCount} of ${manifest.pages.length} pages are approved. Approve every page, including finales, before publishing.`);

  const blockers: { id: string; detail: string }[] = [];
  let audio = null;
  try { audio = await checks.audio(db, books, slug, { readOnly: true }); } catch { /* unknown below */ }
  if (!audio) blockers.push({ id: 'audio', detail: 'Audio readiness could not be verified.' });
  else if (!audio.ready) blockers.push({ id: 'audio', detail: audio.blockers.join(' ') });
  let delivery = null;
  try { delivery = await checks.delivery(db, books, slug, { readOnly: true }); } catch { /* unknown below */ }
  if (!delivery) blockers.push({ id: 'delivery', detail: 'Delivery readiness could not be verified.' });
  else for (const check of delivery.checks) {
    // Marketing is not part of the delivered book; product-ready is sufficient.
    if (check.id !== 'marketing-assets' && check.state !== 'pass') blockers.push({ id: `delivery:${check.id}`, detail: check.detail });
  }

  // QC sign-offs (CG, 2026-11-03): the full story and the full color
  // edition must each carry a human attestation bound to this exact
  // revision. They are gates, not readiness evidence, so the override
  // below can never waive them (enforced where waived is validated).
  try {
    const states = await getSignoffStates(db, slug, manifest.revision, colorEditionComplete(manifest));
    blockers.push(...signoffBlockers(states));
  } catch { blockers.push({ id: 'signoff:verify', detail: 'QC sign-offs could not be verified.' }); }

  // Bind the operator's confirmation to the exact revision and named evidence
  // shown in the blocked response, not merely reusable check IDs.
  const verification = revisionHash({ revision: manifest.revision, blockers });
  const override = input.publishOverride;
  if (override !== undefined && (!override || typeof override.reason !== 'string' || !override.reason.trim() ||
    override.reason.length > 2000 || !Array.isArray(override.checks) || !override.checks.length ||
    override.checks.some((id: unknown) => typeof id !== 'string') || typeof override.verification !== 'string'))
    throw new PublishBlocked('override', 'An override requires a reason, explicit check IDs and the verification fingerprint.', blockers, 400);
  if (override && !actor) throw new PublishBlocked('override', 'An authenticated operator is required for an override.', blockers, 403);
  if (override && override.verification !== verification)
    throw new PublishBlocked('override', 'Readiness changed. Review the current revision and blockers before overriding.', blockers);
  const waived = new Set<string>(override?.checks ?? []);
  if ([...waived].some(id => id.startsWith('signoff:')))
    throw new PublishBlocked('override', 'QC sign-offs cannot be overridden. Record the missing sign-off in the QC viewer.', blockers);
  if ([...waived].some(id => !blockers.some(b => b.id === id)))
    throw new PublishBlocked('override', 'Readiness changed. Review the current blockers before overriding.', blockers);
  if (blockers.some(b => !waived.has(b.id)))
    throw new PublishBlocked('readiness', blockers.map(b => b.detail).join(' '), blockers, 409, verification);

  // Recheck object versions immediately before the DB transaction. This is a
  // race detector, not a substitute for immutable release keys (next slice).
  try {
    await assertRevisionUnchanged(books, observations);
    if ((await captureApprovalRevision(db, books, slug)).manifest.revision !== manifest.revision)
      throw new Error('Revision inventory changed');
  }
  catch { throw new PublishBlocked('revision', 'Book artifacts changed during verification. Review the new revision and retry.'); }
  const now = Date.now();
  const releaseId = crypto.randomUUID();
  const prices = publishPriceStamp(book);
  const bookFields = ['updated_at', 'status', 'price', 'price_print', 'picture_book_key',
    'coloring_book_key', 'color_book_key', 'epub_key', 'audiobook_key', 'cover_key'];
  const bookFence = bookFields.map(field => `${field} IS ?`).join(' AND ');
  try {
    // D1 batch is transactional. An audit failure must roll back publication,
    // and a publication failure must roll back its audit record.
    await db.batch([
      db.prepare(`INSERT INTO publish_releases
        (id, book_slug, revision, manifest_json, checks_json, override_json, actor, created_at)
        VALUES (CASE WHEN EXISTS (SELECT 1 FROM books WHERE slug = ? AND ${bookFence})
          AND (${approvalCountSql}) = ?
          THEN ? ELSE NULL END, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(slug, ...bookFields.map(field => book[field] ?? null), ...orderedApprovalBindings(manifest), manifest.pages.length,
          releaseId, slug, manifest.revision, JSON.stringify(manifest), JSON.stringify({ audio, delivery, blockers }),
          override ? JSON.stringify({ reason: override.reason.trim(), checks: [...waived], waived: blockers, verification }) : null, actor, now),
      db.prepare('UPDATE books SET status = ?, price = ?, price_print = ?, updated_at = ? WHERE slug = ?')
        .bind('complete', prices.price, prices.price_print, now, slug),
    ]);
  } catch {
    throw new PublishBlocked('record', 'Publication could not be confirmed. Check the release journal before retrying.', [], 503);
  }
  await recordWorkerRun({ DB: db, BBS_BUILD_PROVENANCE: provenanceBinding }, {
    worker: 'bigbrainshelf', runId: releaseId, operation: 'publish', bookSlug: slug, startedAt: now,
  });
  return { slug, releaseId, revision: manifest.revision, totalPages: manifest.pages.length,
    approvedCount, audioState: audio?.state ?? 'unknown', override: override ? { recorded: true, checks: [...waived] } : null };
}
