import { prepareAssembly } from '../../packages/core/src/assembly-identity';
import { captureBookRevision, readPlanInventory, revisionHash, assertRevisionUnchanged, type BookRevision, type RevisionPage } from '../../packages/core/src/book-revision';

export async function captureApprovalRevision(db: any, books: any, slug: string) {
  const book = await db.prepare('SELECT * FROM books WHERE slug = ?').bind(slug).first();
  if (!book) throw new Error('Book not found');
  const targets = ['picture_book_key', 'coloring_book_key', 'color_book_key', 'epub_key', 'audiobook_key', 'cover_key']
    .filter(field => book[field]).map(field => ({ key: String(book[field]), role: field }));
  // Matter and composed covers affect the reviewed book even before a DB key is set.
  for (const file of ['cover.jpg', 'cover-titled.jpg', 'back-cover-color.jpg', 'back-cover-line.jpg']) {
    const key = `books/${slug}/${file}`;
    if (!targets.some(a => a.key === key) && await books.head(key)) targets.push({ key, role: file });
  }
  const inventory = await readPlanInventory(books, slug);
  return { ...await captureBookRevision(books, slug, targets, inventory), inventory };
}
// Viewer chapter 0 marks cover/matter. They share the whole revision identity.
export function approvalTargets(manifest: BookRevision): RevisionPage[] {
  return [...manifest.pages, ...Array.from({ length: 5 }, (_, page) => ({
    id: `matter:${page}`, chapter: 0, page, kind: 'story' as const,
    planKey: `books/${manifest.slug}/bible.json`, lineKey: `books/${manifest.slug}/cover.jpg`, colorKey: null,
  }))];
}
export function pageApprovalHash(manifest: BookRevision, page: RevisionPage) {
  return revisionHash({ page, artifacts: page.chapter === 0 ? manifest.artifacts : manifest.artifacts.filter(a => [page.lineKey, page.colorKey, page.planKey].includes(a.key)) });
}
export function approvalBindings(manifest: BookRevision, includeMatter = false) {
  return [manifest.slug, manifest.revision, JSON.stringify((includeMatter ? approvalTargets(manifest) : manifest.pages).map(p => ({ chapter: p.chapter, page: p.page, hash: pageApprovalHash(manifest, p) })))];
}
/** One JSON binding avoids a variable per page and the D1 parameter ceiling. */
export const approvedRowsSql = `SELECT a.* FROM artifact_approvals a JOIN json_each(?) expected
  ON a.chapter_num = json_extract(expected.value, '$.chapter') AND a.page_index = json_extract(expected.value, '$.page')
  AND a.artifact_hash = json_extract(expected.value, '$.hash')
  WHERE a.book_slug = ? AND a.revision = ? AND a.approved = 1
  AND NOT EXISTS (SELECT 1 FROM artifact_approvals newer WHERE newer.book_slug = a.book_slug
    AND newer.revision = a.revision AND newer.chapter_num = a.chapter_num AND newer.page_index = a.page_index AND newer.id > a.id)`;
export const approvalCountSql = `SELECT COUNT(*) FROM (${approvedRowsSql})`;
export function orderedApprovalBindings(manifest: BookRevision, includeMatter = false) {
  const [slug, revision, pages] = approvalBindings(manifest, includeMatter); return [pages, slug, revision];
}
export async function approvedPages(db: any, manifest: BookRevision, includeMatter = false) {
  const { results } = await db.prepare(approvedRowsSql).bind(...orderedApprovalBindings(manifest, includeMatter)).all();
  return results ?? [];
}
export async function assertApprovedAssembly(books: any, manifest: BookRevision) {
  const inputs = new Map<string, string>();
  for (const artifact of manifest.artifacts.filter(a => ['picture_book_key', 'coloring_book_key', 'color_book_key'].includes(a.role))) {
    const edition = artifact.role === 'color_book_key' ? 'color' : 'line';
    const kind = artifact.role === 'color_book_key' ? 'color' : artifact.role === 'coloring_book_key' ? 'coloring' : 'picture';
    if (!inputs.has(edition)) inputs.set(edition, (await prepareAssembly(books, manifest.slug, edition)).manifest.revision);
    const head = await books.head(artifact.key);
    const metadata = head?.customMetadata;
    if (metadata?.kind !== kind || metadata?.assemblyRevision !== inputs.get(edition) || metadata?.pdfSha256 !== artifact.sha256 ||
      typeof metadata?.receiptKey !== 'string' || !metadata.receiptKey.startsWith(`books/${manifest.slug}/assemblies/`) || metadata.receiptKey.includes('..'))
      throw new Error(`Stale or unverifiable assembled PDF: ${artifact.key}`);
    const receiptObject = await books.get(metadata.receiptKey);
    if (!receiptObject) throw new Error(`Assembly receipt missing: ${artifact.key}`);
    const receipt = JSON.parse(new TextDecoder().decode(await receiptObject.arrayBuffer()));
    const { revision, ...payload } = receipt.manifest ?? {};
    if (receipt.kind !== kind || receipt.schema !== 'assembly/v1' || revisionHash(payload) !== revision || revision !== inputs.get(edition) ||
      receipt.revision !== revision || receipt.pdf?.sha256 !== artifact.sha256 || receipt.pdf?.bytes !== artifact.bytes ||
      receipt.inventoryPages !== manifest.pages.length)
      throw new Error(`Assembly receipt does not match current PDF inputs: ${artifact.key}`);
  }
}
export class ApprovalIdentityError extends Error {}
export async function saveApprovals(db: any, books: any, snapshot: Awaited<ReturnType<typeof captureApprovalRevision>>, pages: RevisionPage[], approved: boolean, actor: string | null = null) {
  const { manifest } = snapshot;
  for (const page of pages) if (!approvalTargets(manifest).some(p => p.id === page.id && p.page === page.page && p.chapter === page.chapter)) throw new Error('Page outside revision inventory');
  try {
    const current = await captureApprovalRevision(db, books, manifest.slug);
    if (current.manifest.revision !== manifest.revision) throw new Error('Book changed since review. Reload before approving.');
    await assertRevisionUnchanged(books, snapshot.observations);
    if (approved) await assertApprovedAssembly(books, manifest);
  } catch (error) {
    throw new ApprovalIdentityError(error instanceof Error ? error.message : 'Book artifact identity is unverified');
  }
  const at = new Date().toISOString();
  await db.batch(pages.map(p => db.prepare(`INSERT INTO artifact_approvals
    (book_slug, chapter_num, page_index, revision, artifact_hash, manifest_json, actor, approved, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(manifest.slug, p.chapter, p.page, manifest.revision, pageApprovalHash(manifest, p), JSON.stringify(manifest), actor, approved ? 1 : 0, at)));
}
