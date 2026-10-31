// Admin book URLs + reviewer chapter labels (owner, 2026-10-29).
// Admin book routes wear the book's PUBLIC slug: the route param
// resolves by public_slug first and falls back to the internal slug,
// links across the admin emit the public slug, and internals (D1
// slug column, R2 keys, factory/API calls) keep the internal slug.
// In the QC viewer and Story Review, chapter references wear the
// "Ch: {n} - " prefix. Run with: bun tests/admin-book-urls.test.ts
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  publicSlugFor,
  resolveBookForPublicRoute,
  resolveInternalSlug,
} from "../src/lib/public-slugs";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, public_slug TEXT, title TEXT, status TEXT);
INSERT INTO books VALUES ('algorithms', 'fern-the-fox-and-the-clever-trails', 'Fern the Fox and the Clever Trails', 'complete');
INSERT INTO books VALUES ('docker', 'wally-the-whale-and-the-great-harbor', 'Wally the Whale and the Great Harbor', 'complete');
INSERT INTO books VALUES ('newbook', NULL, 'Untitled Draft', 'draft');
`);
const db = {
  prepare(sql: string) {
    return {
      bind(...args: any[]) {
        const stmt = raw.query(sql);
        return {
          async run() { stmt.run(...args); return {}; },
          async first() { return stmt.get(...args) ?? null; },
          async all() { return { results: stmt.all(...args) }; },
        };
      },
    };
  },
} as any;

// --- Resolution: public first, internal fallback ----------------------
const byPublic = await resolveBookForPublicRoute(db, "fern-the-fox-and-the-clever-trails");
assert(byPublic?.book.slug === "algorithms" && byPublic?.via === "public", "resolver: the public slug resolves to the book, via public");
const byInternal = await resolveBookForPublicRoute(db, "algorithms");
assert(byInternal?.book.slug === "algorithms" && byInternal?.via === "internal", "resolver: the internal slug still resolves (existing links keep working), via internal");
assert((await resolveBookForPublicRoute(db, "no-such-book")) === null, "resolver: an unknown param resolves to nothing");
assert((await resolveInternalSlug(db, "wally-the-whale-and-the-great-harbor")) === "docker", "resolver: public maps back to the internal slug for internals");
assert((await resolveInternalSlug(db, "docker")) === "docker", "resolver: internal maps to itself");
const noPublic = await resolveBookForPublicRoute(db, "newbook");
assert(noPublic?.book.slug === "newbook" && noPublic?.via === "public", "resolver: a book with no public slug resolves its internal slug as canonical");
assert(publicSlugFor({ slug: "newbook", public_slug: null }) === "newbook", "links: a book with no public slug links by its internal slug");
assert(publicSlugFor({ slug: "algorithms", public_slug: "fern-the-fox-and-the-clever-trails" }) === "fern-the-fox-and-the-clever-trails", "links: a book with a public slug links by it");

// --- Source pins: every admin book page resolves + links publicly -----
for (const [rel, label] of [
  ["../src/pages/admin/books/[slug].astro", "QC page"],
  ["../src/pages/admin/books/[slug]/edit.astro", "full editor"],
  ["../src/pages/admin/books/[slug]/crops.astro", "pose crops"],
  ["../src/pages/admin/books/[slug]/review.astro", "story review"],
  ["../src/pages/admin/books/[slug]/read.astro", "read redirect"],
] as const) {
  const src = read(rel);
  assert(src.includes("resolveBookForPublicRoute"), `${label}: resolves the route param (public first, internal fallback)`);
  assert(src.includes("adminSlug") || src.includes("publicSlugFor"), `${label}: carries the public slug for its links`);
}
assert(read("../src/pages/admin/books/[slug]/read.astro").includes("Astro.redirect(`/admin/books/${target}`"), "read redirect: bounces to the resolved public-slug URL");
const editSrc = read("../src/pages/admin/books/[slug]/edit.astro");
assert(!editSrc.includes('pathname.split("/")[3]'), "full editor: the slug no longer comes from the URL (public URLs would break its API calls)");
assert(editSrc.includes("var BOOK_SLUG = slug;"), "full editor: API calls key on the resolved internal slug");
const qcSrc = read("../src/pages/admin/books/[slug].astro");
assert(qcSrc.includes('"/admin/books/" + adminSlug + "/review"'), "QC page: the Story review link wears the public slug");
assert(qcSrc.includes("esc(adminSlug) + '/edit") && qcSrc.includes("esc(adminSlug) + '/crops"), "QC page: editor and crops links wear the public slug");

const booksList = read("../src/pages/admin/books.astro");
assert(booksList.includes("var pub = b.public_slug || b.slug;"), "books list: link slug is public_slug with internal fallback");
assert(booksList.includes('"/admin/books/" + pub') || booksList.includes("/admin/books/' + pub"), "books list: card links wear the public slug");
const bibles = read("../src/pages/admin/bibles.astro");
assert(bibles.includes("pubByInternal[b.book_slug] || b.book_slug"), "bibles: Open the book link maps to the public slug");
const dashLib = read("../src/lib/admin-dashboard.ts");
assert(dashLib.includes("adminSlug: publicSlugFor(b)"), "dashboard: needs-attention books carry their public slug");
assert(read("../src/pages/admin/index.astro").includes("/admin/books/${b.adminSlug}"), "dashboard: needs-attention rows link by the public slug");
assert(read("../src/pages/admin/audiobooks/[slug].astro").includes("publicSlugFor(book)}/review"), "audiobook page: the Story Review link wears the public slug");

// --- Chapter labels: "Ch: {n} - " in the QC viewer + Story Review -----
assert(qcSrc.includes('"Ch: " + (ci + 1) + " - " + ch.title'), "QC viewer: chapterTitle carries the Ch: n - prefix (rail, position line, captions read it)");
assert(qcSrc.includes('esc(p.chapterTitle) + " · Page "'), "QC viewer: the position line reads the prefixed chapter title");
const reviewSrc = read("../src/pages/admin/books/[slug]/review.astro");
assert(reviewSrc.includes("Ch: {ch.num} - {ch.title}"), "story review: chapter headings and jump chips carry the Ch: n - prefix");
assert(!reviewSrc.includes("Chapter {ch.num}: {ch.title}"), "story review: the old Chapter n: heading is gone");
assert(!reviewSrc.includes(">Ch {ch.num}</button>"), "story review: chips no longer stop at the bare number");

if (failures) { console.error(failures + " admin-book-urls test(s) failed"); process.exit(1); }
console.log("All admin-book-urls tests passed.");
