// The catalog: single source of truth for book facts (CG directive,
// 2026-11-02; spec in the GTM workspace, catalog-json-spec.md).
//
// src/data/catalog.json carries, per book: the internal slug (id,
// never changes), the public title slug (changes with renames; the
// hub keeps redirects from retired slugs in book_slug_aliases), the
// title, shelf, status, one-liner, the cast in trio order (slot 1 is
// the lead and fronts promos), per-character nameCheck verdicts from
// the originality guard, the append-only nameHistory, and
// assetFlags: what a data edit cannot fix (printed covers, PDF text,
// recorded audio). Clubs and prices live there too; the prices block
// is a MIRROR of offers.ts, which stays authoritative until a later
// wiring pass.
//
// Consumers read facts from here instead of quoting their own
// copies: cast order (cast-overviews), demand sample titles
// (braintrust), merch notes, editor fallback titles, family avatar
// names, cast chat defaults, and SEO alt text. Long-form prose
// (character bios in cast-overviews, book descriptions in D1) stays
// where it lives; a rename updates the catalog first and the prose
// keys in the same pass.

import catalogData from "../data/catalog.json";

export interface CatalogNameCheck {
  date: string;
  verdict: string;
  report: string;
}

export interface CatalogCastMember {
  name: string;
  species: string;
  role: string;
  nameCheck?: CatalogNameCheck;
}

export interface CatalogNameChange {
  from: string;
  to: string;
  date: string;
  reason: string;
}

export interface CatalogBook {
  id: string;
  titleSlug: string;
  title: string;
  shelf: string;
  status: string;
  oneLine: string;
  cast: CatalogCastMember[];
  nameHistory: CatalogNameChange[];
  assets: { cover: string | null; castSheet: string | null };
  assetFlags: string[];
}

export interface Catalog {
  version: number;
  updated: string;
  books: CatalogBook[];
  clubs: { id: string; name: string; monthly?: number; quarterly?: number; annual: number }[];
  prices: Record<string, number>;
  pricesNote: string;
}

export const CATALOG = catalogData as unknown as Catalog;

const BY_ID = new Map(CATALOG.books.map((b) => [b.id, b]));

/** The catalog row for an internal slug, or null. */
export function catalogBook(id: string): CatalogBook | null {
  return BY_ID.get(id) ?? null;
}

/** The book's current public title, or "" for an unknown slug. */
export function catalogTitle(id: string): string {
  return BY_ID.get(id)?.title ?? "";
}

/** The book's current public title slug, or "" for an unknown slug. */
export function catalogTitleSlug(id: string): string {
  return BY_ID.get(id)?.titleSlug ?? "";
}

/** Cast names in catalog (trio) order for a book. */
export function catalogCastNames(id: string): string[] {
  return (BY_ID.get(id)?.cast ?? []).map((c) => c.name);
}

/** The lead (slot 1) cast member for a book, or null. */
export function catalogLead(id: string): CatalogCastMember | null {
  return BY_ID.get(id)?.cast?.[0] ?? null;
}

/** The lead character's name for a book, or "" for an unknown slug. */
export function catalogLeadName(id: string): string {
  return catalogLead(id)?.name ?? "";
}

/**
 * The lead's display name as the titles wear it: "Fenix the Fox".
 * Derived from the title's first segment so it can never drift from
 * the title itself.
 */
export function catalogLeadDisplayName(id: string): string {
  const t = catalogTitle(id);
  return t ? t.split(" and ")[0] : "";
}

// ---------------------------------------------------------------------------
// Book codes (CG, admin redesign S4, 2026-11-03): the short packing
// code an operator reads off a box line, e.g. "MTH-still-water" for
// "Mira the Heron and the Still Water". Shape: the initials of the
// title's first three words ("Mira The Heron" -> MTH), a hyphen, then
// the distinctive title words after "and the" ("Still Water" ->
// "still-water"). Series-proof by construction: a second book for the
// same lead keeps the initials and changes the title words. Derived
// from the TITLE, never the internal slug, so a renamed or re-slugged
// book keeps the code its printed title earns.
export function bookCodeForTitle(title: string): string | null {
  const words = String(title || "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return null;
  const initials = words
    .slice(0, 3)
    .map((w) => (w[0] || "").toUpperCase())
    .join("");
  if (!initials) return null;
  const andIdx = words.findIndex((w) => w.toLowerCase() === "and");
  let tail = andIdx >= 0 ? words.slice(andIdx + 1) : words.slice(3);
  if (tail.length && tail[0].toLowerCase() === "the") tail = tail.slice(1);
  const tailSlug = tail
    .join("-")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return tailSlug ? `${initials}-${tailSlug}` : initials;
}

const BY_ANY_SLUG = new Map<string, CatalogBook>();
for (const b of CATALOG.books) {
  BY_ANY_SLUG.set(b.id, b);
  if (b.titleSlug && !BY_ANY_SLUG.has(b.titleSlug)) BY_ANY_SLUG.set(b.titleSlug, b);
}

/** The packing code for a book keyed by internal slug or title slug. */
export function catalogBookCode(idOrTitleSlug: string): string | null {
  const b = BY_ANY_SLUG.get(String(idOrTitleSlug || ""));
  return b ? bookCodeForTitle(b.title) : null;
}
