import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { getSamplePages, SAMPLE_SIZE } from "../../../../lib/sample";
import { contentTypeForKey } from "../../../../lib/character-sheets";
import { resolveInternalSlug } from "../../../../lib/public-slugs";

// GET /api/sample/{slug}/{n}  (n is 1-based, 1..5)
//
// Serves exactly one page of a book's free sample. The page list is
// recomputed from the defect-screened selection in src/lib/sample.ts
// on every request: only the first 5 defect-free pages of the book
// can ever be served here, in sample order. Anything else (page 6+,
// a defect-listed page, the full PDF) is unreachable through this
// route and returns 404.
//
// The {slug} segment is the book's PUBLIC slug (book pages address
// samples by it); it is resolved to the internal slug here, and the
// sample selection itself only ever runs on the internal slug. The
// internal form also resolves, for any older saved link.
export const GET: APIRoute = async ({ params }) => {
  const e = env as any;
  const rawSlug = String(params.slug || "").trim().toLowerCase();
  const n = Number(params.n);
  if (!/^[a-z0-9-]+$/.test(rawSlug) || !Number.isInteger(n) || n < 1 || n > SAMPLE_SIZE) {
    return new Response("Not found", { status: 404 });
  }
  const slug = await resolveInternalSlug(e.DB, rawSlug).catch(() => null);
  if (!slug) return new Response("Not found", { status: 404 });
  // Catalog books only: a book with no finished picture book (for
  // example a partial build) has no verified pages to sample.
  const book = await e.DB.prepare("SELECT slug FROM books WHERE slug = ? AND picture_book_key IS NOT NULL").bind(slug).first();
  if (!book) return new Response("Not found", { status: 404 });

  const pages = await getSamplePages(e, slug);
  const page = pages[n - 1];
  if (!page) return new Response("Not found", { status: 404 });

  const obj = await e.BOOKS.get(page.key);
  if (!obj) return new Response("Not found", { status: 404 });

  return new Response(obj.body, {
    headers: {
      "Content-Type": contentTypeForKey(page.key, obj.httpMetadata?.contentType),
      "Cache-Control": "public, max-age=86400",
      "X-Sample-Page": page.label,
      "X-Sample-Kind": page.kind,
    },
  });
};
