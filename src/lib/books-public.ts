// Public catalog projection for GET /api/books.
//
// The books table carries internal storage data (R2 keys for the PDFs
// and the audiobook, the bible id, factory fields). None of that may
// reach an unauthenticated response: the public endpoint returns only
// the books the storefront itself shows (status='complete', the same
// definition the home shelf and search use) and only display fields.
// Where storefront scripts used the raw keys as availability checks
// (audio format pricing, gift-set eligibility, format filter), the
// projection exposes booleans instead: has_audiobook,
// has_picture_book, has_coloring_book. The key VALUES never leave
// the server. Admin consumers get the full rows through the route's
// authenticated branch, not through here.
//
// The projection also carries the book's PUBLIC slug (title-based,
// see src/lib/public-slugs.ts) and a ready-made href built from it:
// the slug field stays the internal system key (cart and checkout
// resolve against it), but every link a consumer renders must go
// through href / public_slug, never "/books/" + slug.

import { bookHref, ensurePublicSlugColumn } from "./public-slugs";
import { coverDerivative } from "./derivatives";

export const PUBLIC_BOOK_COLUMNS = [
  "slug",
  "public_slug",
  "title",
  "status",
  "description",
  "topic",
  "topics",
  "price",
  "price_print",
  "cover_key",
  "published_at",
  "(audiobook_key IS NOT NULL AND audiobook_key <> '') AS has_audiobook",
  "(picture_book_key IS NOT NULL AND picture_book_key <> '') AS has_picture_book",
  "(coloring_book_key IS NOT NULL AND coloring_book_key <> '') AS has_coloring_book",
].join(", ");

export interface PublicBook {
  slug: string;
  public_slug: string | null;
  href: string;
  title: string;
  status: string;
  description: string | null;
  topic: string | null;
  topics: string | null;
  price: number;
  price_print: number | null;
  cover_key: string | null;
  published_at: number | null;
  has_audiobook: boolean;
  has_picture_book: boolean;
  has_coloring_book: boolean;
}

// Shape one projected row. Anything not on the allowlist is dropped,
// even if a future column sneaks into the SELECT list.
export function toPublicBook(row: any): PublicBook {
  return {
    slug: row.slug,
    public_slug: row.public_slug ?? null,
    href: bookHref(row),
    title: row.title,
    status: row.status,
    description: row.description ?? null,
    topic: row.topic ?? null,
    topics: row.topics ?? null,
    price: row.price,
    price_print: row.price_print ?? null,
    cover_key: row.cover_key ?? null,
    published_at: row.published_at ?? null,
    has_audiobook: !!row.has_audiobook,
    has_picture_book: !!row.has_picture_book,
    has_coloring_book: !!row.has_coloring_book,
  };
}

// The admin branch of GET /api/books returns full rows, which carry
// the raw *_key columns but not the has_* booleans the storefront's
// cart scripts resolve availability against. Stamp the flags from
// the keys so every response shape satisfies the same availability
// contract. (Without this, an admin-signed-in shopper's cart sheet
// priced audio and gift set items at 0 and dropped them while the
// header badge still counted them.) Rows that already carry the
// flags (the public projection) pass through untouched.
export function withAvailabilityFlags<T extends Record<string, any>>(row: T): T {
  if (row.has_audiobook === undefined && "audiobook_key" in row) {
    row.has_audiobook = !!row.audiobook_key;
  }
  if (row.has_picture_book === undefined && "picture_book_key" in row) {
    row.has_picture_book = !!row.picture_book_key;
  }
  if (row.has_coloring_book === undefined && "coloring_book_key" in row) {
    row.has_coloring_book = !!row.coloring_book_key;
  }
  return row;
}

// The complete-only catalog list for unauthenticated callers. The
// status filter lives in the query itself, so a caller-supplied
// ?status= can never widen it.
export async function listPublicBooks(db: any): Promise<PublicBook[]> {
  await ensurePublicSlugColumn(db);
  const { results } = await db
    .prepare(`SELECT ${PUBLIC_BOOK_COLUMNS} FROM books WHERE status = 'complete'`)
    .all();
  return (results as any[]).map(toPublicBook);
}

// The home shelf's display list: the public projection plus the
// exact enrichments GET /api/books applies on top of it for its
// consumers (availability flags, the bible title fallback for rows
// whose title is still their slug, the right-sized cover
// derivatives, and the ready-made public href). The home page
// server-renders its shelf from this so first paint carries the
// books; the API route keeps its own copy of the same steps because
// its admin and cart shapes need them at different points.
export async function listPublicShelfBooks(db: any): Promise<any[]> {
  let results: any[] = await listPublicBooks(db);
  results = results.map(withAvailabilityFlags);
  try {
    const { results: bibles } = await db
      .prepare('SELECT book_slug, book_title FROM bibles ORDER BY created_at ASC')
      .all();
    const titleBySlug = new Map<string, string>();
    for (const b of bibles as any[]) {
      if (b.book_slug && b.book_title) titleBySlug.set(b.book_slug, b.book_title);
    }
    for (const row of results as any[]) {
      if ((!row.title || row.title === row.slug) && titleBySlug.has(row.slug)) {
        row.title = titleBySlug.get(row.slug);
      }
      row.cover_card = coverDerivative(row.slug, 'card', row.cover_key);
      row.cover_hero = coverDerivative(row.slug, 'hero', row.cover_key);
      row.href = bookHref(row);
    }
  } catch { /* bibles table unavailable: raw titles stand */ }
  return results;
}

// The cart-resolution list (GET /api/books?scope=cart): the public
// catalog PLUS every audio-published book (a cover and an audiobook
// on file, any other status; CG, 2026-10-29), so the cart scripts
// can price the one format those books sell. The extra rows are
// projected audio-only: prices zeroed and the picture/coloring
// flags cleared, so no consumer of this list can price their
// digital, printed, or gift set formats above 0 (checkout enforces
// the same gate server-side). This list is never a display catalog:
// the storefront shelf and search keep using listPublicBooks.
export async function listCartBooks(db: any): Promise<PublicBook[]> {
  const complete = await listPublicBooks(db);
  const { results } = await db
    .prepare(
      `SELECT ${PUBLIC_BOOK_COLUMNS} FROM books WHERE status <> 'complete' AND cover_key IS NOT NULL AND audiobook_key IS NOT NULL`
    )
    .all();
  const extra = ((results || []) as any[]).map((row) => {
    const b = toPublicBook(row);
    return {
      ...b,
      price: 0,
      price_print: null,
      has_picture_book: false,
      has_coloring_book: false,
    };
  });
  return [...complete, ...extra];
}
