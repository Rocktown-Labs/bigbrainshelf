import { openReleaseArtifact, readArtifactRelease, releaseArtifact, type ArtifactRelease } from './artifact-releases';

function printableFromRelease(release: ArtifactRelease, kind: string) {
  const recipe = release.sourceManifest.printables?.find(p => p.kind === kind);
  if (!recipe) throw new Error('No approved print master exists in this release');
  const interior = releaseArtifact(release, `print:${kind}:interior`), cover = releaseArtifact(release, `print:${kind}:cover`);
  if (interior.sourceKey !== recipe.interiorKey || cover.sourceKey !== recipe.coverKey) throw new Error('Print recipe does not match its masters');
  return { ...recipe, slug: release.slug, releaseId: release.id, interiorKey: interior.key, coverKey: cover.key, interior, cover };
}

async function verifyMasters(books: any, p: ReturnType<typeof printableFromRelease>) {
  // Check both even for personalized items; do not download/buffer the PDFs.
  const [interior, cover] = await Promise.all([openReleaseArtifact(books, p.interior), openReleaseArtifact(books, p.cover)]);
  await interior.body.cancel(); await cover.body.cancel();
}

export async function releasedPrintable(db: any, books: any, slug: string, kind: string) {
  const p = printableFromRelease(await readArtifactRelease(db, books, slug), kind);
  await verifyMasters(books, p);
  return p;
}

/** Pin an order item to its original release even when a later release is promoted. */
export async function recordPrintReleaseItem(db: any, itemId: string, printable: Awaited<ReturnType<typeof releasedPrintable>>, personalizedKey: string | null) {
  if (personalizedKey && personalizedKey !== `books/${printable.slug}/print/personalized/${itemId}.pdf`) throw new Error('Invalid print derivative key');
  await db.prepare(`INSERT INTO print_release_items (item_id, book_slug, release_id, kind, interior_key, cover_key, personalized_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(itemId, printable.slug, printable.releaseId, printable.kind, printable.interiorKey, printable.coverKey, personalizedKey, Date.now()).run();
}

export async function verifyPrintReleaseItem(db: any, books: any, item: {
  id: string; slug: string; kind: string; interiorKey: string | null; coverKey: string | null;
  podPackageId: string | null; interiorPages: number | null; personalized: boolean;
}) {
  const binding = await db.prepare('SELECT * FROM print_release_items WHERE item_id = ?').bind(item.id).first();
  if (!binding || binding.book_slug !== item.slug || binding.kind !== item.kind) throw new Error('Print item has no frozen release lineage');
  const p = printableFromRelease(await readArtifactRelease(db, books, item.slug, binding.release_id), item.kind);
  const derivative = binding.personalized_key;
  if (binding.interior_key !== p.interiorKey || binding.cover_key !== p.coverKey || item.coverKey !== p.coverKey ||
    item.podPackageId !== p.podPackageId || item.interiorPages !== p.interiorPages + (derivative ? 1 : 0) ||
    item.personalized !== !!derivative || item.interiorKey !== (derivative || p.interiorKey) ||
    (derivative && derivative !== `books/${item.slug}/print/personalized/${item.id}.pdf`)) throw new Error('Print item differs from its frozen release contract');
  // Verify masters even for personalized items: derivatives remain mutable by design,
  // but cannot be silently substituted for another order's or release's copy.
  await verifyMasters(books, p);
  return p;
}

export async function openPrintReleaseFile(db: any, books: any, resolved: { r2Key: string; jobId: string | null; jobItemId: string | null }) {
  if (!resolved.jobId || !resolved.jobItemId) throw new Error('Print token has no item lineage');
  const row = await db.prepare('SELECT * FROM print_job_items WHERE id = ? AND job_id = ?').bind(resolved.jobItemId, resolved.jobId).first();
  if (!row) throw new Error('Print token item is unavailable');
  const item = { id: row.id, slug: row.slug, kind: row.kind, interiorKey: row.interior_key, coverKey: row.cover_key,
    podPackageId: row.pod_package_id, interiorPages: Number(row.interior_pages), personalized: Number(row.personalized) === 1 };
  const p = await verifyPrintReleaseItem(db, books, item);
  if (resolved.r2Key === p.coverKey) return openReleaseArtifact(books, p.cover);
  if (resolved.r2Key !== item.interiorKey) throw new Error('Print token does not name this item');
  if (!item.personalized) return openReleaseArtifact(books, p.interior);
  const derivative = await books.get(item.interiorKey);
  if (!derivative?.body) throw new Error('Personalized print derivative is unavailable');
  return derivative;
}
