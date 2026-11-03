// Public book slugs: the title-based URL layer over the internal
// book slugs.
//
// The internal slug (books.slug) is the system key everywhere: D1
// foreign keys, R2 paths, factory payloads, admin routes, orders,
// entitlements, downloads. It is also source-derived (mastery,
// richdadpoordad, docker), and CG ruled 2026-10-28 that public links
// must stop referencing the source material. So public URLs carry a
// second slug, books.public_slug, slugified from the book's TITLE:
//
//   mastery         -> mira-the-heron-and-the-still-water
//   richdadpoordad  -> penny-the-squirrel-and-the-acorn-orchard
//
// Resolution rules:
//   - A public route param is matched against public_slug FIRST,
//     then against the internal slug.
//   - An internal-slug hit whose book owns a different public slug is
//     stale: the public routes 301 to the canonical public URL.
//   - A book with no public_slug yet (not yet published) is its own
//     public identity: publicSlugFor falls back to the internal slug.
//   - Minting never produces a value that collides with an existing
//     public_slug or with ANOTHER book's internal slug (which would
//     shadow that book's own resolution); collisions get -2, -3, ...
//
// The column is ensured at runtime with the same pragma pattern as
// books.published_at (releases.ts) and shippo's order columns;
// migration.sql carries the same statements as the schema record.

import type { DBLike } from "./orders";
import { ensureOnce } from "./schema-cache";

/** "Mira the Heron and the Still Water" -> "mira-the-heron-and-the-still-water". */
export function slugifyTitle(title: string): string {
  return String(title || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The slug a book wears in public URLs: its public_slug, or the
 *  internal slug while it has none. */
export function publicSlugFor(book: { slug: string; public_slug?: string | null }): string {
  const p = String(book?.public_slug || "").trim();
  return p || String(book?.slug || "");
}

/** Canonical public book page path for a book row. */
export function bookHref(book: { slug: string; public_slug?: string | null }): string {
  return `/books/${publicSlugFor(book)}`;
}

/** Canonical public reader path for a book row. */
export function readHref(book: { slug: string; public_slug?: string | null }): string {
  return `/read/${publicSlugFor(book)}`;
}

export async function ensurePublicSlugColumn(db: DBLike): Promise<void> {
  await ensureOnce(db, "books.public_slug", async () => {
    const { results } = await db
      .prepare("SELECT name FROM pragma_table_info('books')")
      .bind()
      .all();
    const have = new Set((results || []).map((r: any) => String(r.name)));
    if (!have.has("public_slug")) {
      await db.prepare("ALTER TABLE books ADD COLUMN public_slug TEXT").bind().run();
    }
  });
}

/**
 * Retired public slugs (renames): when a book's public slug changes,
 * the old slug is recorded here so old links keep working. An alias
 * resolves to the book and reports via="internal", so every public
 * route 301s to the book's current canonical public URL with its
 * existing redirect behavior. Aliases are consulted only after live
 * public slugs, so a slug a book later legitimately owns always wins
 * over a stale alias.
 */
export async function ensureSlugAliasesTable(db: DBLike): Promise<void> {
  await ensureOnce(db, "book_slug_aliases", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS book_slug_aliases (
           alias TEXT PRIMARY KEY,
           slug TEXT NOT NULL,
           created_at INTEGER
         )`
      )
      .bind()
      .run();
  });
}

// The known rename map, seeded idempotently wherever aliases are
// consulted. Two kinds of retirement live here:
//  - Retired PUBLIC slugs from the character renames (the fern /
//    basil / wally title slugs). The 2026-11-02 rename pass wrote
//    those rows to production by hand; seeding them here makes any
//    database converge to the same map instead of depending on rows
//    a person remembered to insert.
//  - The retired INTERNAL slug "mastery". The Mira slug migration
//    renamed the books row itself, so no books row answers to
//    "mastery" anymore, while pre-migration orders still carry it in
//    their items and book_slugs. Without this alias those orders fall
//    through slug resolution and render as the neutral "Big Brain
//    Shelf book" on every admin surface (CG's report, 2026-11-03).
//    The alias targets the book's CURRENT internal slug (for Mira
//    the internal and public slugs are the same string).
// Audited against production 2026-11-03: the distinct slugs present
// in orders.items, orders.book_slugs, and the four club_cycle_boxes
// slug columns are exactly the nine live internal slugs plus
// "mastery"; "mastery" is the only unresolvable one.
export const RETIRED_SLUG_ALIASES: Record<string, string> = {
  mastery: "mira-the-heron-and-the-still-water",
  "fern-the-fox-and-the-clever-trails": "algorithms",
  "basil-the-beaver-and-the-pattern-book": "designpatterns",
  "wally-the-whale-and-the-great-harbor": "docker",
};

/**
 * Seed the known rename aliases (INSERT OR IGNORE, so an existing
 * row always wins). Runs once per database through ensureOnce, on
 * the read paths that consult the alias table, so the fix is in the
 * code and never a hand-edit of production data.
 */
export async function ensureRenameAliases(db: DBLike): Promise<void> {
  await ensureSlugAliasesTable(db);
  await ensureOnce(db, "book_slug_aliases.rename_seed", async () => {
    const ts = Math.floor(Date.now() / 1000);
    for (const [alias, slug] of Object.entries(RETIRED_SLUG_ALIASES)) {
      await db
        .prepare("INSERT OR IGNORE INTO book_slug_aliases (alias, slug, created_at) VALUES (?, ?, ?)")
        .bind(alias, slug, ts)
        .run();
    }
  });
}

export interface ResolvedBook {
  book: any;
  /** "public" when the param matched public_slug (or the book's
   *  public identity IS the param); "internal" when it matched the
   *  internal slug and the canonical public slug differs. */
  via: "public" | "internal";
}

/**
 * Resolve a public route param to a book. Public slug wins; an
 * internal slug resolves too, flagged via="internal" so the caller
 * can 301 to the canonical public URL. A book whose public_slug is
 * empty (or equal to its slug) resolves its internal slug as
 * via="public": there is nothing to redirect to.
 */
export async function resolveBookForPublicRoute(
  db: DBLike,
  param: string
): Promise<ResolvedBook | null> {
  await ensurePublicSlugColumn(db);
  const p = String(param || "").trim().toLowerCase();
  if (!p) return null;
  const byPublic: any = await db
    .prepare("SELECT * FROM books WHERE public_slug = ?")
    .bind(p)
    .first();
  if (byPublic) return { book: byPublic, via: "public" };
  await ensureRenameAliases(db);
  const alias: any = await db
    .prepare("SELECT slug FROM book_slug_aliases WHERE alias = ?")
    .bind(p)
    .first();
  if (alias) {
    const aliased: any = await db
      .prepare("SELECT * FROM books WHERE slug = ?")
      .bind(String(alias.slug))
      .first();
    if (aliased) return { book: aliased, via: "internal" };
  }
  const byInternal: any = await db
    .prepare("SELECT * FROM books WHERE slug = ?")
    .bind(p)
    .first();
  if (!byInternal) return null;
  return { book: byInternal, via: publicSlugFor(byInternal) === p ? "public" : "internal" };
}

/**
 * Map any slug form (internal or public) to the internal slug, or
 * null when no book answers to it. The boundary helper for surfaces
 * that must key on the internal slug (sample route, checkout).
 */
export async function resolveInternalSlug(db: DBLike, anySlug: string): Promise<string | null> {
  const r = await resolveBookForPublicRoute(db, anySlug);
  return r ? String(r.book.slug) : null;
}

async function publicSlugTaken(db: DBLike, candidate: string, selfSlug: string): Promise<boolean> {
  const byPublic: any = await db
    .prepare("SELECT slug FROM books WHERE public_slug = ? AND slug != ?")
    .bind(candidate, selfSlug)
    .first();
  if (byPublic) return true;
  // A public slug equal to ANOTHER book's internal slug would shadow
  // that book at resolution time (public matches win).
  if (candidate !== selfSlug) {
    const byInternal: any = await db
      .prepare("SELECT slug FROM books WHERE slug = ?")
      .bind(candidate)
      .first();
    if (byInternal) return true;
  }
  return false;
}

/** First free public slug for a base value: base, base-2, base-3... */
export async function uniquePublicSlug(db: DBLike, base: string, selfSlug: string): Promise<string> {
  let candidate = base;
  let n = 2;
  while (await publicSlugTaken(db, candidate, selfSlug)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

/** Derive, uniquify, and store a book's public slug from its title. */
export async function mintPublicSlug(
  db: DBLike,
  book: { slug: string; title?: string | null }
): Promise<string> {
  await ensurePublicSlugColumn(db);
  const base = slugifyTitle(String(book.title || "")) || String(book.slug);
  const candidate = await uniquePublicSlug(db, base, String(book.slug));
  await db
    .prepare("UPDATE books SET public_slug = ? WHERE slug = ?")
    .bind(candidate, String(book.slug))
    .run();
  return candidate;
}

/**
 * The publish-path guarantee: a book leaving the editor always owns
 * a public slug. Returns the book's public slug (existing or freshly
 * minted), or null when the book does not exist.
 */
export async function ensureBookPublicSlug(db: DBLike, internalSlug: string): Promise<string | null> {
  await ensurePublicSlugColumn(db);
  const book: any = await db
    .prepare("SELECT slug, title, public_slug FROM books WHERE slug = ?")
    .bind(internalSlug)
    .first();
  if (!book) return null;
  if (book.public_slug) return String(book.public_slug);
  return mintPublicSlug(db, book);
}

/**
 * Backfill: mint a public slug for every book that lacks one. Used
 * by the one-time rollout (and safe to re-run: books that already
 * have a public slug are untouched). Returns what was assigned.
 */
export async function backfillPublicSlugs(
  db: DBLike
): Promise<{ slug: string; public_slug: string }[]> {
  await ensurePublicSlugColumn(db);
  const { results } = await db
    .prepare("SELECT slug, title, public_slug FROM books WHERE public_slug IS NULL OR public_slug = ''")
    .bind()
    .all();
  const out: { slug: string; public_slug: string }[] = [];
  for (const b of (results || []) as any[]) {
    out.push({ slug: String(b.slug), public_slug: await mintPublicSlug(db, b) });
  }
  return out;
}
