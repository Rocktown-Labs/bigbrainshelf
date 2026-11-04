// Asset versioning by snapshot. The factory historically overwrote
// every artifact in place at fixed R2 keys, so a redo destroyed the
// previous book (CG, 2026-10-23: redo everything, but KEEP the current
// versions, and give me a way to SEE versions).
//
// Before a build or regen overwrites anything, snapshotIfChanged copies
// the book's current artifacts to books/{slug}/archive/v{n}/ and appends
// an entry to books/{slug}/versions.json. The live keys never move, so
// every existing reader (editor, storefront, PDFs) keeps working; the
// archive is the version history. A fingerprint (file count + sizes)
// makes repeat snapshots of an unchanged book a no-op, which keeps
// idempotent workflow resumes from spamming empty versions.

export interface VersionEntry {
  version: number;
  at: number;
  source: string;
  fingerprint: string;
  files: number;
  bytes: number;
}

const SNAPSHOT_TOP_FILES = ["picture-book.pdf", "coloring-book.pdf", "editor_chapters.json", "bible.json", "book_info.json"];
const SNAPSHOT_PREFIXES = ["images/", "images-color/", "plans/"];

export function isSnapshotArtifact(slug: string, key: string): boolean {
  const rel = key.startsWith(`books/${slug}/`) ? key.slice(`books/${slug}/`.length) : null;
  if (!rel) return false;
  if (rel.startsWith("archive/") || rel === "versions.json") return false;
  return SNAPSHOT_TOP_FILES.includes(rel) || SNAPSHOT_PREFIXES.some((p) => rel.startsWith(p));
}

export function fingerprintOf(items: { key: string; size: number }[]): string {
  const s = items.map((i) => `${i.key}:${i.size}`).sort().join("|");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${items.length}f-${(h >>> 0).toString(16)}`;
}

export async function snapshotIfChanged(
  BOOKS: R2Bucket,
  slug: string,
  source: string
): Promise<VersionEntry | null> {
  // List with sizes (r2ListAll in bookbuild returns keys only).
  const items: { key: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const r = await BOOKS.list({ prefix: `books/${slug}/`, cursor });
    for (const o of r.objects ?? []) {
      if (isSnapshotArtifact(slug, o.key)) items.push({ key: o.key, size: o.size ?? 0 });
    }
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  if (!items.length) return null;

  const fp = fingerprintOf(items);
  const manifestKey = `books/${slug}/versions.json`;
  let manifest: { slug: string; versions: VersionEntry[] } = { slug, versions: [] };
  try {
    const o = await BOOKS.get(manifestKey);
    if (o) manifest = JSON.parse(await o.text());
  } catch { /* first snapshot: fresh manifest */ }
  const last = manifest.versions[manifest.versions.length - 1];
  if (last && last.fingerprint === fp) return null;

  const version = (last?.version ?? 0) + 1;
  let bytes = 0;
  for (const item of items) {
    const o = await BOOKS.get(item.key);
    if (!o) continue;
    const data = new Uint8Array(await o.arrayBuffer());
    bytes += data.length;
    const rel = item.key.slice(`books/${slug}/`.length);
    await BOOKS.put(`books/${slug}/archive/v${version}/${rel}`, data, {
      httpMetadata: { contentType: o.httpMetadata?.contentType ?? "application/octet-stream" },
    });
  }
  const entry: VersionEntry = {
    version,
    at: Math.floor(Date.now() / 1000),
    source,
    fingerprint: fp,
    files: items.length,
    bytes,
  };
  manifest.versions.push(entry);
  await BOOKS.put(manifestKey, JSON.stringify(manifest, null, 1), {
    httpMetadata: { contentType: "application/json" },
  });
  console.log(`snapshot: ${slug} v${version} archived (${items.length} files, ${bytes} bytes, via ${source})`);
  return entry;
}
