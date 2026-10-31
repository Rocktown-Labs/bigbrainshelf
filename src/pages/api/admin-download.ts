import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { downloadBaseName } from "../../lib/download-names";

// GET /api/admin-download?slug=&format=picture|coloring|epub|color|video
// Streams an assembled book output from R2 for the signed-in admin.
// The middleware already gates /api/* behind the admin session; the
// locals.user check here is defense in depth. Unlike /api/download
// (customer purchases), no order is required: this is the owner's path
// to pull finished files for review.
export const GET: APIRoute = async ({ url, locals }) => {
  const e = env as any;
  if (!(locals as any)?.user) {
    return Response.json({ error: "Sign in as admin to download." }, { status: 401 });
  }
  const slug = String(url.searchParams.get("slug") || "");
  const fmtParam = url.searchParams.get("format");
  const format = fmtParam === "coloring" || fmtParam === "epub" || fmtParam === "color" || fmtParam === "video"
    ? fmtParam : "picture";
  if (!slug) return Response.json({ error: "slug required" }, { status: 400 });

  const book = await e.DB.prepare(
    "SELECT title, public_slug, picture_book_key, coloring_book_key, epub_key, color_book_key, video_key FROM books WHERE slug = ?"
  ).bind(slug).first() as any;
  if (!book) return Response.json({ error: "Book not found." }, { status: 404 });

  const key = format === "coloring" ? book.coloring_book_key
    : format === "epub" ? book.epub_key
    : format === "color" ? book.color_book_key
    : format === "video" ? book.video_key
    : book.picture_book_key;
  if (!key) return Response.json({ error: "That output has not been generated yet." }, { status: 404 });

  const obj = await e.BOOKS.get(key);
  if (!obj) return Response.json({ error: "File not found." }, { status: 404 });

  const base = downloadBaseName(book);
  const filename = format === "epub" ? `${base}.epub`
    : format === "color" ? `${base}-color-book.pdf`
    : format === "video" ? `${base}-video.mp4`
    : `${base}-${format}-book.pdf`;
  const contentType = format === "epub" ? "application/epub+zip"
    : format === "video" ? "video/mp4"
    : "application/pdf";
  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
};
