// Public catalog projection tests for GET /api/books: the
// unauthenticated shape must contain only status='complete' books and
// only display fields. Availability booleans replace the raw R2
// storage keys (picture_book_key / coloring_book_key / audiobook_key
// values must never appear). Runs the real src/lib/books-public.ts
// against an in-memory bun:sqlite database behind a D1-shaped
// adapter. Run with: bun tests/books-public.test.ts
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { listPublicBooks, listCartBooks, toPublicBook, PUBLIC_BOOK_COLUMNS } from "../src/lib/books-public";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (id TEXT, slug TEXT, public_slug TEXT, title TEXT, bible_id TEXT, status TEXT, price INTEGER, price_print INTEGER, description TEXT, topic TEXT, topics TEXT, tier INTEGER, series TEXT, picture_book_key TEXT, coloring_book_key TEXT, cover_key TEXT, audiobook_key TEXT, published_at INTEGER, created_at INTEGER, updated_at INTEGER);
INSERT INTO books (id, slug, public_slug, title, bible_id, status, price, price_print, description, topic, topics, picture_book_key, coloring_book_key, cover_key, audiobook_key, published_at) VALUES
  ('id-live', 'livebook', 'live-book', 'Live Book', 'bible-1', 'complete', 899, 2000, 'A live book.', 'money', 'saving,investing', 'books/livebook/picture-book.pdf', 'books/livebook/coloring-book.pdf', 'books/livebook/cover-titled.jpg', 'books/livebook/audiobook.m4b', 1793000000),
  ('id-naked', 'nakedbook', NULL, 'Naked Book', 'bible-2', 'complete', 899, 2000, 'No files yet.', 'tech', 'docker', NULL, NULL, 'books/nakedbook/cover-titled.jpg', NULL, NULL),
  ('id-qa', 'qabook', 'qa-book', 'QA Book', 'bible-3', 'ready_for_qa', 899, 2000, 'Not public.', 'courage', 'practice', 'books/qabook/picture-book.pdf', 'books/qabook/coloring-book.pdf', 'books/qabook/cover-titled.jpg', 'books/qabook/audiobook.m4b', NULL),
  ('id-draft', 'draftbook', NULL, 'draftbook', 'bible-4', 'draft', 0, 0, NULL, '', '', NULL, NULL, NULL, NULL, NULL);
`);

// D1-shaped adapter: prepare(sql).bind(...).all()/.run() plus the
// bare .all() listPublicBooks used before. listPublicBooks now also
// runs the public_slug runtime-ensure (pragma + conditional ALTER),
// so the adapter needs the full surface.
const db = {
  prepare(sql: string) {
    return {
      all: async () => ({ results: raw.query(sql).all() }),
      bind(...args: any[]) {
        const stmt = raw.query(sql);
        return {
          all: async () => ({ results: stmt.all(...args) }),
          run: async () => ({ meta: { changes: (stmt.run(...args) as any)?.changes ?? 0 } }),
          first: async () => stmt.get(...args) ?? null,
        };
      },
    };
  },
};

const books = await listPublicBooks(db);

// Status scoping: only the books the storefront itself shows.
assert(books.length === 2, "public list contains exactly the complete books");
assert(books.every((b) => b.status === "complete"), "every public row is status=complete");
assert(!books.some((b) => b.slug === "qabook"), "ready_for_qa book is not in the public list");
assert(!books.some((b) => b.slug === "draftbook"), "draft book is not in the public list");

// Field allowlist: no storage keys, no internal ids anywhere.
const FORBIDDEN = ["picture_book_key", "coloring_book_key", "audiobook_key", "bible_id", "id", "tier", "series", "created_at", "updated_at"];
for (const b of books) {
  for (const f of FORBIDDEN) {
    assert(!(f in b), `public row ${b.slug} has no ${f} field`);
  }
}
const payload = JSON.stringify(books);
assert(!payload.includes("picture-book.pdf"), "payload contains no picture book storage path");
assert(!payload.includes("coloring-book.pdf"), "payload contains no coloring book storage path");
assert(!payload.includes("audiobook.m4b"), "payload contains no audiobook storage path");
assert(!payload.includes("id-live"), "payload contains no internal row id");

// Display fields the storefront uses are all present.
const live = books.find((b) => b.slug === "livebook")!;
assert(live.title === "Live Book" && live.price === 899 && live.price_print === 2000, "title and prices survive the projection");
assert(live.topic === "money" && live.topics === "saving,investing", "shelf topic and subject topics survive");
assert(live.cover_key === "books/livebook/cover-titled.jpg", "cover_key (display field) survives");
assert(live.published_at === 1793000000, "published_at survives");
assert(live.description === "A live book.", "description survives");

// Public slug layer: slug stays the internal key; links ride href,
// built from the title-based public slug.
assert(live.public_slug === "live-book", "public_slug survives the projection");
assert(live.href === "/books/live-book", "href is built from the public slug");

// Availability flags carry what the raw-key truthiness checks meant.
assert(live.has_audiobook === true && live.has_picture_book === true && live.has_coloring_book === true, "flags are true when the files exist");
const naked = books.find((b) => b.slug === "nakedbook")!;
assert(naked.public_slug === null, "a book without a public slug projects null");
assert(naked.href === "/books/nakedbook", "href falls back to the internal slug while no public slug is minted");
assert(naked.has_audiobook === false && naked.has_picture_book === false && naked.has_coloring_book === false, "flags are false when the files are absent");

// The cart-resolution list (?scope=cart): the public catalog plus
// the audio-published books (cover + audio, any other status), the
// extras projected audio-only so no cart script can price their
// book formats. qabook (ready_for_qa, cover + audio) is the case;
// draftbook (no cover, no audio) stays out.
const cartBooks = await listCartBooks(db);
assert(cartBooks.length === 3, "cart list is the public catalog plus the audio-published books");
assert(cartBooks.some((b) => b.slug === "livebook") && cartBooks.some((b) => b.slug === "nakedbook"), "cart list keeps every public book");
assert(!cartBooks.some((b) => b.slug === "draftbook"), "a book with no cover and no audiobook stays out of the cart list");
const qa = cartBooks.find((b) => b.slug === "qabook")!;
assert(!!qa, "the audio-published ready_for_qa book is in the cart list");
assert(qa.has_audiobook === true, "cart list: the audio-published book flags its audiobook");
assert(qa.price === 0 && qa.price_print === null, "cart list: the audio-published book's book prices are zeroed");
assert(qa.has_picture_book === false && qa.has_coloring_book === false, "cart list: the audio-published book's gift set flags are cleared");
const liveInCart = cartBooks.find((b) => b.slug === "livebook")!;
assert(liveInCart.price === 899 && liveInCart.price_print === 2000, "cart list: published books keep their real prices");

// toPublicBook drops anything extra even if a row carries it.
const shaped = toPublicBook({ slug: "x", title: "X", status: "complete", price: 1, picture_book_key: "secret/path.pdf", audiobook_key: "secret/a.m4b", has_audiobook: 1, has_picture_book: 0, has_coloring_book: 0, evil: "field" } as any);
assert(!("picture_book_key" in shaped) && !("evil" in shaped), "toPublicBook drops non-allowlist fields");
assert(shaped.has_audiobook === true && shaped.has_picture_book === false, "toPublicBook coerces flag integers to booleans");

// The SELECT itself never names the raw key columns as output fields
// (they appear only inside the IS NOT NULL flag expressions).
assert(!PUBLIC_BOOK_COLUMNS.includes("AS picture_book_key") && !/,\s*audiobook_key\s*,/.test(PUBLIC_BOOK_COLUMNS), "column list exposes no raw key outputs");

// The route wires the two audiences as designed (source-level check:
// the endpoint file itself cannot run under bun, it imports
// cloudflare:workers).
const route = readFileSync(new URL("../src/pages/api/books.ts", import.meta.url), "utf8");
assert(route.includes("listPublicBooks(db)"), "route serves the public projection to unauthenticated callers");
assert(route.includes('searchParams.get(\'scope\') === \'cart\'') && route.includes("listCartBooks(db)"), "route serves the cart-resolution list only on the explicit cart scope");
const middleware = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
assert(middleware.includes('searchParams.get("scope") === "cart"'), "middleware passes the cart-scope books read publicly, like the catalog read");
assert(route.includes("locals as any)?.user") || route.includes("(locals as any)?.user"), "route branches on the admin session");
assert(!route.includes("WHERE status = '"), "route no longer interpolates the status filter into SQL");

// The public storefront scripts resolve availability flags-first:
// the public shape's has_* booleans are the contract, and the raw
// key columns are read ONLY as a presence fallback for the admin
// full-row shape (an admin cart once lost audio / gift set items
// because the scripts knew the flags and nothing else; the full
// matrix is pinned in tests/cart-resolution.test.ts). Key VALUES
// still never leave the server in the public shape (asserted
// above); reading one for truthiness client-side exposes nothing.
// The resolving script now lives in ONE place, the shared cart
// store the header ships; the pages wire into it (the shared sheet
// component, or the store directly on /cart) and keep no private
// copy, so the flag-first read is pinned on the store and the
// never-build-a-URL rule is pinned on pages and store alike.
const cartStoreSrc = readFileSync(new URL("../src/components/CartStore.astro", import.meta.url), "utf8");
assert(
  cartStoreSrc.includes("b.has_audiobook") || cartStoreSrc.includes('flagOf(b, "has_audiobook", "audiobook_key")'),
  "cart store client script reads has_audiobook (flag-first, key fallback)",
);
const cartSheetSrc = readFileSync(new URL("../src/components/CartSheet.astro", import.meta.url), "utf8");
for (const [page, src] of [
  ...["index.astro", "about.astro", "cart.astro", "clubs.astro", "books/[slug].astro"].map(
    (page) => [page, readFileSync(new URL(`../src/pages/${page}`, import.meta.url), "utf8")] as const,
  ),
  ["components/CartStore.astro", cartStoreSrc] as const,
  ["components/CartSheet.astro", cartSheetSrc] as const,
]) {
  assert(
    !/R2 \+ b\.(picture_book_key|coloring_book_key|audiobook_key)/.test(src) && !/\+ b\.(picture_book_key|coloring_book_key|audiobook_key) \+/.test(src),
    `${page} client scripts never build a URL from a raw key value`,
  );
}
for (const page of ["index.astro", "about.astro", "clubs.astro", "books/[slug].astro"]) {
  const src = readFileSync(new URL(`../src/pages/${page}`, import.meta.url), "utf8");
  assert(src.includes("<CartSheet"), `${page} wires into the shared cart sheet (and its store)`);
}
{
  const src = readFileSync(new URL("../src/pages/cart.astro", import.meta.url), "utf8");
  assert(src.includes('Astro.redirect("/?cart=open", 301)') && src.includes('Astro.redirect("/checkout?checkout=cancelled", 301)'), "cart.astro defers to the shared cart: plain visits redirect into the drawer, cancelled returns to the checkout page");
}

if (failures) { console.error(`${failures} assertion(s) failed`); process.exit(1); }
console.log("All books-public assertions passed");
