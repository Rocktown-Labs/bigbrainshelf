import { test, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { revisionHash } from '../packages/core/src/book-revision';
import { sha256Hex } from '../packages/core/src/sha256';
import { freezeArtifactRelease } from '../src/lib/artifact-releases';
import { releaseBucket, installReleaseSchema } from './helpers/release-fixture';

const env: any = {}; let downloads = 0, owns = true, failStamp = false, stampKey = '';
mock.module('cloudflare:workers', () => ({ env }));
mock.module('../src/lib/auth', () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { id: 'u1', email: 'fixture@example.test' } }) } }) }));
mock.module('../src/lib/library', () => ({ getDigitalEntitlements: async () => new Map([['test', {}]]), entitlementDownloads: () => owns }));
mock.module('../src/lib/download-guard', () => ({ resolveOrderGrant: async () => ({ grantKey: 'order1', orderId: 'order1', marker: 'order1', buyerEmail: 'fixture@example.test' }), resolveBoxGrant: async () => null,
  consumeDownload: async () => { downloads++; return { ok: true }; }, DOWNLOAD_LIMIT_MESSAGE: 'cap' }));
mock.module('../src/lib/metrics', () => ({ emitStoreEvent() {} }));
mock.module('../src/lib/family', () => ({ listKidProfiles: async () => [] }));
mock.module('../src/lib/serials', () => ({ getOrMintDownloadSerial: async () => null, serialLabel: () => '' }));
mock.module('../src/lib/pdf-stamp', () => ({ stampPdfForBuyer: async (bytes: Uint8Array) => bytes }));
mock.module('../src/lib/m4b-stamp', () => ({ serveStampedM4b: async (_books: any, key: string, obj: any) => { stampKey = key; if (failStamp) throw new Error('fixture stamp failure'); return { body: obj.body }; } }));
const { GET } = await import('../src/pages/api/download');

async function fixture() {
  downloads = 0; owns = true; failStamp = false;
  const raw = new Database(':memory:'); installReleaseSchema(raw);
  raw.exec("CREATE TABLE books (slug TEXT, title TEXT, public_slug TEXT, picture_book_key TEXT, coloring_book_key TEXT, color_book_key TEXT, epub_key TEXT, audiobook_key TEXT); INSERT INTO books VALUES ('test','Test','public-test','books/test/live.pdf',null,null,null,'books/test/live.m4b');");
  const db = { prepare(sql: string) { let values: any[] = []; const stmt = { bind(...v: any[]) { values = v; return stmt; }, first: async () => raw.query(sql).get(...values) }; return stmt; } };
  const objects = new Map<string, Uint8Array>(); const books = releaseBucket(objects);
  const artifacts = [['picture_book_key','books/test/live.pdf','PDF APPROVED'], ['audiobook_key','books/test/live.m4b','AUDIO APPROVED']].map(([role,key,text]) => {
    const bytes = new TextEncoder().encode(text); objects.set(key,bytes); return { role,key,bytes:bytes.length,sha256:sha256Hex(bytes) };
  });
  const payload = { schema: 'book-revision/v1' as const, slug: 'test', pages: [], artifacts };
  const source = { ...payload, revision: revisionHash(payload) };
  const r = await freezeArtifactRelease(books,source,'release-one');
  raw.query('INSERT INTO publish_releases (id,book_slug,revision,manifest_json,checks_json,created_at) VALUES (?,?,?,?,?,?)').run('release-one','test',source.revision,JSON.stringify(source),'{}',0);
  raw.query('INSERT INTO artifact_releases VALUES (?,?,?,?,?,?,?)').run('release-one','test',source.revision,r.manifestKey,r.manifestSha256,r.manifestEtag,0);
  raw.query('INSERT INTO artifact_release_heads VALUES (?,?)').run('test','release-one');
  env.DB = db; env.BOOKS = books;
  const get = (format = 'picture') => { const url = new URL('https://example.test/api/download?slug=test&format='+format); return GET({ request: new Request(url), url } as any); };
  return { raw, objects, r, get };
}

test('buyer downloads use frozen masters despite live key and book-row changes', async () => {
  const f = await fixture();
  f.objects.set('books/test/live.pdf', new TextEncoder().encode('EDITED'));
  f.raw.exec("UPDATE books SET picture_book_key = 'books/test/another.pdf'");
  const response = await f.get();
  expect(response.status).toBe(200); expect(await response.text()).toBe('PDF APPROVED'); expect(downloads).toBe(1);
});

test('missing release and tampered frozen bytes fail before consuming download allowance', async () => {
  for (const fault of ['no-release', 'tamper', 'missing-manifest']) {
    const f = await fixture();
    if (fault === 'no-release') f.raw.exec('DELETE FROM artifact_release_heads');
    else if (fault === 'tamper') f.objects.set(f.r.manifest.artifacts[0].key,new TextEncoder().encode('TAMPER'));
    else f.objects.delete(f.r.manifestKey);
    expect((await f.get()).status).toBe(503); expect(downloads).toBe(0);
  }
});

test('audio stamping and its failure fallback both read the frozen master', async () => {
  const f = await fixture(); f.objects.set('books/test/live.m4b',new TextEncoder().encode('EDITED AUDIO'));
  expect(await (await f.get('audiobook')).text()).toBe('AUDIO APPROVED');
  expect(stampKey).toContain('/releases/release-one/');
  failStamp = true;
  expect(await (await f.get('audiobook')).text()).toBe('AUDIO APPROVED');
});

test('ownership refusal still precedes release resolution and download accounting', async () => {
  const f = await fixture(); owns = false; f.raw.exec('DELETE FROM artifact_release_heads');
  expect((await f.get()).status).toBe(403); expect(downloads).toBe(0);
});
