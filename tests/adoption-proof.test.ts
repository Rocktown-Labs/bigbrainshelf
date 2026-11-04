import { test, expect, mock } from 'bun:test';
import { PDFDocument } from 'pdf-lib';
import { fixture, identityDatabase } from './helpers/identity-fixture';
import { planAdoption, applyAdoption } from '../factory-ops/adoption';
import { explainCountDelta } from '../factory-ops/adoption-counts';
import { bytesHash, prepareAssembly, colorIdentityCurrent } from '../packages/core/src/assembly-identity';
import { captureApprovalRevision, saveApprovals, approvedPages } from '../src/lib/approval-identity';
import { buildPictureBook, buildColoringBook } from '../factory/src/pdf';
const matter = { year: 2026, vocab: [], ageLine: 'For ages 4 to 8.', hook: '', blurb: '', learn: [], seriesLine: '' };
mock.module('../factory/src/matter', () => ({ composeMatter: () => matter }));
const { assembleVerifiedPdf } = await import('../factory/src/assembly');
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64'));

async function legacyPdfFixture() {
  const f = fixture(); const auditRows: any[] = [];
  for (const [pg, stem, page] of [[f.plan.pages[0], 'page-0', 'S1p0'], [f.plan.finale, 'finale', 'S1 finale']] as const) {
    delete pg.lineIdentity; delete pg.colorIdentity;
    f.put(`books/test/images/S1-${stem}.jpg`, png); f.put(pg.imageColorKey, png);
    auditRows.push({ page, key: `books/test/images/S1-${stem}.jpg`, sha256: bytesHash(png), bytes: png.length });
  }
  for (const key of ['cover.jpg', 'back-cover-color.jpg', 'back-cover-line.jpg']) f.put(`books/test/${key}`, png);
  f.save();
  const inputs = [f.plan.pages[0], f.plan.finale].map(pg => ({ image: png, story: pg.storyText, caption: pg.storyText }));
  const fullMatter = { ...matter, backImage: png, backLineImage: png };
  const pdf = await buildPictureBook('Test', inputs, null, ['One'], fullMatter, png);
  const coloring = await buildColoringBook('Test', inputs, ['One'], fullMatter, png);
  f.put('books/test/picture-book.pdf', pdf); f.put('books/test/coloring-book.pdf', coloring); f.put('books/test/picture-book-color.pdf', pdf);
  const legacyCount = (await PDFDocument.load(pdf)).getPageCount();
  const evidence = {
    inventory: JSON.stringify({ slug: 'test', chapters_found: ['S1'], planned_pages: 2, planned_story_pages: 1, line_images: 2, color_images: 2, pdf_pages: { picture: legacyCount, coloring: legacyCount, color: legacyCount } }),
    line: JSON.stringify({ slug: 'test', edition: 'line', results: auditRows }),
    color: JSON.stringify({ slug: 'test', edition: 'color', results: auditRows.map(r => ({ ...r, key: r.key.replace('/images/', '/images-color/'), lineSha256: r.sha256 })) }),
    bookQa: JSON.stringify({ slug: 'test', source: 'offline-only', measured_at: 1, line_purity: 0 }),
  };
  for (const [role, raw] of Object.entries(evidence)) if (role !== 'bookQa') f.put(`books/test/audit/${role === 'inventory' ? 'inventory' : `cast-audit-${role}`}.json`, raw);
  const writes: string[] = []; const ledger: any[] = [];
  const bucket: any = { ...f.bucket, async put(key: string, value: any, opts: any) {
    if (opts?.onlyIf && f.values.get(key)?.version !== opts.onlyIf.etagMatches) return null;
    writes.push(key); f.put(key, value, opts?.customMetadata); return { etag: f.values.get(key)!.version };
  } };
  return { ...f, bucket, evidence, writes, ledger, legacyCount };
}

test('adoption alters only plans, then reassembly and approvals validate the adopted inventory with unchanged counts', async () => {
  const f = await legacyPdfFixture(); const original = new Map([...f.values].map(([key, v]) => [key, bytesHash(v.bytes)]));
  const report = await planAdoption(f.bucket, 'test', f.evidence);
  expect(report.proof.status).toBe('explained'); expect(report.proof.expected).toBe(f.legacyCount);
  await applyAdoption(f.bucket, report, report.fingerprint, async event => { f.ledger.push(event); });
  expect(f.writes.every(key => key.includes('/plans/'))).toBe(true);
  for (const [key, hash] of original) if (!key.includes('/plans/')) expect(bytesHash(f.values.get(key)!.bytes)).toBe(hash);
  for (const edition of ['line', 'color'] as const) expect((await prepareAssembly(f.bucket, 'test', edition)).entries).toHaveLength(2);
  const adopted = JSON.parse(new TextDecoder().decode(f.values.get('books/test/plans/S1.json')!.bytes));
  expect(colorIdentityCurrent(f.bible, adopted, adopted.pages[0], bytesHash(png), bytesHash(png))).toBe(true);
  const { db, raw } = identityDatabase();
  raw.exec('ALTER TABLE books ADD COLUMN picture_book_key TEXT; ALTER TABLE books ADD COLUMN coloring_book_key TEXT; ALTER TABLE books ADD COLUMN color_book_key TEXT;');
  for (const [kind, field] of [['picture', 'picture_book_key'], ['coloring', 'coloring_book_key'], ['color', 'color_book_key']] as const) {
    const result = await assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', kind);
    expect(result.totalPages).toBe(report.proof.expected);
    expect(result.totalPages).toBe(f.legacyCount);
    raw.query(`UPDATE books SET ${field} = ?`).run(result.key);
  }
  const snapshot = await captureApprovalRevision(db, f.bucket, 'test');
  await saveApprovals(db, f.bucket, snapshot, snapshot.manifest.pages, true, 'offline-cg');
  expect(await approvedPages(db, snapshot.manifest)).toHaveLength(2);
});

test.each([
  ['algorithms', 'coloring', 55, 67, 12, 'omitted-coloring-finales'],
  ['docker', 'picture', 95, 78, 18, 'legacy-chapter-divider-pages:17'],
  ['mira-the-heron-and-the-still-water', 'picture', 46, 45, 8, 'mira-legacy-extra-page:1'],
  ['mira-the-heron-and-the-still-water', 'coloring', 38, 45, 8, 'omitted-coloring-finales'],
] as const)('%s %s delta is explained only by a named known defect', (slug, kind, legacy, expected, finales, defect) => {
  const proof = explainCountDelta(slug, kind, legacy, expected, finales);
  expect(proof.status).toBe('explained'); expect(proof.defects).toContain(defect);
});

test('unexplained PDF delta blocks proof, while independently evidenced pages remain adoptable', async () => {
  const f = await legacyPdfFixture(); const pdf = await PDFDocument.create(); pdf.addPage(); f.put('books/test/picture-book.pdf', await pdf.save());
  const inv = JSON.parse(f.evidence.inventory); inv.pdf_pages.picture = 1; f.evidence.inventory = JSON.stringify(inv); f.put('books/test/audit/inventory.json', f.evidence.inventory);
  const report = await planAdoption(f.bucket, 'test', f.evidence);
  expect(report.proof.status).toBe('blocked'); expect(report.proof.results.find(r => r.kind === 'picture')?.defects).toContain('unexplained-page-count-delta');
  expect(report.canApply).toBe(true);
});
