import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { captureBookRevision, assertRevisionUnchanged, readPlanInventory } from '../packages/core/src/book-revision';
import { publishVerifiedBook } from '../src/lib/publish-gate';
import { getDeliveryReadiness } from '../src/lib/delivery-readiness';

function fixture(chapters = 1) {
  const objects = new Map<string, { value: string; etag: string }>();
  let version = 0;
  function put(key: string, value: unknown) {
    objects.set(key, { value: typeof value === 'string' ? value : JSON.stringify(value), etag: String(++version) });
  }
  put('books/test/bible.json', { conceptLadder: Array.from({ length: chapters }, () => ({})) });
  for (let n = 1; n <= chapters; n++) {
    put(`books/test/plans/S${n}.json`, { pages: [{ storyText: 'A story.' }], finale: { storyText: 'The finale.' } });
    put(`books/test/images/S${n}-page-0.jpg`, 'LINE');
    put(`books/test/images/S${n}-finale.jpg`, 'FINALE');
  }
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
    async head(key: string) { return objects.has(key) ? { etag: objects.get(key)!.etag } : null; },
    async list({ prefix, cursor }: any) {
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = Number(cursor ?? 0);
      return { objects: keys.slice(start, start + 4).map(key => ({ key })), truncated: start + 4 < keys.length,
        cursor: String(start + 4) };
    },
  };
  const raw = new Database(':memory:');
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
  return { objects, put, bucket, raw, db, checks, status };
}

test('inventory is complete, includes finales, numerically ordered and paginated', async () => {
  const f = fixture(12);
  const { pages } = await readPlanInventory(f.bucket, 'test');
  expect(pages).toHaveLength(24);
  expect(pages[1]).toMatchObject({ id: 'S1:finale', page: 1, kind: 'finale' });
  expect(pages[18].chapter).toBe(10);
});

test.each(['missing', 'empty', 'malformed', 'extra'])('rejects %s plan inventory', async mode => {
  const f = fixture(2);
  if (mode === 'missing') f.objects.delete('books/test/plans/S2.json');
  if (mode === 'empty') f.put('books/test/plans/S2.json', { pages: [] });
  if (mode === 'malformed') f.put('books/test/plans/S2.json', '{');
  if (mode === 'extra') f.put('books/test/plans/S3.json', { pages: [{ storyText: 'Extra.' }] });
  await expect(readPlanInventory(f.bucket, 'test')).rejects.toThrow();
});

test('hash identity uses actual bytes: equal-size edits change revision; upload time does not', async () => {
  const f = fixture();
  const before = await captureBookRevision(f.bucket, 'test', []);
  f.put('books/test/images/S1-page-0.jpg', 'LINE');
  expect((await captureBookRevision(f.bucket, 'test', [])).manifest.revision).toBe(before.manifest.revision);
  f.put('books/test/images/S1-page-0.jpg', 'EDIT');
  expect((await captureBookRevision(f.bucket, 'test', [])).manifest.revision).not.toBe(before.manifest.revision);
  await expect(assertRevisionUnchanged(f.bucket, before.observations)).rejects.toThrow();
});

test('missing planned art blocks and cannot be overridden', async () => {
  const f = fixture();
  f.objects.delete('books/test/images/S1-finale.jpg');
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test', publishOverride: { reason: 'Owner', checks: ['inventory'] } }, 'cg', f.checks)).rejects.toThrow();
  expect(f.status()).toBe('ready_for_qa');
});

test('unknown readiness blocks without publishing', async () => {
  const f = fixture();
  f.checks.audio = async () => { throw new Error('outage'); };
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow('Audio readiness');
  expect(f.status()).toBe('ready_for_qa');
});

test('explicit override records unknown evidence, reason, operator and actual artifact manifest', async () => {
  const f = fixture();
  f.checks.audio = async () => null;
  const result = await publishVerifiedBook(f.db, f.bucket, { book_slug: 'test', publishOverride: { reason: 'CG accepts unavailable audio', checks: ['audio'] } }, 'cg', f.checks);
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
    const f = fixture();
    f.checks.audio = async () => null;
    await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test', ...input }, 'cg', f.checks)).rejects.toThrow();
    expect(f.status()).toBe('ready_for_qa');
  }
});

test('delivery unknowns and failures are named and cannot be waived by an audio override', async () => {
  const f = fixture();
  f.checks.delivery = async () => ({ checks: [{ id: 'line-purity', state: 'unknown', detail: 'Purity unknown.' }] });
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow('Purity unknown');
  expect(f.status()).toBe('ready_for_qa');
});

test('duplicate approvals do not replace a missing finale approval', async () => {
  const f = fixture();
  f.raw.exec('DELETE FROM page_approvals WHERE page_index = 1; INSERT INTO page_approvals VALUES (\'test\',1,0,1)');
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow('Only 1 of 2');
});

test('failed audit insert prevents publication', async () => {
  const f = fixture();
  f.raw.exec(`CREATE TABLE publish_releases (id TEXT PRIMARY KEY, book_slug TEXT NOT NULL, revision TEXT NOT NULL,
    manifest_json TEXT NOT NULL, checks_json TEXT NOT NULL, override_json TEXT, actor TEXT, created_at INTEGER);
    CREATE TRIGGER reject_audit BEFORE INSERT ON publish_releases BEGIN SELECT RAISE(ABORT, 'audit failure'); END;`);
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow('Publication could not be confirmed');
  expect(f.status()).toBe('ready_for_qa');
});

test('failed publication rolls back its audit record', async () => {
  const f = fixture();
  f.raw.exec(`CREATE TRIGGER reject_publish BEFORE UPDATE ON books BEGIN SELECT RAISE(ABORT, 'write failure'); END;`);
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow();
  expect(f.raw.query('SELECT * FROM publish_releases').all()).toHaveLength(0);
  expect(f.status()).toBe('ready_for_qa');
});

test('mid-verification artifact edits block publication', async () => {
  const f = fixture();
  f.checks.audio = async () => { f.put('books/test/images/S1-page-0.jpg', 'EDIT'); return { ready: true }; };
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow('changed during verification');
  expect(f.status()).toBe('ready_for_qa');
});

test.each(['book', 'approval'])('a concurrent %s change rolls back publication and audit', async kind => {
  const f = fixture();
  f.checks.audio = async () => {
    if (kind === 'book') f.raw.exec("UPDATE books SET updated_at = 2");
    else f.raw.exec('DELETE FROM page_approvals WHERE page_index = 1');
    return { ready: true };
  };
  await expect(publishVerifiedBook(f.db, f.bucket, { book_slug: 'test' }, 'cg', f.checks)).rejects.toThrow();
  expect(f.status()).toBe('ready_for_qa');
  expect(f.raw.query('SELECT * FROM publish_releases').all()).toHaveLength(0);
});

test('delivery verification in read-only mode never seeds or creates tables', async () => {
  const f = fixture();
  const statements: string[] = [];
  const db = { prepare(sql: string) { statements.push(sql); return f.db.prepare(sql); } };
  const result = await getDeliveryReadiness(db, f.bucket, 'test', { readOnly: true });
  expect(result).not.toBeNull();
  expect(statements.some(sql => /\b(CREATE|ALTER|INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
});
