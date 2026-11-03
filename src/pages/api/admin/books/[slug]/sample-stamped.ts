import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { resolveBookForPublicRoute } from "../../../../../lib/public-slugs";
import { stampPdfForBuyer } from "../../../../../lib/pdf-stamp";

// GET /api/admin/books/{public-slug}/sample-stamped
// A real buyer-shaped copy of the book's story PDF, stamped by
// the same code /api/download runs, with the sample reader name
// "Ruby" on the dedication page. The dedication page only exists
// in stamped downloads (it is inserted after the cover per
// download, filled from the family's reader profile), so this is
// the only honest way to show it in QC: the actual bytes a buyer
// would get, page 2 included.
export const GET: APIRoute = async ({ params }) => {
  const e = env as any;
  const param = String(params.slug || "");
  const resolved = await resolveBookForPublicRoute(e.DB, param).catch(() => null);
  if (!resolved) return new Response("book not found", { status: 404 });
  const book: any = resolved.book;
  const key = book.picture_book_key ? String(book.picture_book_key) : null;
  if (!key) return new Response("this book has no story PDF yet", { status: 409 });
  const obj = await e.BOOKS.get(key);
  if (!obj) return new Response("story PDF missing from storage", { status: 404 });
  const raw = new Uint8Array(await obj.arrayBuffer());
  const producedOn = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
  let body: Uint8Array;
  try {
    body = await stampPdfForBuyer(raw, {
      email: "sample@bigbrainshelf.com",
      shortId: null,
      marker: "admin-sample",
      markerIsOrder: false,
      childName: "Ruby",
      bookTitle: book.title ? String(book.title) : null,
      producedOn,
    });
  } catch (err: any) {
    return new Response(`stamping failed: ${String(err?.message || err)}`, { status: 500 });
  }
  return new Response(body as any, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${param}-sample.pdf"`,
      "Content-Length": String(body.byteLength),
    },
  });
};
