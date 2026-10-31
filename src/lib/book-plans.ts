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
  const out: BookPageRef[] = [];
  for (let n = 1; n <= 30; n++) {
    let plan: any = null;
    try {
      const obj = await books.get(`books/${slug}/plans/S${n}.json`);
      if (!obj) break;
      plan = JSON.parse(await obj.text());
    } catch {
      break;
    }
    const pages = Array.isArray(plan?.pages) ? plan.pages : [];
    pages.forEach((_: unknown, i: number) => out.push({ chapter: n, page: i }));
  }
  return out;
}

export async function countBookPages(books: any, slug: string): Promise<number> {
  return (await listBookPages(books, slug)).length;
}

export async function countApprovedPages(db: any, books: any, slug: string): Promise<number> {
  // Only plan pages count. The QC view also records marks for the
  // assembled book's furniture (cover, contents, back cover, all
  // chapter 0); those greens must never inflate the publish gate.
  try {
    const planKeys = new Set((await listBookPages(books, slug)).map((p) => `${p.chapter}:${p.page}`));
    const { results } = await db
      .prepare("SELECT chapter_num, page_index FROM page_approvals WHERE book_slug = ? AND approved = 1")
      .bind(slug)
      .all();
    return (results || []).filter((r: any) => planKeys.has(`${r.chapter_num}:${r.page_index}`)).length;
  } catch {
    return 0;
  }
}
