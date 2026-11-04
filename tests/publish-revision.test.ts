import { prepareAssembly, stampLine, bytesHash } from '../packages/core/src/assembly-identity';
import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { captureBookRevision, assertRevisionUnchanged, readPlanInventory, revisionHash } from '../packages/core/src/book-revision';
import { captureApprovalRevision, saveApprovals } from '../src/lib/approval-identity';
import { publishVerifiedBook } from '../src/lib/publish-gate';
import { getDeliveryReadiness } from '../src/lib/delivery-readiness';

async function fixture(chapters = 1, approveFinales = true) {
  const objects = new Map<string, { value: string; etag: string; customMetadata?: any }>();
  let version = 0;
  function put(key: string, value: unknown) {
    objects.set(key, { value: typeof value === 'string' ? value : JSON.stringify(value), etag: String(++version) });
  }
  put('books/test/bible.json', { conceptLadder: Array.from({ length: chapters }, () => ({})) });
  for (let n = 1; n <= chapters; n++) {
    const plan = { pages: [{ storyText: 'A story.' }], finale: { storyText: 'The finale.' } };
    const bible = JSON.parse(objects.get('books/test/bible.json')!.value);
    stampLine(bible, plan, plan.pages[0], new TextEncoder().encode('LINE'));
    stampLine(bible, plan, plan.finale, new TextEncoder().encode('FINALE'));
    put(`books/test/plans/S${n}.json`, plan);
    put(`books/test/images/S${n}-page-0.jpg`, 'LINE');
    put(`books/test/images/S${n}-finale.jpg`, 'FINALE');
  }
  for (const name of ['cover.jpg', 'back-cover-color.jpg', 'back-cover-line.jpg']) put(`books/test/${name}`, 'COVER');
  put('books/test/picture-book.pdf', 'PICTURE');
  put('books/test/coloring-book.pdf', 'COLORING');
  const bucket = {
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      const bytes = new TextEncoder().encode(object.value);
      return { etag: object.etag, arrayBuffer: async () => bytes.buffer,
        body: new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 2)); c.enqueue(bytes.subarray(2)); c.close(); } }) };
    },
    async head(key: string) { return objects.has(key) ? { etag: objects.get(key)!.etag, customMetadata: objects.get(key)!.customMetadata } : null; },
    async list({ prefix, cursor }: any) {
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = Number(cursor ?? 0);
      return { objects: keys.slice(start, start + 4).map(key => ({ key })), truncated: start + 4 < keys.length,
        cursor: String(start + 4) };
    },
  };
  const raw = new Database(':memory:');
  raw.exec(readFileSync(new URL('../db/migrations/0001_release_and_run_provenance.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../db/migrations/0002_artifact_approvals.sql', import.meta.url), 'utf8'));
  raw.exec(`CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, status TEXT, price INTEGER, price_print INTEGER,
    updated_at INTEGER, picture_book_key TEXT, coloring_book_key TEXT, color_book_key TEXT,
    epub_key TEXT, audiobook_key TEXT, cover_key TEXT);
    INSERT INTO books (slug, title, status, price, price_print, updated_at, picture_book_key, coloring_book_key)
      VALUES ('test', 'Test', 'ready_for_qa', 0, 0, 1, 'books/test/picture-book.pdf', 'books/test/coloring-book.pdf');
    CREATE TABLE page_approvals (book_slug TEXT, chapter_num INTEGER, page_index INTEGER, approved INTEGER);`);
  for (let n = 1; n <= chapters; n++) for (const i of [0, 1]) raw.query('INSERT INTO page_approvals VALUES (?, ?, ?, 1)').run('test', n, i);
  const db: any = {
    prepare(sql: string) {
      let values: any[] = [];
      const statement = { bind(...v: any[]) { values = v; return statement; },
        async first() { return raw.query(sql).get(...values); },
        async all() { return { results: raw.query(sql).all(...values) }; },
        async run() { return raw.query(sql).run(...values); },
        execute() { return raw.query(sql).run(...values); } };
      return statement;
    },
    async batch(statements: any[]) { return raw.transaction(() => statements.map(s => s.execute()))(); },
  };
  const checks: any = { audio: async () => ({ ready: true, state: 'final', blockers: [] }),
    delivery: async () => ({ checks: [{ id: 'storybook-pdf', state: 'pass', detail: 'Present.' }] }) };
  const status = () => (raw.query('SELECT status FROM books').get() as any).status;
  async function refreshAssemblyEvidence() {
    // Trusted builder simulation for publication fencing tests; real PDFs are tested separately.
    const bible = JSON.parse(objects.get('books/test/bible.json')!.value);
    for (let n = 1; n <= chapters; n++) {
      const plan = JSON.parse(objects.get(`books/test/plans/S${n}.json`)!.value);
      for (const [pg, stem] of [[plan.pages[0], 'page-0'], [plan.finale, 'finale']] as const)
        stampLine(bible, plan, pg, new TextEncoder().encode(objects.get(`books/test/images/S${n}-${stem}.jpg`)!.value));
      put(`books/test/plans/S${n}.json`, plan);
    }
    const { manifest } = await prepareAssembly(bucket, 'test', 'line');
    for (const [name, kind] of [['picture-book.pdf', 'picture'], ['coloring-book.pdf', 'coloring']]) {
      const object = objects.get(`books/test/${name}`)!;
      const data = new TextEncoder().encode(object.value);
      const receiptKey = `books/test/assemblies/${kind}/receipt.json`;
      put(receiptKey, { schema: 'assembly/v1', kind, manifest, revision: manifest.revision, inventoryPages: manifest.pages.length,
        pdf: { bytes: data.length, sha256: bytesHash(data) } });
      object.customMetadata = { assemblyRevision: manifest.revision, pdfSha256: bytesHash(data), receiptKey, kind };
    }
  }
  await refreshAssemblyEvidence();
  const approvalSnapshot = await captureApprovalRevision(db, bucket, 'test');
  await saveApprovals(db, bucket, approvalSnapshot, approvalSnapshot.manifest.pages.filter(p => approveFinales || p.kind !== 'finale'), true);
  return { objects, put, bucket, raw, db, checks, status, refreshAssemblyEvidence };
}

test('inventory is complete, includes finales, numerically ordered and paginated', async () => {
  const f = await fixture(12);
  const { pages } = await readPlanInventory(f.bucket, 'test');
  expect(pages).toHaveLength(24);
  expect(pages[1]).toMatchObject({ id: 'S1:finale', page: 1, kind: 'finale' });
  expect(pages[18].chapter).toBe(10);
});

test.each(['missing', 'empty', 'malformed', 'extra'])('rejects %s plan inventory', async mode => {
  const f = await fixture(2);
  if (mode === 'missing') f.objects.delete('books/test/plans/S2.json');
  if (mode === 'empty') f.put('books/test/plans/S2.json', { pages: [] });
  if (mode === 'malformed') f.put('books/test/plans/S2.json', '{');
  if (mode === 'extra') f.put('books/test/plans/S3.json', { pages: [{ storyText: 'Extra.' }] });
  await expect(readPlanInventory(f.bucket, 'test')).rejects.toThrow();
});

test('hash identity uses actual bytes: equal-size edits change revision; upload time does not', async () => {
  const f = await fixture();
  const before = await captureBookRevision(f.bucket, 'test', []);
  f.put('books/test/images/S1-page-0.jpg', 'LINE');
  expect((await captureBookRevision(f.bucket, 'test', [])).manifest.revision).toBe(before.manifest.revision);
  f.put('books/test/images/S1-page-0.jpg', 'EDIT');
  expect((await captureBookRevision(f.bucket, 'test', [])).manifest.revision).not.toBe(before.manifest.revision);
  await expect(assertRevisionUnchanged(f.bucket, before.observations)).rejects.toThrow();
});

test('missing planned art blocks and cannot be overridden', async () => {
  const f = await fixture();
  f.objects.delete('books/test/images/S1-finale.jpg');
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test', publishOverride: { reason: 'Owner', checks: ['inventory'] } }, 'cg', f.checks)).rejects.toThrow();
  expect(f.status()).toBe('ready_for_qa');
});

test('unknown readiness blocks without publishing', async () => {
  const f = await fixture();
  f.checks.audio = async () => { throw new Error('outage'); };
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow('Audio readiness');
  expect(f.status()).toBe('ready_for_qa');
});

test('explicit override records unknown evidence, reason, operator and actual artifact manifest', async () => {
  const f = await fixture();
  f.checks.audio = async () => null;
  const blocked = await publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks).catch(error => error);
  expect(blocked.verification).toHaveLength(64);
  const result = await publishVerifiedBook(f.db, f.bucket, { book_slug: 'test', publishOverride: {
    reason: 'CG accepts unavailable audio', checks: ['audio'], verification: blocked.verification,
  } }, 'cg', f.checks);
  expect(f.status()).toBe('complete');
  const saved: any = f.raw.query('SELECT * FROM publish_releases').get();
  expect(saved.actor).toBe('cg');
  expect(saved.revision).toBe(result.revision);
  expect(JSON.parse(saved.override_json)).toMatchObject({ reason: 'CG accepts unavailable audio', checks: ['audio'] });
  expect(JSON.parse(saved.manifest_json).artifacts.find((a: any) => a.role === 'picture_book_key').sha256).toHaveLength(64);
  expect(JSON.parse(saved.checks_json).blockers[0].id).toBe('audio');
});

test('cannot waive a check with a blanket flag, an empty reason, or a stale ID', async () => {
  for (const input of [{ audioGateOverride: true }, { publishOverride: { reason: '', checks: ['audio'] } },
    { publishOverride: { reason: 'CG', checks: ['delivery'] } }]) {
    const f = await fixture();
    f.checks.audio = async () => null;
    await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test', ...input }, 'cg', f.checks)).rejects.toThrow();
    expect(f.status()).toBe('ready_for_qa');
  }
});

test('delivery unknowns and failures are named and cannot be waived by an audio override', async () => {
  const f = await fixture();
  f.checks.delivery = async () => ({ checks: [{ id: 'line-purity', state: 'unknown', detail: 'Purity unknown.' }] });
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow('Purity unknown');
  expect(f.status()).toBe('ready_for_qa');
});

test('duplicate approvals do not replace a missing finale approval', async () => {
  const f = await fixture(1, false);
  f.raw.exec('INSERT INTO artifact_approvals (book_slug,chapter_num,page_index,revision,artifact_hash,manifest_json,actor,approved,approved_at) SELECT book_slug,chapter_num,page_index,revision,artifact_hash,manifest_json,actor,approved,approved_at FROM artifact_approvals');
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow('Only 1 of 2');
});

test('failed audit insert prevents publication', async () => {
  const f = await fixture();
  f.raw.exec(`CREATE TABLE IF NOT EXISTS publish_releases (id TEXT PRIMARY KEY, book_slug TEXT NOT NULL, revision TEXT NOT NULL,
    manifest_json TEXT NOT NULL, checks_json TEXT NOT NULL, override_json TEXT, actor TEXT, created_at INTEGER);
    CREATE TRIGGER reject_audit BEFORE INSERT ON publish_releases BEGIN SELECT RAISE(ABORT, 'audit failure'); END;`);
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow('Publication could not be confirmed');
  expect(f.status()).toBe('ready_for_qa');
});

test('failed publication rolls back its audit record', async () => {
  const f = await fixture();
  f.raw.exec(`CREATE TRIGGER reject_publish BEFORE UPDATE ON books BEGIN SELECT RAISE(ABORT, 'write failure'); END;`);
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow();
  expect(f.raw.query('SELECT * FROM publish_releases').all()).toHaveLength(0);
  expect(f.status()).toBe('ready_for_qa');
});

test('mid-verification artifact edits block publication', async () => {
  const f = await fixture();
  f.checks.audio = async () => { f.put('books/test/images/S1-page-0.jpg', 'EDIT'); return { ready: true }; };
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow('changed during verification');
  expect(f.status()).toBe('ready_for_qa');
});

test.each(['book', 'approval'])('a concurrent %s change rolls back publication and audit', async kind => {
  const f = await fixture();
  f.checks.audio = async () => {
    if (kind === 'book') f.raw.exec("UPDATE books SET updated_at = 2");
    else f.raw.exec('INSERT INTO artifact_approvals (book_slug,chapter_num,page_index,revision,artifact_hash,manifest_json,actor,approved,approved_at) SELECT book_slug,chapter_num,page_index,revision,artifact_hash,manifest_json,actor,0,approved_at FROM artifact_approvals WHERE page_index = 1');
    return { ready: true };
  };
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow();
  expect(f.status()).toBe('ready_for_qa');
  expect(f.raw.query('SELECT * FROM publish_releases').all()).toHaveLength(0);
});

test('delivery verification in read-only mode never seeds or creates tables', async () => {
  const f = await fixture();
  const statements: string[] = [];
  const db = { prepare(sql: string) { statements.push(sql); return f.db.prepare(sql); } };
  const result = await getDeliveryReadiness(db, f.bucket, 'test', { readOnly: true });
  expect(result).not.toBeNull();
  expect(statements.some(sql => /\b(CREATE|ALTER|INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
});

test('an override cannot confirm a different revision than the operator reviewed', async () => {
  const f = await fixture();
  f.checks.audio = async () => null;
  const { manifest } = await captureBookRevision(f.bucket, 'test', [
    { key: 'books/test/picture-book.pdf', role: 'picture_book_key' },
    { key: 'books/test/coloring-book.pdf', role: 'coloring_book_key' },
  ]);
  const verification = revisionHash({ revision: manifest.revision,
    blockers: [{ id: 'audio', detail: 'Audio readiness could not be verified.' }] });
  f.put('books/test/images/S1-page-0.jpg', 'EDIT');
  await f.refreshAssemblyEvidence();
  const newer = await captureApprovalRevision(f.db, f.bucket, 'test');
  await saveApprovals(f.db, f.bucket, newer, newer.manifest.pages, true);
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test', publishOverride: {
    reason: 'CG reviewed the earlier revision', checks: ['audio'], verification,
  } }, 'cg', f.checks)).rejects.toThrow('Readiness changed');
  expect(f.status()).toBe('ready_for_qa');
});

test('unchanged artifacts do not authorize an override of changed readiness evidence', async () => {
  const f = await fixture();
  f.checks.audio = async () => null;
  const blocked = await publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks).catch(error => error);
  f.checks.audio = async () => ({ ready: false, state: 'draft-audio', blockers: ['The voice assignment changed.'] });
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test', publishOverride: {
    reason: 'CG reviewed the earlier audio evidence', checks: ['audio'], verification: blocked.verification,
  } }, 'cg', f.checks)).rejects.toThrow('Readiness changed');
  expect(f.status()).toBe('ready_for_qa');
});
