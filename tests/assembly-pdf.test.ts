import { test, expect, mock } from 'bun:test';
import { PDFDocument } from 'pdf-lib';
import { captureApprovalRevision, saveApprovals } from '../src/lib/approval-identity';
import { fixture, identityDatabase } from './helpers/identity-fixture';
import { stampLine, stampColor } from '../packages/core/src/assembly-identity';
// Isolate pure assembly from the generator imports in matter.ts. No model transport exists.
mock.module('../factory/src/matter', () => ({ composeMatter: () => ({ year: 2026, vocab: [], ageLine: 'For ages 4 to 8.', hook: '', blurb: '', learn: [], seriesLine: '' }) }));
const { assembleVerifiedPdf } = await import('../factory/src/assembly');
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64'));

function pdfFixture() {
  const f = fixture();
  for (const [pg, stem] of [[f.plan.pages[0], 'page-0'], [f.plan.finale, 'finale']] as const) {
    stampLine(f.bible, f.plan, pg, png); stampColor(f.bible, f.plan, pg, png, png);
    f.put(`books/test/images/S1-${stem}.jpg`, png); f.put(pg.imageColorKey, png);
  }
  f.save();
  for (const name of ['cover.jpg', 'back-cover-color.jpg', 'back-cover-line.jpg']) f.put(`books/test/${name}`, png);
  const writes: string[] = [];
  const bucket: any = { ...f.bucket, async put(key: string, bytes: any, options: any) { writes.push(key); f.put(key, bytes, options?.customMetadata); } };
  return { ...f, bucket, writes };
}

test('real PDFs include both story and finale, with reconciled total page counts and append-only receipts', async () => {
  const f = pdfFixture();
  for (const kind of ['coloring', 'picture', 'color'] as const) {
    const result = await assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', kind);
    expect(result.pages).toBe(2);
    // Cover, copyright, contents, two interiors, and back cover; empty glossary contributes none.
    expect(result.totalPages).toBe(6);
    expect((await PDFDocument.load(f.values.get(result.key)!.bytes)).getPageCount()).toBe(result.totalPages);
  }
  const receipts = f.writes.filter(key => key.endsWith('/receipt.json'));
  expect(receipts).toHaveLength(3);
  for (const key of receipts) expect(JSON.parse(new TextDecoder().decode(f.values.get(key)!.bytes))).toMatchObject({ inventoryPages: 2, totalPages: 6 });
});

test.each(['missing-plan', 'missing-line', 'missing-finale', 'missing-color', 'held', 'color-held'])('%s never installs a PDF', async fault => {
  const f = pdfFixture();
  if (fault === 'missing-plan') f.values.delete('books/test/plans/S1.json');
  if (fault === 'missing-line') f.values.delete('books/test/images/S1-page-0.jpg');
  if (fault === 'missing-finale') f.values.delete('books/test/images/S1-finale.jpg');
  if (fault === 'missing-color') f.values.delete(f.plan.finale.imageColorKey);
  if (fault === 'held') { f.plan.pages[0].held = true; f.save(); }
  if (fault === 'color-held') { f.plan.finale.colorHeld = true; f.save(); }
  await expect(assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'color')).rejects.toThrow();
  expect(f.writes).toHaveLength(0);
});

test('revision change between base PDFs blocks before building the second PDF', async () => {
  const f = pdfFixture(); const first = await assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'coloring');
  f.plan.pages[0].storyText = 'new'; stampLine(f.bible, f.plan, f.plan.pages[0], png); f.save();
  const writes = f.writes.length;
  await expect(assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'picture', first.revision)).rejects.toThrow('revision');
  expect(f.writes).toHaveLength(writes);
});


test.each(['picture', 'coloring'] as const)('base %s assembly rejects held pages', async kind => {
  const f = pdfFixture(); f.plan.finale.held = true; f.save();
  await expect(assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', kind)).rejects.toThrow('held');
  expect(f.writes).toHaveLength(0);
});

test('a source change while persisting a candidate retains evidence but never installs it', async () => {
  const f = pdfFixture(); const put = f.bucket.put;
  f.bucket.put = async (key: string, bytes: any) => {
    await put(key, bytes);
    if (key.endsWith('/receipt.json')) { f.plan.pages[0].held = true; f.save(); }
  };
  await expect(assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'picture')).rejects.toThrow('held');
  expect(f.writes.filter(key => key.includes('/assemblies/') && key.endsWith('.pdf'))).toHaveLength(1);
  expect(f.writes.filter(key => key.endsWith('/receipt.json'))).toHaveLength(1);
  expect(f.values.has('books/test/picture-book.pdf')).toBe(false);
});


test('approval requires PDF provenance for the current inputs and rejects bytes changed after approval', async () => {
  const f = pdfFixture(); const { db, raw } = identityDatabase();
  const assembled = await assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'picture');
  raw.exec("ALTER TABLE books ADD COLUMN picture_book_key TEXT");
  raw.query('UPDATE books SET picture_book_key = ?').run(assembled.key);
  const snapshot = await captureApprovalRevision(db, f.bucket, 'test');
  await saveApprovals(db, f.bucket, snapshot, snapshot.manifest.pages, true, 'cg');
  expect(raw.query('SELECT actor FROM artifact_approvals LIMIT 1').get()).toEqual({ actor: 'cg' });
  f.put(assembled.key, new Uint8Array([1, 2, 3]));
  const changed = await captureApprovalRevision(db, f.bucket, 'test');
  await expect(saveApprovals(db, f.bucket, changed, changed.manifest.pages, true)).rejects.toThrow('PDF');
  expect(raw.query('SELECT * FROM artifact_approvals').all()).toHaveLength(2);
});

test('new page art cannot be approved alongside an older assembled download', async () => {
  const f = pdfFixture(); const { db, raw } = identityDatabase();
  const assembled = await assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'picture');
  raw.exec("ALTER TABLE books ADD COLUMN picture_book_key TEXT");
  raw.query('UPDATE books SET picture_book_key = ?').run(assembled.key);
  f.plan.pages[0].storyText = 'changed'; stampLine(f.bible, f.plan, f.plan.pages[0], png); f.save();
  const changed = await captureApprovalRevision(db, f.bucket, 'test');
  await expect(saveApprovals(db, f.bucket, changed, changed.manifest.pages, true)).rejects.toThrow('PDF');
  expect(raw.query('SELECT * FROM artifact_approvals').all()).toHaveLength(0);
});
