import { captureBookRevision, assertRevisionUnchanged, revisionHash } from '../../packages/core/src/book-revision';
import { countApprovedInventory } from './book-plans';
import { getPublishReadiness } from './publish-readiness';
import { getDeliveryReadiness } from './delivery-readiness';
import { publishPriceStamp } from './offers';

export class PublishBlocked extends Error {
  constructor(public gate: string, message: string, public blockers: { id: string; detail: string }[] = [], public status = 409,
    public verification?: string) {
    super(message);
  }
}

export async function publishVerifiedBook(
  db: any, books: any, input: any, actor: string | null,
  checks = { audio: getPublishReadiness, delivery: getDeliveryReadiness }
) {
  const slug = typeof input.book_slug === 'string' ? input.book_slug.trim() : '';
  if (!slug) throw new PublishBlocked('request', 'book_slug is required.', [], 400);
  const book = await db.prepare('SELECT * FROM books WHERE slug = ?').bind(slug).first();
  if (!book) throw new PublishBlocked('book', 'Book not found.', [], 404);

  let captured;
  try {
    const deliverables = ['picture_book_key', 'coloring_book_key', 'color_book_key', 'epub_key', 'audiobook_key', 'cover_key']
      .filter(field => book[field]).map(field => ({ key: String(book[field]), role: field }));
    captured = await captureBookRevision(books, slug, deliverables);
  } catch {
    throw new PublishBlocked('inventory', 'The book revision could not be verified. Check its bible, plans and artifacts.');
  }
  const { manifest, observations } = captured;
  let approvedCount: number;
  try { approvedCount = await countApprovedInventory(db, slug, manifest.pages); }
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
  if ([...waived].some(id => !blockers.some(b => b.id === id)))
    throw new PublishBlocked('override', 'Readiness changed. Review the current blockers before overriding.', blockers);
  if (blockers.some(b => !waived.has(b.id)))
    throw new PublishBlocked('readiness', blockers.map(b => b.detail).join(' '), blockers, 409, verification);

  // Recheck object versions immediately before the DB transaction. This is a
  // race detector, not a substitute for immutable release keys (next slice).
  try { await assertRevisionUnchanged(books, observations); }
  catch { throw new PublishBlocked('revision', 'Book artifacts changed during verification. Review the new revision and retry.'); }
  const now = Date.now();
  const releaseId = crypto.randomUUID();
  const prices = publishPriceStamp(book);
  const bookFields = ['updated_at', 'status', 'price', 'price_print', 'picture_book_key',
    'coloring_book_key', 'color_book_key', 'epub_key', 'audiobook_key', 'cover_key'];
  const bookFence = bookFields.map(field => `${field} IS ?`).join(' AND ');
  const approvalFence = manifest.pages.map(() => '(chapter_num = ? AND page_index = ?)').join(' OR ');
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS publish_releases (
      id TEXT PRIMARY KEY NOT NULL, book_slug TEXT NOT NULL, revision TEXT NOT NULL,
      manifest_json TEXT NOT NULL, checks_json TEXT NOT NULL, override_json TEXT,
      actor TEXT, created_at INTEGER NOT NULL
    )`).run();
    // D1 batch is transactional. An audit failure must roll back publication,
    // and a publication failure must roll back its audit record.
    await db.batch([
      db.prepare(`INSERT INTO publish_releases
        (id, book_slug, revision, manifest_json, checks_json, override_json, actor, created_at)
        VALUES (CASE WHEN EXISTS (SELECT 1 FROM books WHERE slug = ? AND ${bookFence})
          AND (SELECT COUNT(DISTINCT chapter_num || ':' || page_index) FROM page_approvals
            WHERE book_slug = ? AND approved = 1 AND (${approvalFence})) = ?
          THEN ? ELSE NULL END, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(slug, ...bookFields.map(field => book[field] ?? null), slug,
          ...manifest.pages.flatMap(p => [p.chapter, p.page]), manifest.pages.length,
          releaseId, slug, manifest.revision, JSON.stringify(manifest), JSON.stringify({ audio, delivery, blockers }),
          override ? JSON.stringify({ reason: override.reason.trim(), checks: [...waived], waived: blockers, verification }) : null, actor, now),
      db.prepare('UPDATE books SET status = ?, price = ?, price_print = ?, updated_at = ? WHERE slug = ?')
        .bind('complete', prices.price, prices.price_print, now, slug),
    ]);
  } catch {
    throw new PublishBlocked('record', 'Publication could not be confirmed. Check the release journal before retrying.', [], 503);
  }
  return { slug, releaseId, revision: manifest.revision, totalPages: manifest.pages.length,
    approvedCount, audioState: audio?.state ?? 'unknown', override: override ? { recorded: true, checks: [...waived] } : null };
}
