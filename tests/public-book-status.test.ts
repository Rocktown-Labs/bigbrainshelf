// SECURITY F8 (2026-10-31): unpublished books were publicly browsable
// and sampleable by slug — the public resolver had no status filter,
// and the sample route checked only picture_book_key. Now the public
// book pages serve only LISTED books (status 'complete', or
// audio-published: cover + audiobook), and samples are complete-only.
// Run with: bun tests/public-book-status.test.ts
import { Database } from "bun:sqlite";
import { isBookPubliclyListed, resolveBookForPublicRoute } from "../src/lib/public-slugs";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const read = async (rel: string) =>
  Bun.file(new URL(rel, import.meta.url)).text();

// ---- Live listing rule -----------------------------------------------------
assert(isBookPubliclyListed({ status: "complete" }) === true, "published book is listed");
assert(
  isBookPubliclyListed({ status: "ready_for_qa", cover_key: "c.jpg", audiobook_key: "a.m4b" }) === true,
  "audio-published book (cover + audiobook, any status) is listed"
);
assert(
  isBookPubliclyListed({ status: "ready_for_qa", cover_key: "c.jpg" }) === false,
  "draft with no audiobook is not listed"
);
assert(isBookPubliclyListed({ status: "repair_failed", cover_key: "c.jpg" }) === false, "repair-failed draft is not listed");
assert(isBookPubliclyListed({ status: "draft" }) === false, "bare draft is not listed");
assert(isBookPubliclyListed(null) === false, "no book is not listed");

// The resolver itself stays status-free on purpose (internal surfaces
// like the admin pages and the entitlement-gated reader resolve by any
// status); the PAGE applies the listing rule. Verified against an
// in-memory catalog:
const raw = new Database(":memory:");
raw.exec(`
  CREATE TABLE books (
    slug TEXT PRIMARY KEY, title TEXT, status TEXT,
    cover_key TEXT, picture_book_key TEXT, audiobook_key TEXT, public_slug TEXT
  );
  INSERT INTO books (slug, title, status, cover_key, picture_book_key, audiobook_key, public_slug) VALUES
    ('published', 'Published Book', 'complete', 'p/cover.jpg', 'p/pic.pdf', 'p/audio.m4b', 'published-book'),
    ('audioonly', 'Audio Only', 'ready_for_qa', 'a/cover.jpg', NULL, 'a/audio.m4b', 'audio-only'),
    ('draft', 'Secret Draft', 'ready_for_qa', 'd/cover.jpg', 'd/pic.pdf', NULL, 'secret-draft');
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

const r1 = await resolveBookForPublicRoute(db, "secret-draft");
assert(r1?.book?.slug === "draft", "the resolver still finds drafts (internal surfaces need it)");
assert(isBookPubliclyListed(r1.book) === false, "but the draft is not listed: the page 404s");

// ---- Source pins -----------------------------------------------------------
const bookPageSrc = await read("../src/pages/books/[slug].astro");
assert(
  bookPageSrc.includes("if (!isBookPubliclyListed(book)) return Astro.redirect(\"/\", 404);"),
  "the public book page refuses unlisted books"
);
const esBookPageSrc = await read("../src/pages/es/books/[slug].astro");
assert(
  esBookPageSrc.includes("if (!isBookPubliclyListed(resolved.book)) return new Response(\"Not found\", { status: 404 });"),
  "the localized book page refuses unlisted books too"
);
const sampleSrc = await read("../src/pages/api/sample/[slug]/[n].ts");
assert(
  sampleSrc.includes("picture_book_key IS NOT NULL AND status = 'complete'"),
  "F8: sample pages require a published book"
);
const portalSrc = await read("../src/pages/api/club/portal.ts");
assert(
  portalSrc.includes("getClubSignupForUser"),
  "F18: the portal resolves the member row user-first (verified email only as fallback)"
);
assert(
  portalSrc.includes("emailVerified !== true"),
  "F18: the portal refuses unverified sessions before any Stripe call"
);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll public book status tests passed.");
