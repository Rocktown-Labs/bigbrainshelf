import { test, expect, mock } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { fixture } from './helpers/identity-fixture';
import { stampLine, stampColor } from '../packages/core/src/assembly-identity';
// Isolate pure assembly from the generator imports in matter.ts. No model transport exists.
mock.module('../factory/src/matter', () => ({ composeMatter: () => ({ year: 2026, vocab: [], ageLine: 'For ages 4 to 8.', hook: '', blurb: '', learn: [], seriesLine: '' }) }));
const { assembleVerifiedPdf, pretranscodeAssembly, colorAssemblyReady, transcodeCacheKey } = await import('../factory/src/assembly');
const { bytesHash } = await import('../packages/core/src/assembly-identity');

// A PNG comfortably above the 700 KB transcode threshold: 512x512 of
// deterministic noise (~1 MB, incompressible). Encoded by hand with
// filter-0 scanlines: UPNG.encode's own output is not reliably readable
// by UPNG.decode at every size, while real artist PNGs (and this
// standard layout) decode fine.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) crc = CRC_TABLE[(crc ^ out[i]) & 0xff] ^ (crc >>> 8);
  view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return out;
}
function bigPng(seed: number): Uint8Array {
  let s = seed >>> 0;
  const raw = new Uint8Array(512 * (1 + 512 * 4));
  for (let i = 0; i < raw.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    raw[i] = (s >>> 16) & 0xff;
  }
  for (let y = 0; y < 512; y++) raw[y * (1 + 512 * 4)] = 0; // filter: none
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 512); view.setUint32(4, 512);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const pngA = bigPng(1234);
const pngB = bigPng(9876);

function bigFixture() {
  const f = fixture();
  for (const [pg, stem, png] of [[f.plan.pages[0], 'page-0', pngA], [f.plan.finale, 'finale', pngB]] as const) {
    stampLine(f.bible, f.plan, pg, png); stampColor(f.bible, f.plan, pg, png, png);
    f.put(`books/test/images/S1-${stem}.jpg`, png); f.put(pg.imageColorKey, png);
  }
  f.save();
  for (const name of ['cover.jpg', 'back-cover-color.jpg', 'back-cover-line.jpg']) f.put(`books/test/${name}`, pngA);
  const writes: string[] = [];
  const bucket: any = { ...f.bucket, async put(key: string, bytes: any, options: any) { writes.push(key); f.put(key, bytes, options?.customMetadata); } };
  return { ...f, bucket, writes };
}

test('transcode cache keys are content-addressed per book', () => {
  expect(transcodeCacheKey('test', 'abc')).toBe('books/test/assembly-transcode/v1/abc.jpg');
});

test('assembly of big-PNG pages writes the transcode cache once, then reuses it', async () => {
  const f = bigFixture();
  const result = await assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'color');
  expect(result.pages).toBe(2);
  const cacheWrites = f.writes.filter(k => k.startsWith('books/test/assembly-transcode/'));
  expect(cacheWrites.sort()).toEqual([transcodeCacheKey('test', bytesHash(pngA)), transcodeCacheKey('test', bytesHash(pngB))].sort());

  f.writes.length = 0;
  const again = await assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'color');
  expect(again.pages).toBe(2);
  expect(f.writes.filter(k => k.startsWith('books/test/assembly-transcode/'))).toHaveLength(0);
}, 30_000);

test('pretranscode warms only the requested chapter and reports the cache state', async () => {
  const f = bigFixture();
  const env = { BOOKS: f.bucket };
  expect(await pretranscodeAssembly(env, 'test', 'color', 2)).toMatchObject({ warmed: 0, alreadyCached: 0 });
  expect(await pretranscodeAssembly(env, 'test', 'color', 1)).toMatchObject({ warmed: 2, alreadyCached: 0 });
  expect(await pretranscodeAssembly(env, 'test', 'color', 1)).toMatchObject({ warmed: 0, alreadyCached: 2 });
  // The line edition shares the same source bytes, so its cache is already warm.
  expect(await pretranscodeAssembly(env, 'test', 'picture', 1)).toMatchObject({ warmed: 0, alreadyCached: 2 });
});

test('small pages never touch the transcode cache', async () => {
  const f = fixture();
  const tiny = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64'));
  for (const [pg, stem] of [[f.plan.pages[0], 'page-0'], [f.plan.finale, 'finale']] as const) {
    stampLine(f.bible, f.plan, pg, tiny); stampColor(f.bible, f.plan, pg, tiny, tiny);
    f.put(`books/test/images/S1-${stem}.jpg`, tiny); f.put(pg.imageColorKey, tiny);
  }
  f.save();
  for (const name of ['cover.jpg', 'back-cover-color.jpg', 'back-cover-line.jpg']) f.put(`books/test/${name}`, tiny);
  const bucket: any = { ...f.bucket, async put(key: string, bytes: any, options: any) { f.put(key, bytes, options?.customMetadata); } };
  const result = await assembleVerifiedPdf({ BOOKS: bucket }, 'test', 'color');
  expect(result.pages).toBe(2);
  expect([...f.values.keys()].filter(k => k.includes('assembly-transcode'))).toHaveLength(0);
});

test('colorAssemblyReady tracks color inventory completeness', async () => {
  const f = bigFixture();
  expect(await colorAssemblyReady({ BOOKS: f.bucket }, 'test')).toBe(true);
  f.values.delete(f.plan.finale.imageColorKey);
  expect(await colorAssemblyReady({ BOOKS: f.bucket }, 'test')).toBe(false);
});
