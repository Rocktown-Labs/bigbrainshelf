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
