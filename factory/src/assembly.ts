import { prepareAssembly, loadAssemblyPage, assertAssemblyCurrent, bytesHash } from '../../packages/core/src/assembly-identity';
import { buildColoringBook, buildPictureBook } from './pdf';
import { composeMatter } from './matter';
import { toPdfJpeg, needsTranscode } from './transcode';

// Transcoding a 2K PNG page (UPNG decode + jpeg-js encode) is the single
// most CPU-expensive thing assembly does, and a whole book of color pages
// in one workflow step exceeds the CPU limit (Fenix's 67-page color
// assembly died twice on 2026-11-04, after the line editions landed).
// Transcode results are therefore cached in R2, content-addressed by the
// source page's SHA-256: a cached JPEG is valid for exactly those source
// bytes forever, and workflows warm the cache a chapter at a time in
// separate steps (pretranscodeAssembly) so the assemble step itself only
// embeds. The cache prefix sits outside the book snapshot predicate, so
// warming it never changes a book's revision or fingerprint. Bump the
// version segment if the transcode parameters ever change.
const TRANSCODE_CACHE_VERSION = 'v1';

export function transcodeCacheKey(slug: string, sourceSha256: string): string {
  return `books/${slug}/assembly-transcode/${TRANSCODE_CACHE_VERSION}/${sourceSha256}.jpg`;
}

async function pdfJpegForPage(env: { BOOKS: R2Bucket }, slug: string, bytes: Uint8Array): Promise<{ image: Uint8Array; warmed: boolean }> {
  if (!needsTranscode(bytes)) return { image: bytes, warmed: false };
  const key = transcodeCacheKey(slug, bytesHash(bytes));
  const hit = await env.BOOKS.get(key);
  if (hit) {
    const data = new Uint8Array(await hit.arrayBuffer());
    // A hit is trusted only if it at least looks like the JPEG the
    // transcode would have produced; anything else is recomputed.
    if (data.length > 2 && data[0] === 0xff && data[1] === 0xd8) return { image: data, warmed: false };
  }
  const image = await toPdfJpeg(bytes);
  await env.BOOKS.put(key, image, { httpMetadata: { contentType: 'image/jpeg' } });
  return { image, warmed: true };
}

/**
 * Warm the transcode cache for one chapter of one edition, without
 * building any PDF. Workflows call this once per chapter in its own
 * step before the assemble step, bounding each step to a chapter's
 * worth of PNG transcodes. Throws exactly like prepareAssembly when
 * the edition's inventory does not verify.
 */
export async function pretranscodeAssembly(env: { BOOKS: R2Bucket }, slug: string, kind: 'picture' | 'coloring' | 'color', chapter: number) {
  const snapshot = await prepareAssembly(env.BOOKS, slug, kind === 'color' ? 'color' : 'line');
  let warmed = 0;
  let alreadyCached = 0;
  for (const entry of snapshot.entries) {
    if (entry.ref.chapter !== chapter) continue;
    const bytes = await loadAssemblyPage(env.BOOKS, snapshot, entry);
    if (!needsTranscode(bytes)) continue;
    if (await env.BOOKS.head(transcodeCacheKey(slug, bytesHash(bytes)))) { alreadyCached++; continue; }
    await pdfJpegForPage(env, slug, bytes);
    warmed++;
  }
  return { warmed, alreadyCached, revision: snapshot.manifest.revision };
}

/** Chapter numbers in the verified inventory of one edition, ascending. */
export async function assemblyChapters(env: { BOOKS: R2Bucket }, slug: string, kind: 'picture' | 'coloring' | 'color'): Promise<number[]> {
  const snapshot = await prepareAssembly(env.BOOKS, slug, kind === 'color' ? 'color' : 'line');
  return [...new Set(snapshot.entries.map(e => e.ref.chapter))].sort((a, b) => a - b);
}

/** True when the color edition's inventory verifies end to end. */
export async function colorAssemblyReady(env: { BOOKS: R2Bucket }, slug: string): Promise<boolean> {
  try {
    await prepareAssembly(env.BOOKS, slug, 'color');
    return true;
  } catch {
    return false;
  }
}

/**
 * Coloring captions live in a sidecar, `books/{slug}/captions.json`,
 * keyed `S{chapter}p{page}` / `S{chapter} finale` (CG, 2026-11-05):
 * one generated line per page describing its image. The sidecar is
 * not part of the plan JSONs, so captions never move a page's
 * source revision or its identity stamps. No sidecar means the
 * book has no captions yet and its coloring pages ship bare; a
 * sidecar that exists but does not cover every inventory page (or
 * is not a JSON object of strings) fails the assembly loudly, the
 * same as any other missing assembly input.
 */
async function loadColoringCaptions(
  env: { BOOKS: R2Bucket },
  slug: string,
  snapshot: Awaited<ReturnType<typeof prepareAssembly>>
): Promise<Map<string, string> | null> {
  const key = `books/${slug}/captions.json`;
  const obj = await env.BOOKS.get(key);
  if (!obj) return null;
  let map: Record<string, unknown>;
  try {
    map = JSON.parse(new TextDecoder().decode(await obj.arrayBuffer()));
  } catch {
    throw new Error(`Coloring captions sidecar is not valid JSON: ${key}`);
  }
  if (!map || typeof map !== 'object' || Array.isArray(map))
    throw new Error(`Coloring captions sidecar is not a JSON object: ${key}`);
  const captions = new Map<string, string>();
  for (const entry of snapshot.entries) {
    const capKey = entry.ref.kind === 'finale' ? `S${entry.ref.chapter} finale` : `S${entry.ref.chapter}p${entry.ref.page}`;
    const value = map[capKey];
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`Coloring captions sidecar has no caption for ${capKey}`);
    captions.set(entry.ref.id, value);
  }
  return captions;
}

/** The only full-book PDF assembly path. No generation and no line/color fallback. */
export async function assembleVerifiedPdf(env: { BOOKS: R2Bucket }, slug: string, kind: 'picture' | 'coloring' | 'color', expectedRevision?: string) {
  const snapshot = await prepareAssembly(env.BOOKS, slug, kind === 'color' ? 'color' : 'line');
  if (expectedRevision && snapshot.manifest.revision !== expectedRevision) throw new Error('Base assembly revision changed between PDFs');
  const captions = kind === 'coloring' ? await loadColoringCaptions(env, slug, snapshot) : null;
  const pages = [];
  for (const entry of snapshot.entries) {
    const { image } = await pdfJpegForPage(env, slug, await loadAssemblyPage(env.BOOKS, snapshot, entry));
    pages.push({ image, story: entry.page.storyText, caption: captions?.get(entry.ref.id) ?? '' });
  }
  if (pages.length !== snapshot.manifest.pages.length || new Set(snapshot.entries.map(e => e.ref.id)).size !== pages.length)
    throw new Error('Assembly page count does not reconcile to exact plan inventory');
  const artifact = async (file: string) => {
    const key = `books/${slug}/${file}`;
    const expected = snapshot.manifest.artifacts.find(a => a.key === key);
    if (!expected) return null;
    const obj = await env.BOOKS.get(key);
    if (!obj) throw new Error(`Assembly input disappeared: ${key}`);
    const data = new Uint8Array(await obj.arrayBuffer());
    if (bytesHash(data) !== expected.sha256) throw new Error(`Assembly input changed: ${key}`);
    return data;
  };
  const cover = await artifact('cover.jpg');
  const titled = await artifact('cover-titled.jpg');
  const matter = { ...composeMatter(snapshot.bible), backImage: await artifact('back-cover-color.jpg'), backLineImage: await artifact('back-cover-line.jpg') };
  const title = snapshot.bible.bookTitle ?? slug;
  const count = snapshot.entries.length;
  let totalPages = 0;
  const countPages = (count: number) => { totalPages = count; };
  const pdf = kind === 'coloring'
    ? await buildColoringBook(title, pages, snapshot.toc, matter, cover, titled, count, countPages)
    : await buildPictureBook(title, pages, null, snapshot.toc, matter, cover, titled, count, countPages);
  const name = kind === 'color' ? 'picture-book-color.pdf' : kind === 'picture' ? 'picture-book.pdf' : 'coloring-book.pdf';
  const key = `books/${slug}/${name}`;
  // Keep each candidate and full input receipt, even if the final race check fails.
  const candidate = `books/${slug}/assemblies/${crypto.randomUUID()}`;
  await env.BOOKS.put(`${candidate}/${name}`, pdf, { httpMetadata: { contentType: 'application/pdf' } });
  await env.BOOKS.put(`${candidate}/receipt.json`, JSON.stringify({ schema: 'assembly/v1', kind,
    revision: snapshot.manifest.revision, manifest: snapshot.manifest, inventoryPages: count, totalPages,
    coloringCaptions: captions?.size ?? 0,
    pdf: { key: `${candidate}/${name}`, sha256: bytesHash(pdf), bytes: pdf.length } }), { httpMetadata: { contentType: 'application/json' } });
  await assertAssemblyCurrent(env.BOOKS, snapshot);
  await env.BOOKS.put(key, pdf, { httpMetadata: { contentType: 'application/pdf' }, customMetadata: {
    assemblyRevision: snapshot.manifest.revision, pdfSha256: bytesHash(pdf), receiptKey: `${candidate}/receipt.json`,
    inventoryPages: String(count), totalPages: String(totalPages), kind,
  } });
  return { key, pages: count, chapters: snapshot.toc.length, totalPages, revision: snapshot.manifest.revision, titledCover: !!titled };
}
