import { readPlanInventory } from '../../packages/core/src/book-revision';
// A book's page list from its chapter plans in storage
// (books/{slug}/plans/S{n}.json, the same plans the editor and
// the factory work from). The publish gate and the readiness
// page count pages from here. (This replaces a leftover where
// the publish route compared every book's approvals against a
// static import of one book's chapters; caught 2026-10-31 when
// CG asked how QC gets marked good and the approvals table
// turned out to be empty and the total was another book's.)

export interface BookPageRef {
  chapter: number;
  page: number;
}

export async function listBookPages(books: any, slug: string): Promise<BookPageRef[]> {
  return (await readPlanInventory(books, slug)).pages.map(({ chapter, page }) => ({ chapter, page }));
}

export async function countBookPages(books: any, slug: string): Promise<number> {
  return (await listBookPages(books, slug)).length;
}

export async function countApprovedPages(db: any, books: any, slug: string): Promise<number> {
  return countApprovedInventory(db, slug, await listBookPages(books, slug));
}

export async function countApprovedInventory(db: any, slug: string, pages: BookPageRef[]): Promise<number> {
  const expected = new Set(pages.map(p => `${p.chapter}:${p.page}`));
  const { results } = await db.prepare(
    "SELECT chapter_num, page_index FROM page_approvals WHERE book_slug = ? AND approved = 1"
  ).bind(slug).all();
  const approved = new Set<string>((results || []).map((r: any) => `${r.chapter_num}:${r.page_index}`));
  return [...expected].filter(key => approved.has(key)).length;
}
