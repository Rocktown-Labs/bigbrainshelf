import { test, expect, mock } from 'bun:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import { fixture } from './helpers/identity-fixture';
import { stampLine, stampColor } from '../packages/core/src/assembly-identity';

// The glossary CG ruled on (2026-11-05): plain phrases with
// kid-language definitions, Mira-shaped (8 entries, ~100-char
// definitions). At the composer's original sizes this list spills
// to a second page; the size ladder must hold it to one.
const VOCAB = [
  { term: 'the work you love', storyName: 'the Pull', definition: 'The work you love is the thing you want to do again and again, just because it pulls at you.' },
  { term: 'watching and learning', storyName: 'the Watching Weeks', definition: 'Watching and learning means looking closely and waiting, so you can see how something really works.' },
  { term: 'practicing on purpose', storyName: 'the Morning Path', definition: 'Practicing on purpose means doing a small piece over and over, the right way, until it gets easier.' },
  { term: 'when nothing changes', storyName: 'the Flat Days', definition: 'When nothing changes for a long time, keep going. Your skill is still growing where you cannot see it.' },
  { term: 'learning from a teacher', storyName: "a Master's Eye", definition: 'Learning from a teacher means letting someone who knows more show you what you cannot see yet.' },
  { term: 'noticing what others really mean', storyName: 'reading ripples', definition: 'Noticing what others really mean means watching how people act, not just hearing what they say.' },
  { term: 'your own way', storyName: 'her own current', definition: 'Your own way is how you do the work in the way that fits you best.' },
  { term: 'just knowing', storyName: 'knowing before seeing', definition: 'Just knowing is when you have practiced so much that the answer comes before you even think.' },
];
mock.module('../factory/src/matter', () => ({
  composeMatter: () => ({ year: 2026, vocab: VOCAB, ageLine: 'For ages 4 to 8.', hook: '', blurb: '', learn: [], seriesLine: '' }),
}));
const { assembleVerifiedPdf } = await import('../factory/src/assembly');
const { buildColoringBook, oneLineCaptionSize } = await import('../factory/src/pdf');

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64'));

function pdfFixture() {
  const f = fixture();
  for (const [pg, stem] of [[f.plan.pages[0], 'page-0'], [f.plan.finale, 'finale']] as const) {
    stampLine(f.bible, f.plan, pg, png);
    stampColor(f.bible, f.plan, pg, png, png);
    f.put(`books/test/images/S1-${stem}.jpg`, png);
    f.put(pg.imageColorKey, png);
  }
  f.save();
  for (const name of ['cover.jpg', 'back-cover-color.jpg', 'back-cover-line.jpg']) f.put(`books/test/${name}`, png);
  const writes: string[] = [];
  const bucket: any = {
    ...f.bucket,
    async put(key: string, bytes: any, options: any) {
      writes.push(key);
      f.put(key, bytes, options?.customMetadata);
    },
  };
  return { ...f, bucket, writes };
}

// pdf-lib writes each drawText string as a hex string inside a
// flate content stream, so the drawn text of an assembled PDF can
// be asserted by inflating its streams and decoding the hex (no
// text-extraction dependency resolves from the repo root).
function pdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const s = buf.indexOf('stream', i);
    if (s < 0) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf('endstream', start);
    if (e < 0) break;
    try {
      parts.push(inflateSync(buf.subarray(start, e)).toString('latin1'));
    } catch {
      // Not a flate stream (embedded images); skip.
    }
    i = e + 9;
  }
  return parts
    .join('\n')
    .replace(/<([0-9A-Fa-f]{4,})>/g, (_m, hex: string) => Buffer.from(hex, 'hex').toString('latin1'));
}

function lastReceipt(f: ReturnType<typeof pdfFixture>) {
  const key = f.writes.filter((k) => k.endsWith('/receipt.json')).at(-1)!;
  return JSON.parse(new TextDecoder().decode(f.values.get(key)!.bytes));
}

test('coloring assembly draws the sidecar captions and records the count', async () => {
  const f = pdfFixture();
  f.put('books/test/captions.json', JSON.stringify({ S1p0: 'A tiny page does a brave thing', 'S1 finale': 'Everyone cheers at the end' }));
  const result = await assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'coloring');
  const text = pdfText(f.values.get(result.key)!.bytes);
  expect(text).toContain('- A tiny page does a brave thing');
  expect(text).toContain('- Everyone cheers at the end');
  expect(lastReceipt(f).coloringCaptions).toBe(2);
});

test('no sidecar: coloring assembles bare and the receipt records zero captions', async () => {
  const f = pdfFixture();
  const result = await assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'coloring');
  expect(result.pages).toBe(2);
  expect(lastReceipt(f).coloringCaptions).toBe(0);
});

test('a sidecar missing a page fails the assembly and installs nothing', async () => {
  const f = pdfFixture();
  f.put('books/test/captions.json', JSON.stringify({ S1p0: 'Only the first page got one' }));
  await expect(assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'coloring')).rejects.toThrow('no caption for S1 finale');
  expect(f.writes).toHaveLength(0);
});

test('a sidecar that is not valid JSON fails the assembly', async () => {
  const f = pdfFixture();
  f.put('books/test/captions.json', 'this is not json');
  await expect(assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'coloring')).rejects.toThrow('not valid JSON');
  expect(f.writes).toHaveLength(0);
});

test('the glossary fits on one page at the stepped-down sizes', async () => {
  const f = pdfFixture();
  const result = await assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'coloring');
  // Cover, copyright, dedication, contents, two interiors, ONE glossary page, back cover.
  expect(result.totalPages).toBe(8);
  const text = pdfText(f.values.get(result.key)!.bytes);
  for (const v of VOCAB) expect(text).toContain(v.term);
});

test('the coloring book carries the blank dedication page (CG, 2026-11-05)', async () => {
  const f = pdfFixture();
  const result = await assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'coloring');
  const text = pdfText(f.values.get(result.key)!.bytes);
  // The pre-built store file ships the page with the write-in line
  // blank: the belongs-to line and the house blurb print, and
  // nothing fills the name in.
  expect(text).toContain('This book belongs to');
  expect(text).toContain('every big idea starts as a small question');
  expect(text).toContain('Happy reading!');
  // Order: copyright (Searcy) before the dedication, the dedication
  // before the contents.
  const searcyAt = text.indexOf('Searcy, Arkansas');
  const belongsAt = text.indexOf('This book belongs to');
  const contentsAt = text.indexOf('Contents');
  expect(searcyAt).toBeGreaterThanOrEqual(0);
  expect(belongsAt).toBeGreaterThan(searcyAt);
  expect(contentsAt).toBeGreaterThan(belongsAt);
});

test('the copyright page names Searcy, never Little Rock', async () => {
  const f = pdfFixture();
  const result = await assembleVerifiedPdf({ BOOKS: f.bucket }, 'test', 'picture');
  const text = pdfText(f.values.get(result.key)!.bytes);
  expect(text).toContain('Searcy, Arkansas');
  expect(text).not.toContain('Little Rock');
});

test('oneLineCaptionSize fits whole lines and refuses ones that cannot fit', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  expect(oneLineCaptionSize(font, '- A short caption', 500)).toBe(11);
  const long = '- Mira watches the water while Ansel shows her how the still places hide the fish';
  const narrower = font.widthOfTextAtSize(long, 11) - 40;
  const size = oneLineCaptionSize(font, long, narrower);
  expect(size).toBeLessThan(11);
  expect(size).toBeGreaterThanOrEqual(8);
  expect(font.widthOfTextAtSize(long, size)).toBeLessThanOrEqual(narrower);
  expect(() => oneLineCaptionSize(font, long, 60)).toThrow('does not fit on one line');
});

test('buildColoringBook throws rather than truncating an unfittable caption', async () => {
  await expect(
    buildColoringBook('Test', [{ image: png, caption: 'word '.repeat(120).trim() }])
  ).rejects.toThrow('does not fit on one line');
});
