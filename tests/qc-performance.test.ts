import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fixture, identityDatabase } from './helpers/identity-fixture';
import { prepareAssembly, bytesHash } from '../packages/core/src/assembly-identity';
import { assertRevisionUnchanged } from '../packages/core/src/book-revision';
import { captureApprovalRevision, saveApprovals } from '../src/lib/approval-identity';

async function setup() {
  const f = fixture(); const { db, raw } = identityDatabase();
  raw.exec(readFileSync(new URL('../db/migrations/0004_revision_cache.sql', import.meta.url), 'utf8'));
  raw.exec('ALTER TABLE books ADD COLUMN picture_book_key TEXT;');
  raw.exec("UPDATE books SET picture_book_key = 'books/test/picture-book.pdf'");
  const input = await prepareAssembly(f.bucket, 'test', 'line');
  const sha = bytesHash(new TextEncoder().encode('PDF'));
  const receiptKey = 'books/test/assemblies/offline/receipt.json';
  f.put(receiptKey, { schema: 'assembly/v1', kind: 'picture', manifest: input.manifest, revision: input.manifest.revision, inventoryPages: 2, pdf: { sha256: sha, bytes: 3 } });
  f.put('books/test/picture-book.pdf', 'PDF', { kind: 'picture', assemblyRevision: input.manifest.revision, pdfSha256: sha, receiptKey });
  let imageReads = 0;
  const bucket = { ...f.bucket, async get(key: string) { if (/\/images(?:-color)?\//.test(key)) imageReads++; return f.bucket.get(key); } };
  return { ...f, db, raw, bucket, imageReads: () => imageReads, receiptKey };
}

test('a second Good click on unchanged verified bytes performs no image-byte reads', async () => {
  const f = await setup(); const first = await captureApprovalRevision(f.db, f.bucket, 'test');
  await saveApprovals(f.db, f.bucket, first, [first.manifest.pages[0]], true, 'offline-cg');
  const reads = f.imageReads(); const next = await captureApprovalRevision(f.db, f.bucket, 'test');
  await saveApprovals(f.db, f.bucket, next, [next.manifest.pages[1]], true, 'offline-cg');
  expect(f.imageReads() - reads).toBe(0);
});

test('a reused verified snapshot cannot hide a changed receipt or PDF metadata', async () => {
  for (const fault of ['receipt', 'metadata']) {
    const f = await setup(); const snapshot = await captureApprovalRevision(f.db, f.bucket, 'test');
    await saveApprovals(f.db, f.bucket, snapshot, [snapshot.manifest.pages[0]], true, 'offline-cg');
    if (fault === 'receipt') f.put(f.receiptKey, '{}');
    else f.values.get('books/test/picture-book.pdf')!.metadata.pdfSha256 = 'wrong';
    const next = await captureApprovalRevision(f.db, f.bucket, 'test');
    await expect(saveApprovals(f.db, f.bucket, next, [next.manifest.pages[1]], true, 'offline-cg')).rejects.toThrow();
    expect(f.raw.query('SELECT * FROM artifact_approvals').all()).toHaveLength(1);
  }
});

test('revision rechecks run with bounded concurrency and still check every object', async () => {
  let active = 0, peak = 0, seen = 0;
  const bucket = { async head(key: string) { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; seen++; return { etag: key }; } };
  const observations = Array.from({ length: 48 }, (_, i) => ({ key: String(i), etag: String(i) }));
  await assertRevisionUnchanged(bucket, observations);
  expect(seen).toBe(48); expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(12);
  await expect(assertRevisionUnchanged(bucket, [{ key: 'changed', etag: 'old' }])).rejects.toThrow('changed');
});

test('reused assembly inputs match deep capture for both editions and reject changed stamps', async () => {
  const f = await setup();
  const snapshot = await captureApprovalRevision(f.db, f.bucket, 'test');
  for (const edition of ['line', 'color'] as const) {
    const deep = await prepareAssembly(f.bucket, 'test', edition);
    const reused = await prepareAssembly(f.bucket, 'test', edition, snapshot);
    expect(reused.manifest).toEqual(deep.manifest);
  }
  f.plan.pages[0].held = true; f.save();
  const held = await captureApprovalRevision(f.db, f.bucket, 'test');
  await expect(prepareAssembly(f.bucket, 'test', 'line', held)).rejects.toThrow('held line');
});

test('one QC load shares one capture across pages, approvals and sign-offs', async () => {
  const { readReviewSession } = await import('../src/lib/review-book');
  const f = await setup();
  f.raw.exec(readFileSync(new URL('../db/migrations/0003_qc_signoffs.sql', import.meta.url), 'utf8'));
  const snapshot = await captureApprovalRevision(f.db, f.bucket, 'test');
  await saveApprovals(f.db, f.bucket, snapshot, [snapshot.manifest.pages[1]], true, 'offline-cg');
  let inventoryReads = 0;
  const books = { ...f.bucket, async get(key: string) { if (key.endsWith('/plans/S1.json')) inventoryReads++; return f.bucket.get(key); } };
  const session = await readReviewSession(f.db, books, 'test');
  expect(inventoryReads).toBe(1);
  expect(session.revision).toBe(snapshot.manifest.revision);
  expect(session.chapters[0].pages).toHaveLength(2);
  expect(session.approvals.find(p => p.chapterNum === 1 && p.pageIndex === 1)?.approved).toBe(true);
  expect(session.signoffs.story.state).toBe('outstanding');
  expect(session.signoffs.color.state).toBe('outstanding');
});
