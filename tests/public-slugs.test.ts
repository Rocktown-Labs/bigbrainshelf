// Public slug layer tests (CG ruling, 2026-10-28): public book URLs
// are title-based (/books/mira-the-heron-and-the-still-water) while
// the internal, source-derived slug stays the system key. Pins:
//   - slugifyTitle over the real catalog titles,
//   - the runtime column ensure + backfill over all 9 real books,
//   - route resolution (public first, internal flagged for the 301),
//   - the checkout/sample boundary resolver (any form -> internal),
//   - minting: publish-path ensure + collision handling (against
//     other public slugs AND other books' internal slugs),
//   - search candidates link publicly while meta.slug stays internal,
//   - wiring: book/read pages redirect, publish mints, checkout
//     translates, sample route resolves.
// Run with: bun tests/public-slugs.test.ts
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  slugifyTitle,
  publicSlugFor,
  bookHref,
  readHref,
  ensurePublicSlugColumn,
  resolveBookForPublicRoute,
  resolveInternalSlug,
  uniquePublicSlug,
  ensureBookPublicSlug,
  backfillPublicSlugs,
} from "../src/lib/public-slugs";
import { bookCandidate, audioCandidate } from "../src/lib/search";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

// ---- slugify over the real catalog -------------------------------------
const CATALOG: [string, string, string][] = [
  // internal slug, D1 title, expected public slug
  ["mastery", "Mira the Heron and the Still Water", "mira-the-heron-and-the-still-water"],
  ["richdadpoordad", "Penny the Squirrel and the Acorn Orchard", "penny-the-squirrel-and-the-acorn-orchard"],
  ["thewarofart", "Wren the Songbird and the Gray Fog", "wren-the-songbird-and-the-gray-fog"],
  ["algorithms", "Fern the Fox and the Clever Trails", "fern-the-fox-and-the-clever-trails"],
  ["docker", "Wally the Whale and the Great Harbor", "wally-the-whale-and-the-great-harbor"],
  ["designpatterns", "Basil the Beaver and the Pattern Book", "basil-the-beaver-and-the-pattern-book"],
  ["compoundeffect", "Maisie the Mouse and the Jar That Grew", "maisie-the-mouse-and-the-jar-that-grew"],
  ["motivationmanifesto", "Juno the Swift and the Wide Sky", "juno-the-swift-and-the-wide-sky"],
  ["iwillteach", "Tilda the Magpie and the Treasure That Sorted Itself", "tilda-the-magpie-and-the-treasure-that-sorted-itself"],
];
for (const [, title, expected] of CATALOG) {
  assert(slugifyTitle(title) === expected, `slugify: ${title} -> ${expected}`);
}
assert(slugifyTitle("Pip's Big Day!") === "pip-s-big-day", "slugify: apostrophes and punctuation drop to hyphens");
assert(slugifyTitle("Tom & Jerry") === "tom-and-jerry", "slugify: ampersand spells out");
assert(slugifyTitle("") === "", "slugify: empty title slugifies empty (mint falls back to the internal slug)");

// ---- pure helpers --------------------------------------------------------
assert(publicSlugFor({ slug: "mastery", public_slug: "mira-x" }) === "mira-x", "publicSlugFor prefers the public slug");
assert(publicSlugFor({ slug: "mastery", public_slug: null }) === "mastery", "publicSlugFor falls back to the internal slug");
assert(publicSlugFor({ slug: "mastery", public_slug: "  " }) === "mastery", "publicSlugFor treats a blank public slug as none");
assert(bookHref({ slug: "mastery", public_slug: "mira-x" }) === "/books/mira-x", "bookHref builds the public book path");
assert(readHref({ slug: "mastery", public_slug: "mira-x" }) === "/read/mira-x", "readHref builds the public reader path");

// ---- in-memory D1 ---------------------------------------------------------
const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, status TEXT);
`);
const db = {
  prepare(sql: string) {
    return {
      bind(...args: any[]) {
        const stmt = raw.query(sql);
        return {
          async run() { const r = stmt.run(...args) as any; return { meta: { changes: r?.changes ?? 0 } }; },
          async first() { return stmt.get(...args) ?? null; },
          async all() { return { results: stmt.all(...args) }; },
        };
      },
    };
  },
} as any;

// The table starts WITHOUT public_slug: the runtime ensure adds it,
// the same self-heal a fresh environment gets.
await ensurePublicSlugColumn(db);
const cols = raw.query("PRAGMA table_info(books)").all().map((c: any) => c.name);
assert(cols.includes("public_slug"), "ensurePublicSlugColumn adds the column when missing");
await ensurePublicSlugColumn(db); // second call is a no-op, not an error

for (const [slug, title] of CATALOG.map(([s, t]) => [s, t] as [string, string])) {
  raw.query("INSERT INTO books (slug, title, status) VALUES (?, ?, 'ready_for_qa')").run(slug, title);
}

// ---- backfill --------------------------------------------------------------
const assigned = await backfillPublicSlugs(db);
assert(assigned.length === 9, "backfill assigns all 9 books");
const expectedBySlug = new Map(CATALOG.map(([s, , p]) => [s, p]));
for (const a of assigned) {
  assert(a.public_slug === expectedBySlug.get(a.slug), `backfill: ${a.slug} -> ${a.public_slug}`);
}
assert(new Set(assigned.map((a) => a.public_slug)).size === 9, "backfill: all public slugs unique");
const second = await backfillPublicSlugs(db);
assert(second.length === 0, "backfill is idempotent: nothing left to assign");

// ---- resolution --------------------------------------------------------------
const byPublic = await resolveBookForPublicRoute(db, "mira-the-heron-and-the-still-water");
assert(byPublic?.book.slug === "mastery" && byPublic?.via === "public", "public slug resolves to the book, via=public");
const byInternal = await resolveBookForPublicRoute(db, "mastery");
assert(byInternal?.book.slug === "mastery" && byInternal?.via === "internal", "stale internal slug resolves, via=internal (the routes 301 it)");
assert((await resolveBookForPublicRoute(db, "nope-not-a-book")) === null, "unknown param resolves to null");
assert((await resolveInternalSlug(db, "penny-the-squirrel-and-the-acorn-orchard")) === "richdadpoordad", "boundary resolver: public -> internal");
assert((await resolveInternalSlug(db, "docker")) === "docker", "boundary resolver: internal passes through");
assert((await resolveInternalSlug(db, "ghost")) === null, "boundary resolver: unknown -> null");

// ---- minting / publish path ---------------------------------------------------
raw.query("INSERT INTO books (slug, title, status) VALUES ('newbook', 'Pip the Pelican and the Long Tide', 'ready_for_qa')").run();
const minted = await ensureBookPublicSlug(db, "newbook");
assert(minted === "pip-the-pelican-and-the-long-tide", "publish path mints from the title");
assert((await ensureBookPublicSlug(db, "newbook")) === minted, "publish path never re-mints an existing public slug");
assert((await ensureBookPublicSlug(db, "mastery")) === "mira-the-heron-and-the-still-water", "publish path returns the backfilled slug untouched");
assert((await ensureBookPublicSlug(db, "ghost")) === null, "publish path: unknown book -> null");

// Collision against another book's PUBLIC slug: a second book with
// Mira's exact title gets the -2 suffix, never a duplicate.
raw.query("INSERT INTO books (slug, title, status) VALUES ('miraclone', 'Mira the Heron and the Still Water', 'draft')").run();
assert((await ensureBookPublicSlug(db, "miraclone")) === "mira-the-heron-and-the-still-water-2", "collision with an existing public slug gets -2");
// Collision against another book's INTERNAL slug: a book titled
// "Docker" would slugify onto docker's internal slug and shadow it.
raw.query("INSERT INTO books (slug, title, status) VALUES ('titleddocker', 'Docker', 'draft')").run();
assert((await ensureBookPublicSlug(db, "titleddocker")) === "docker-2", "collision with another book's internal slug gets -2");
assert((await uniquePublicSlug(db, "wally-the-whale-and-the-great-harbor", "docker")) === "wally-the-whale-and-the-great-harbor", "uniquePublicSlug: a book's own public slug is not a collision with itself");
assert((await uniquePublicSlug(db, "wally-the-whale-and-the-great-harbor", "someoneelse")) === "wally-the-whale-and-the-great-harbor-2", "uniquePublicSlug suffixes a base another book owns");

// ---- search candidates ---------------------------------------------------------
const miraRow: any = { slug: "mastery", public_slug: "mira-the-heron-and-the-still-water", title: "Mira the Heron and the Still Water", topic: "courage", topics: "mastery", cover_key: null, audiobook_key: "x.m4b", status: "complete" };
const bc = bookCandidate(miraRow, "Mira", [], []);
assert(bc.item.href === "/books/mira-the-heron-and-the-still-water", "search book href carries the public slug");
assert(bc.item.meta.slug === "mastery", "search meta.slug stays internal (cast boost keying)");
const ac = audioCandidate(miraRow, "Mira", [], []);
assert(ac.item.href === "/books/mira-the-heron-and-the-still-water?format=audio", "search audio href carries the public slug + format");
const noPublic = bookCandidate({ ...miraRow, public_slug: null }, "Mira", [], []);
assert(noPublic.item.href === "/books/mastery", "search href falls back to the internal slug when none is minted");

// ---- wiring ---------------------------------------------------------------------
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const bookPage = read("../src/pages/books/[slug].astro");
assert(bookPage.includes("resolveBookForPublicRoute"), "book page resolves its param through the public slug layer");
assert(bookPage.includes('return Astro.redirect(`/books/${publicSlug}${Astro.url.search}`, 301)'), "book page 301s a stale internal slug to the public URL");
assert(bookPage.includes("https://bigbrainshelf.com/books/${publicSlug}"), "book page canonical/OG uses the public slug");
assert(bookPage.includes('define:vars={{ slug, publicSlug,'), "book page buy script carries both slug forms (path check public, cart internal)");
assert(bookPage.includes('"/api/sample/" + publicSlug'), "book page sample viewer addresses the sample route by public slug");

const readPage = read("../src/pages/read/[slug].astro");
assert(readPage.includes("resolveBookForPublicRoute"), "reader resolves its param through the public slug layer");
assert(readPage.includes("`/read/${publicSlugFor(resolved.book)}${Astro.url.search}`, 301"), "reader 301s a stale internal slug to the public URL");

const sampleRoute = read("../src/pages/api/sample/[slug]/[n].ts");
assert(sampleRoute.includes("resolveInternalSlug"), "sample route resolves its param to the internal slug");

const publishRoute = read("../src/pages/api/editor/publish.ts");
assert(publishRoute.includes("ensureBookPublicSlug"), "publish path mints the public slug");

const checkoutRoute = read("../src/pages/api/checkout.ts");
assert(checkoutRoute.includes("resolveInternalSlug"), "checkout translates public slugs to internal at its boundary");

const accountPage = read("../src/pages/account/book/[slug].astro");
assert(accountPage.includes("href={`/read/${pub}`}"), "book overview read links carry the public slug");
assert(accountPage.includes("/api/download?slug=${encodeURIComponent(book.slug)}"), "book overview download links keep keying on the internal slug");

const castIndex = read("../src/pages/meet-the-cast.astro");
assert(castIndex.includes("/books/${g.bookPublicSlug}"), "Meet the Cast index book links carry the public slug");
const castPage = read("../src/pages/meet-the-cast/[character].astro");
assert(castPage.includes("/books/${page.bookPublicSlug}"), "character page book link carries the public slug");

const releasesLib = read("../src/lib/releases.ts");
assert(releasesLib.includes("bookUrl: `${site}${bookHref(book)}`"), "release announcement emails link the public book URL");

const homePage = read("../src/pages/index.astro");
assert(homePage.includes("b.href ||"), "home shelf cards link through the payload href (public) with an internal fallback");

if (failures) { console.error(`${failures} assertion(s) failed`); process.exit(1); }
console.log("All public-slug assertions passed");
