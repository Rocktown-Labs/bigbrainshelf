import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awsBucket } from '../factory-ops/adoption-transport';

test('S3 adapter cannot write art, PDFs, audit evidence, another book, or unconditioned plans', async () => {
  let calls = 0;
  const bucket = awsBucket({ slug: 'test', account: 'a'.repeat(32), bucket: 'fixture', directory: mkdtempSync(join(tmpdir(), 'bbs-adoption-transport-')),
    execute: (() => { calls++; throw new Error('Unexpected command'); }) as any });
  for (const key of ['books/test/images/S1-page-0.jpg', 'books/test/picture-book.pdf', 'books/test/audit/inventory.json', 'books/other/plans/S1.json', 'books/test/plans/../bible.json'])
    await expect(bucket.put(key, '{}', { onlyIf: { etagMatches: 'one' } })).rejects.toThrow();
  await expect(bucket.put('books/test/plans/S1.json', '{}', {} as any)).rejects.toThrow();
  expect(calls).toBe(0);
});

test('S3 adapter preserves original metadata, retains all reads, and uses atomic If-Match for plans', async () => {
  const calls: string[][] = []; const directory = mkdtempSync(join(tmpdir(), 'bbs-adoption-cas-'));
  const bucket = awsBucket({ slug: 'test', account: 'a'.repeat(32), bucket: 'fixture', directory,
    execute: ((_executable: string, args: string[]) => {
      calls.push(args);
      if (args.includes('get-object')) { writeFileSync(args.at(-1)!, '{}'); return { status: 0, stdout: JSON.stringify({ ETag: '"original"', Metadata: { retained: 'yes' }, ContentType: 'application/json', CacheControl: 'no-cache' }), stderr: '' }; }
      return { status: 0, stdout: JSON.stringify({ ETag: '"adopted"' }), stderr: '' };
    }) as any });
  await bucket.get('books/test/plans/S1.json');
  await bucket.put('books/test/plans/S1.json', '{"lineIdentity":{}}', { onlyIf: { etagMatches: '"original"' } });
  expect(calls[1]).toContain('--if-match'); expect(calls[1][calls[1].indexOf('--if-match') + 1]).toBe('"original"');
  expect(calls[1]).toContain('{"retained":"yes"}'); expect(calls[1]).toContain('no-cache');
});

test('operator inputs pin preserved evidence files and reject a changed export before any remote call', async () => {
  const { loadEvidenceIndex } = await import('../factory-ops/adoption-input');
  const { bytesHash } = await import('../packages/core/src/assembly-identity');
  const directory = mkdtempSync(join(tmpdir(), 'bbs-adoption-input-'));
  writeFileSync(join(directory, 'source.json'), '{"fixture":true}');
  const reference = { file: 'source.json', sha256: bytesHash(new TextEncoder().encode('{"fixture":true}')) };
  const file = join(directory, 'index.json');
  writeFileSync(file, JSON.stringify({ schema: 'adoption-input/v1', slug: 'test', sources: { inventory: reference, line: reference, bookQa: reference } }));
  expect(loadEvidenceIndex(file, 'test').evidence.inventory).toBe('{"fixture":true}');
  writeFileSync(join(directory, 'source.json'), '{}');
  expect(() => loadEvidenceIndex(file, 'test')).toThrow('changed');
});
