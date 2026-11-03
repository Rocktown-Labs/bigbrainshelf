import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import dockerChapters from '../../../data/docker_chapters.json';
import { adminMediaUrl, keyFromMediaValue } from '../../../lib/media';
import { keyFromImageUrl } from '../../../lib/takes';
import { loadFullChapters } from '../../../lib/book-pages';

// GET /api/editor/chapters?slug= -> per-book chapter/page data for the editor.
// Reads books/{slug}/editor_chapters.json from R2 (written by the factory
// pipeline). For docker the R2 file is authoritative once the factory's
// regen workflow has written it; the bundled JSON is the fallback.
// The factory stores page images as public bucket URLs; those are
// rewritten here to the admin-gated media route (the bucket's public
// domain is disabled), so no admin browser ever receives a public
// object URL.
function gatedChapters(chapters: any[]): any[] {
  return (chapters || []).map((ch: any) => ({
    ...ch,
    pages: (ch.pages || []).map((pg: any) => {
      const out = { ...pg };
      for (const field of ["image", "imageColor"]) {
        const raw = String(pg?.[field] || "");
        if (!raw) continue;
        const key = keyFromMediaValue(raw) || keyFromImageUrl(raw);
        const gated = key ? adminMediaUrl(key) : null;
        if (gated) out[field] = gated;
      }
      return out;
    }),
  }));
}
export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const slug = (url.searchParams.get('slug') || 'docker').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) {
    return Response.json({ error: 'bad slug' }, { status: 400 });
  }

  if (slug === 'docker') {
    const obj = await e.BOOKS.get('books/docker/editor_chapters.json');
    if (obj) {
      const chapters = gatedChapters(await loadFullChapters(e.BOOKS, slug, JSON.parse(await obj.text())));
      const totalPages = chapters.reduce((s: number, c: any) => s + c.pages.length, 0);
      const backColor = await e.BOOKS.head('books/docker/back-cover-color.jpg');
      const backLine = await e.BOOKS.head('books/docker/back-cover-line.jpg');
      return Response.json({
        title: "Wells the Whale and the Great Harbor",
        slug: "docker", totalPages, chapters,
        backCoverColor: backColor ? adminMediaUrl('books/docker/back-cover-color.jpg') : "",
        backCoverLine: backLine ? adminMediaUrl('books/docker/back-cover-line.jpg') : "",
      });
    }
    const chapters: any = gatedChapters(await loadFullChapters(e.BOOKS, slug, dockerChapters as any[]));
    const totalPages = chapters.reduce((s: number, c: any) => s + c.pages.length, 0);
    return Response.json({
      title: "Wells the Whale and the Great Harbor",
      slug: "docker", totalPages, chapters,
    });
  }

  const book = await e.DB.prepare("SELECT title, slug FROM books WHERE slug = ?").bind(slug).first();
  if (!book) return Response.json({ error: 'book not found' }, { status: 404 });

  const obj = await e.BOOKS.get(`books/${slug}/editor_chapters.json`);
  if (!obj) {
    return Response.json({ error: 'no editor data yet; the book is still building' }, { status: 404 });
  }
  const chapters = gatedChapters(await loadFullChapters(e.BOOKS, slug, JSON.parse(await obj.text())));
  const totalPages = chapters.reduce((s: number, c: any) => s + c.pages.length, 0);
  // Back cover art rides the same admin-gated media route as the story
  // pages; the QC viewer used to build a raw public-bucket URL for it,
  // which 404s (the bucket's public domain is disabled), so the back
  // cover silently never appeared in the viewer.
  const backColor = await e.BOOKS.head(`books/${slug}/back-cover-color.jpg`);
  const backLine = await e.BOOKS.head(`books/${slug}/back-cover-line.jpg`);
  return Response.json({
    title: book.title, slug, totalPages, chapters,
    backCoverColor: backColor ? adminMediaUrl(`books/${slug}/back-cover-color.jpg`) : "",
    backCoverLine: backLine ? adminMediaUrl(`books/${slug}/back-cover-line.jpg`) : "",
  });
};
