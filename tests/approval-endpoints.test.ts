import { test, expect, mock } from 'bun:test';
import { fixture, identityDatabase } from './helpers/identity-fixture';
import { captureApprovalRevision } from '../src/lib/approval-identity';
import { readReviewBook } from '../src/lib/review-book';
const bindings: any = {};
mock.module('cloudflare:workers', () => ({ env: bindings }));
const approvals = await import('../src/pages/api/editor/approvals');
const bulk = await import('../src/pages/api/editor/approvals-bulk');
const media = await import('../src/pages/api/admin/media');
function request(body: any) { return { request: new Request('https://example.test/', { method: 'POST', body: JSON.stringify(body) }) } as any; }
function setup() { const f = fixture(); const d = identityDatabase(); bindings.BOOKS = f.bucket; bindings.DB = d.db; return { ...f, ...d }; }

test('single and bulk approvals require the revision actually reviewed; no stale tab can approve new bytes', async () => {
  const f = setup(); const snapshot = await captureApprovalRevision(f.db, f.bucket, 'test');
  for (const endpoint of [approvals, bulk]) {
    expect((await endpoint.POST(request({ book_slug: 'test', chapterNum: 1, pageIndex: 0, approved: true }))).status).toBe(409);
    f.put('books/test/images/S1-page-0.jpg', 'EDIT');
    expect((await endpoint.POST(request({ book_slug: 'test', chapterNum: 1, pageIndex: 0, approved: true, revision: snapshot.manifest.revision }))).status).toBe(409);
  }
  expect(f.raw.query('SELECT * FROM artifact_approvals').all()).toHaveLength(0);
});

test('GET reports current revision approvals including finale and cover; removed revision approvals do not survive', async () => {
  const f = setup(); const { manifest } = await captureApprovalRevision(f.db, f.bucket, 'test');
  for (const [chapterNum, pageIndex] of [[1, 0], [1, 1], [0, 0]]) {
    expect((await approvals.POST(request({ book_slug: 'test', chapterNum, pageIndex, approved: true, revision: manifest.revision }))).status).toBe(200);
  }
  const get = () => approvals.GET({ url: new URL('https://example.test/?book_slug=test') } as any).then(r => r.json());
  expect((await get()).filter((r: any) => r.approved)).toHaveLength(3);
  f.put('books/test/cover.jpg', 'CHANGED');
  expect((await get()).filter((r: any) => r.approved)).toHaveLength(0);
  expect(f.raw.query('SELECT * FROM artifact_approvals').all()).toHaveLength(3);
});

test('QC review uses canonical plans including finales and pins the bytes it asks media to serve', async () => {
  const f = setup(); f.put('books/test/editor_chapters.json', [{ pages: [{ text: 'stale' }] }]);
  const review = await readReviewBook(f.db, f.bucket, 'test');
  expect(review.chapters[0].pages.map(p => p.text)).toEqual(['Story', 'Finale']);
  const url = new URL(review.chapters[0].pages[0].image, 'https://example.test');
  const context = { request: new Request(url), url, locals: { user: { id: 'cg' } } } as any;
  expect((await media.GET(context)).status).toBe(200);
  f.put('books/test/images/S1-page-0.jpg', 'EDIT');
  expect((await media.GET(context)).status).toBe(409);
});
