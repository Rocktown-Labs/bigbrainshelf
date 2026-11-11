import { readRevisionPrintables } from './release-printables';
import { prepareAssembly } from '../../packages/core/src/assembly-identity';
import { captureBookRevision, readPlanInventory, revisionHash, assertRevisionUnchanged, type BookRevision, type RevisionPage } from '../../packages/core/src/book-revision';

/** Bounded-concurrency map for HEAD probes; order of results matches input. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function captureApprovalRevision(db: any, books: any, slug: string, options: { readOnly?: boolean } = {}) {
  const book = await db.prepare('SELECT * FROM books WHERE slug = ?').bind(slug).first();
  if (!book) throw new Error('Book not found');
  const targets = ['picture_book_key', 'coloring_book_key', 'color_book_key', 'epub_key', 'audiobook_key', 'cover_key']
    .filter(field => book[field]).map(field => ({ key: String(book[field]), role: field }));
  // Matter and composed covers affect the reviewed book even before a DB key is set.
  const coverFiles = ['cover.jpg', 'cover-titled.jpg', 'back-cover-color.jpg', 'back-cover-line.jpg'];
  const coverHeads = await Promise.all(coverFiles.map(async (file) => {
    const key = `books/${slug}/${file}`;
    return { key, file, exists: targets.some(a => a.key === key) ? false : !!(await books.head(key).catch(() => null)) };
  }));
  for (const h of coverHeads) if (h.exists) targets.push({ key: h.key, role: h.file });
  const printables = await readRevisionPrintables(db, slug);
  for (const p of printables) targets.push({ key: p.interiorKey, role: `print:${p.kind}:interior` }, { key: p.coverKey, role: `print:${p.kind}:cover` });
  const inventory = await readPlanInventory(books, slug);

  // Version fingerprint (2026-11-06): the deep capture below reads
  // and SHA-256s every artifact in the book, which is the right
  // check when something changed and a punishing one on every QC
  // click (100+ MB per click; most clicks died before they saved).
  // HEAD every artifact the capture covers and fingerprint the
  // etags: when a byte-verified manifest is cached under that
  // fingerprint, reuse it. Any artifact change moves an etag,
  // misses the cache, and re-runs the deep capture. The etag is a
  // version identifier, not a content hash; the manifest in the
  // cache was still derived from a full byte capture, and publish
  // keeps its own deep assembly verification.
  const versioned = new Map<string, string>();
  for (const s of inventory.sources) if (s.etag) versioned.set(s.key, s.etag);
  const probeKeys = new Set<string>();
  for (const p of inventory.pages) { probeKeys.add(p.lineKey); if (p.colorKey) probeKeys.add(p.colorKey); }
  for (const t of targets) probeKeys.add(t.key);
  const headKeys = [...probeKeys].filter(k => !versioned.has(k));
  const heads = await mapPool(headKeys, 32, async (key) => ({ key, head: await books.head(key).catch(() => null) }));
  let fingerprint: string | null = null;
  if (heads.every(h => h.head && h.head.etag)) {
    for (const h of heads) versioned.set(h.key, h.head.etag);
    fingerprint = revisionHash({
      slug,
      targets: targets.map(t => [t.key, t.role]),
      ...(printables.length ? { printables } : {}),
      versions: [...versioned.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    });
    try {
      const row = await db.prepare('SELECT manifest_json FROM revision_cache WHERE book_slug = ? AND fingerprint = ?').bind(slug, fingerprint).first();
      const manifest = row?.manifest_json ? JSON.parse(row.manifest_json) : null;
      if (manifest && manifest.slug === slug && typeof manifest.revision === 'string' && Array.isArray(manifest.pages) && Array.isArray(manifest.artifacts)) {
        // Cached manifests written before the uploaded map existed
        // lack it; the HEAD probes above already touched every page
        // key, so backfill currency evidence from them.
        const uploaded: Record<string, string> = { ...(manifest.uploaded ?? {}) };
        for (const h of heads) {
          const up = (h.head as any)?.uploaded;
          if (up && !uploaded[h.key]) uploaded[h.key] = up instanceof Date ? up.toISOString() : String(up);
        }
        return { manifest: { ...manifest, uploaded }, observations: [...versioned.entries()].map(([key, etag]) => ({ key, etag })), inventory };
      }
    } catch { /* the cache is an optimization; the deep path is the truth */ }
  }

  const deep = await captureBookRevision(books, slug, targets, inventory);
  if (printables.length) {
    // uploaded rides along outside the hash: folding timestamps into
    // the revision would move the revision on every re-upload and
    // orphan attestations whose content never changed.
    const { revision: _revision, uploaded, ...payload } = deep.manifest;
    const withPrint = { ...payload, printables };
    deep.manifest = { ...withPrint, ...(uploaded ? { uploaded } : {}), revision: revisionHash(withPrint) };
  }
  if (fingerprint && !options.readOnly) {
    // Cache only when the byte capture observed exactly the versions
    // the fingerprint was built from. A mid-capture change skips the
    // write; the next request fingerprints fresh either way.
    const observed = new Map(deep.observations.map(o => [o.key, o.etag]));
    if (observed.size === versioned.size && [...versioned.entries()].every(([k, v]) => observed.get(k) === v)) {
      try {
        await db.prepare('INSERT OR REPLACE INTO revision_cache (book_slug, fingerprint, manifest_json, captured_at) VALUES (?, ?, ?, ?)')
          .bind(slug, fingerprint, JSON.stringify(deep.manifest), new Date().toISOString()).run();
      } catch { /* best-effort */ }
    }
  }
  return { ...deep, inventory };
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
export async function assertApprovedAssembly(books: any, manifest: BookRevision, verified?: { inventory: Awaited<ReturnType<typeof readPlanInventory>>; observations: { key: string; etag: string }[] }) {
  const inputs = new Map<string, string>();
  for (const artifact of manifest.artifacts.filter(a => ['picture_book_key', 'coloring_book_key', 'color_book_key'].includes(a.role))) {
    const edition = artifact.role === 'color_book_key' ? 'color' : 'line';
    const kind = artifact.role === 'color_book_key' ? 'color' : artifact.role === 'coloring_book_key' ? 'coloring' : 'picture';
    if (!inputs.has(edition)) inputs.set(edition, (await prepareAssembly(books, manifest.slug, edition, verified ? { ...verified, manifest } : undefined)).manifest.revision);
    const head = await books.head(artifact.key);
    const metadata = head?.customMetadata;
    if (metadata?.kind !== kind || metadata?.assemblyRevision !== inputs.get(edition) || metadata?.pdfSha256 !== artifact.sha256 ||
      typeof metadata?.receiptKey !== 'string' || !metadata.receiptKey.startsWith(`books/${manifest.slug}/assemblies/`) || metadata.receiptKey.includes('..'))
      throw new Error(`Stale or unverifiable assembled PDF: ${artifact.key}`);
    const receiptObject = await books.get(metadata.receiptKey);
    if (!receiptObject) throw new Error(`Assembly receipt missing: ${artifact.key}`);
    const receipt = JSON.parse(new TextDecoder().decode(await receiptObject.arrayBuffer()));
    const { revision, uploaded: _uploaded, ...payload } = receipt.manifest ?? {};
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
    if (approved) await assertApprovedAssembly(books, manifest, current);
  } catch (error) {
    throw new ApprovalIdentityError(error instanceof Error ? error.message : 'Book artifact identity is unverified');
  }
  const at = new Date().toISOString();
  await db.batch(pages.map(p => db.prepare(`INSERT INTO artifact_approvals
    (book_slug, chapter_num, page_index, revision, artifact_hash, manifest_json, actor, approved, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(manifest.slug, p.chapter, p.page, manifest.revision, pageApprovalHash(manifest, p), JSON.stringify(manifest), actor, approved ? 1 : 0, at)));
}
