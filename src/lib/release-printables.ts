import type { RevisionPrintable } from '../../packages/core/src/book-revision';

/** Read only. Do not seed or create the registry while capturing approval evidence. */
export async function readRevisionPrintables(db: any, slug: string): Promise<RevisionPrintable[]> {
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'printables'").first();
  if (!exists) return [];
  const { results } = await db.prepare('SELECT * FROM printables WHERE slug = ? ORDER BY kind').bind(slug).all();
  return (results ?? []).map((row: any) => {
    const p = { kind: String(row.kind), podPackageId: String(row.pod_package_id ?? ''), interiorPages: Number(row.interior_pages),
      interiorKey: String(row.interior_key ?? ''), coverKey: String(row.cover_key ?? ''), validationStatus: row.validation_status ? String(row.validation_status) : null };
    if (!['story', 'coloring'].includes(p.kind) || !p.podPackageId || !Number.isInteger(p.interiorPages) || p.interiorPages < 1 ||
      [p.interiorKey, p.coverKey].some(k => !k.startsWith(`books/${slug}/print/`) || k.includes('..') || k.includes('/personalized/')))
      throw new Error('Registered print master contract is invalid');
    return p;
  });
}
