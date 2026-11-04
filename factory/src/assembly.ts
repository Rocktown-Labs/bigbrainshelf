import { prepareAssembly, loadAssemblyPage, assertAssemblyCurrent, bytesHash } from '../../packages/core/src/assembly-identity';
import { buildColoringBook, buildPictureBook } from './pdf';
import { composeMatter } from './matter';
import { toPdfJpeg } from './transcode';

/** The only full-book PDF assembly path. No generation and no line/color fallback. */
export async function assembleVerifiedPdf(env: { BOOKS: R2Bucket }, slug: string, kind: 'picture' | 'coloring' | 'color', expectedRevision?: string) {
  const snapshot = await prepareAssembly(env.BOOKS, slug, kind === 'color' ? 'color' : 'line');
  if (expectedRevision && snapshot.manifest.revision !== expectedRevision) throw new Error('Base assembly revision changed between PDFs');
  const pages = [];
  for (const entry of snapshot.entries) {
    const image = await toPdfJpeg(await loadAssemblyPage(env.BOOKS, snapshot, entry));
    pages.push({ image, story: entry.page.storyText, caption: entry.page.storyText });
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
    pdf: { key: `${candidate}/${name}`, sha256: bytesHash(pdf), bytes: pdf.length } }), { httpMetadata: { contentType: 'application/json' } });
  await assertAssemblyCurrent(env.BOOKS, snapshot);
  await env.BOOKS.put(key, pdf, { httpMetadata: { contentType: 'application/pdf' }, customMetadata: {
    assemblyRevision: snapshot.manifest.revision, pdfSha256: bytesHash(pdf), receiptKey: `${candidate}/receipt.json`,
    inventoryPages: String(count), totalPages: String(totalPages), kind,
  } });
  return { key, pages: count, chapters: snapshot.toc.length, totalPages, revision: snapshot.manifest.revision, titledCover: !!titled };
}
