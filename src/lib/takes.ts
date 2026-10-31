// Page takes: per-page version flipping over the factory's archive
// snapshots (Logic Pro comping style). The factory snapshots a book's
// artifacts to books/{slug}/archive/v{n}/ before any build/regen/repair
// overwrites them, and lists them in books/{slug}/versions.json. The
// editor's Takes UI reads that archive: a page's takes are the live page
// plus every snapshot that contains the page's file.
//
// SAFETY (2026-10-28 fix): applying a take used to copy archived bytes
// straight over the live key. The archive only holds pre-overwrite
// states from factory runs, so a book's CURRENT live art usually exists
// nowhere else — one Apply click destroyed it permanently. Now every
// apply FIRST snapshots the exact live files it is about to overwrite
// into a NEW archive version (source "takes", same manifest contract
// as the factory's versioning.ts) and verifies the snapshot before any
// live byte is touched. If the snapshot fails, the apply aborts with
// zero overwrites. The pre-apply state is itself a selectable take,
// which is what makes Apply undoable.
//
// Applying a line take also applies the version's color twin
// (images-color/ counterpart) when that snapshot has one. When it does
// not, the pick records a plain-language note: the color page now
// predates the line art, and the next colorize will redo that page (a
// paid generation) and discard the current color art.
//
// This module is env-agnostic: it takes the BOOKS R2 binding and the DB
// handle as plain arguments so tests can drive it with fakes.

export interface BookVersion {
  version: number;
  at: number; // unix seconds
  source: string;
  files: number;
  bytes: number;
}

export interface PageTake {
  version: number;
  at: number;
  source: string;
  key: string; // archive key holding this page's file in that version
  size: number;
}

// The stale-twin note, shared verbatim between the API result and the
// editor UI so the cost is stated the same way everywhere: plain words,
// no alarm formatting.
export const STALE_TWIN_NOTE =
  "This version has no color copy of this page, so the color page now predates the line art. " +
  "That means the next colorize will redo this page (a paid generation) and discard the current color art. " +
  "Applying this take means choosing this line art over keeping the current color page.";

// Defensive parse of versions.json. Anything malformed yields an empty
// list (or skips the bad entry) instead of throwing: a missing or odd
// manifest must never break the editor.
export function parseVersionsManifest(raw: unknown): BookVersion[] {
  let doc: any = raw;
  if (typeof raw === "string") {
    try { doc = JSON.parse(raw); } catch { return []; }
  }
  const list = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.versions) ? doc.versions : null);
  if (!list) return [];
  const out: BookVersion[] = [];
  for (const v of list) {
    if (!v || typeof v !== "object") continue;
    const version = Number((v as any).version);
    if (!Number.isInteger(version) || version < 1) continue;
    out.push({
      version,
      at: Number((v as any).at) || 0,
      source: typeof (v as any).source === "string" ? (v as any).source : "unknown",
      files: Number((v as any).files) || 0,
      bytes: Number((v as any).bytes) || 0,
    });
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}

// The standard live key for a page's art, matching what the factory
// writes and what editor_chapters.json points at.
export function livePageKey(slug: string, chapterNum: number, pageIndex: number): string {
  return `books/${slug}/images/S${chapterNum}-page-${pageIndex}.jpg`;
}

// The live color-twin key for a line page key: the factory's colorize
// writes books/{slug}/images-color/<same file name>. A legacy live key
// outside books/{slug}/ still has its twin at the standard location.
// Returns null when the key shape has no twin concept.
export function colorTwinKey(liveKey: string, slug: string): string | null {
  const linePrefix = `books/${slug}/images/`;
  if (liveKey.startsWith(linePrefix)) {
    return `books/${slug}/images-color/` + liveKey.slice(linePrefix.length);
  }
  const base = liveKey.split("/").pop() || "";
  if (/^S\d+-page-\d+\.jpg$/.test(base)) {
    return `books/${slug}/images-color/${base}`;
  }
  return null;
}

// Extract the R2 key from a full public URL (the shape editor_chapters
// stores in page.image). Returns null for anything unrecognized.
export function keyFromImageUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = /^https?:\/\/[^/]+\/(.+)$/.exec(url.trim());
  if (!m) return null;
  const key = m[1].split(/[?#]/)[0];
  if (!key || key.includes("..")) return null;
  return key;
}

// Candidate archive keys for a live page key, best first. Snapshots
// mirror the live layout under books/{slug}/archive/v{n}/, so the
// primary candidate swaps the books/{slug}/ prefix. A legacy live key
// outside books/{slug}/ (docker's old docker/S#-page-#.jpg layout) maps
// to the standard images/ location inside the snapshot instead.
export function archiveKeyCandidates(liveKey: string, slug: string, version: number): string[] {
  const prefix = `books/${slug}/`;
  const archivePrefix = `books/${slug}/archive/v${version}/`;
  if (liveKey.startsWith(prefix) && !liveKey.startsWith(archivePrefix)) {
    return [archivePrefix + liveKey.slice(prefix.length)];
  }
  const base = liveKey.split("/").pop() || "";
  if (/^S\d+-page-\d+\.jpg$/.test(base)) {
    return [`${archivePrefix}images/${base}`];
  }
  return [];
}

type BooksLike = {
  get(key: string): Promise<any>;
  head(key: string): Promise<any>;
  put(key: string, value: any, opts?: any): Promise<any>;
};

export async function getBookVersions(books: BooksLike, slug: string): Promise<BookVersion[]> {
  try {
    const obj = await books.get(`books/${slug}/versions.json`);
    if (!obj) return [];
    return parseVersionsManifest(await obj.text());
  } catch {
    return [];
  }
}

// Resolve the live R2 key for one editor page: prefer the exact URL the
// editor itself displays (from editor_chapters.json), fall back to the
// standard key pattern.
export async function resolveLivePageKey(
  books: BooksLike, slug: string, chapterNum: number, pageIndex: number,
): Promise<string> {
  try {
    const obj = await books.get(`books/${slug}/editor_chapters.json`);
    if (obj) {
      const chapters = JSON.parse(await obj.text());
      if (Array.isArray(chapters)) {
        const ch = chapters.find((c: any) => Number(c?.num) === chapterNum);
        const page = ch && Array.isArray(ch.pages) ? ch.pages[pageIndex] : null;
        const key = page ? keyFromImageUrl(page.image) : null;
        if (key) return key;
      }
    }
  } catch { /* fall through to the standard pattern */ }
  return livePageKey(slug, chapterNum, pageIndex);
}

export async function listPageTakes(
  books: BooksLike, slug: string, chapterNum: number, pageIndex: number,
): Promise<{ liveKey: string; liveSize: number | null; takes: PageTake[] }> {
  const liveKey = await resolveLivePageKey(books, slug, chapterNum, pageIndex);
  const liveHead = await books.head(liveKey).catch(() => null);
  const versions = await getBookVersions(books, slug);
  const takes: PageTake[] = [];
  for (const v of versions) {
    for (const key of archiveKeyCandidates(liveKey, slug, v.version)) {
      const head = await books.head(key).catch(() => null);
      if (head) {
        takes.push({ version: v.version, at: v.at, source: v.source, key, size: Number(head.size) || 0 });
        break;
      }
    }
  }
  return { liveKey, liveSize: liveHead ? Number(liveHead.size) || 0 : null, takes };
}

// Copy one R2 object over another key, preserving its content type.
// Returns the copied byte size, or null when the source does not exist.
export async function copyObject(books: BooksLike, fromKey: string, toKey: string): Promise<number | null> {
  const obj = await books.get(fromKey);
  if (!obj) return null;
  const contentType = (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg";
  const buf = await obj.arrayBuffer();
  await books.put(toKey, buf, { httpMetadata: { contentType } });
  return buf.byteLength;
}

/* ---------- snapshot before apply ---------- */

// Identical fingerprint to the factory's versioning.ts, so "takes"
// entries are indistinguishable in kind from factory entries.
export function fingerprintOf(items: { key: string; size: number }[]): string {
  const s = items.map((i) => `${i.key}:${i.size}`).sort().join("|");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${items.length}f-${(h >>> 0).toString(16)}`;
}

// Read versions.json as a raw document so appending a new entry
// preserves every existing entry byte-for-byte (fingerprints included).
// Defensive: an unparseable manifest starts fresh rather than throwing.
async function readRawManifest(books: BooksLike, slug: string): Promise<{ slug: string; versions: any[] }> {
  try {
    const obj = await books.get(`books/${slug}/versions.json`);
    if (obj) {
      const doc = JSON.parse(await obj.text());
      if (doc && Array.isArray(doc.versions)) return { slug, versions: doc.versions };
      if (Array.isArray(doc)) return { slug, versions: doc };
    }
  } catch { /* fall through to a fresh manifest */ }
  return { slug, versions: [] };
}

export interface SnapshotResult {
  version: number; // the new archive version holding the pre-apply state
  files: number;
  bytes: number;
  keys: string[]; // archive keys written
}

// Copy the current live bytes of exactly `liveKeys` into a new archive
// version and append it to versions.json (source "takes", factory
// manifest contract). Every write is verified: each archived copy is
// head-checked for size, and versions.json is re-read to confirm the
// new entry is listed. ANY failure throws — callers must treat a throw
// as "snapshot not proven, abort the apply, overwrite nothing".
// Returns null when none of the keys exist live (nothing to preserve).
export async function snapshotLiveFiles(
  books: BooksLike, slug: string, liveKeys: string[], source = "takes",
): Promise<SnapshotResult | null> {
  const uniq = [...new Set(liveKeys)];
  const present: { key: string; size: number }[] = [];
  for (const key of uniq) {
    const head = await books.head(key).catch(() => null);
    if (head) present.push({ key, size: Number(head.size) || 0 });
  }
  if (!present.length) return null;

  const manifest = await readRawManifest(books, slug);
  const parsed = parseVersionsManifest({ versions: manifest.versions });
  const newVersion = (parsed.length ? parsed[parsed.length - 1].version : 0) + 1;

  let bytes = 0;
  const written: string[] = [];
  for (const item of present) {
    const dest = archiveKeyCandidates(item.key, slug, newVersion)[0];
    if (!dest) throw new Error(`snapshot failed: no archive location for ${item.key}`);
    const copied = await copyObject(books, item.key, dest);
    if (copied === null) throw new Error(`snapshot failed: could not read live file ${item.key}`);
    bytes += copied;
    written.push(dest);
  }
  // Verify every archived copy landed with the live file's size.
  for (let i = 0; i < present.length; i++) {
    const head = await books.head(written[i]).catch(() => null);
    if (!head || Number(head.size) !== present[i].size) {
      throw new Error(`snapshot verification failed for ${written[i]}`);
    }
  }
  const entry = {
    version: newVersion,
    at: Math.floor(Date.now() / 1000),
    source,
    fingerprint: fingerprintOf(present),
    files: present.length,
    bytes,
  };
  manifest.versions.push(entry);
  await books.put(`books/${slug}/versions.json`, JSON.stringify(manifest, null, 1), {
    httpMetadata: { contentType: "application/json" },
  });
  // Verify the manifest now lists the new version before trusting it.
  const check = await getBookVersions(books, slug);
  if (!check.some((v) => v.version === newVersion && v.source === source)) {
    throw new Error(`snapshot verification failed: versions.json does not list v${newVersion}`);
  }
  return { version: newVersion, files: present.length, bytes, keys: written };
}

/* ---------- picks ---------- */

const CLEAR_APPROVAL_SQL =
  `INSERT INTO page_approvals (book_slug, chapter_num, page_index, approved, approved_at)
   VALUES (?, ?, ?, 0, NULL)
   ON CONFLICT (book_slug, chapter_num, page_index) DO UPDATE SET approved=0, approved_at=NULL`;

const RECORD_PICK_SQL =
  `INSERT INTO page_takes (book_slug, chapter_num, page_index, version, applied_at)
   VALUES (?, ?, ?, ?, ?)`;

const RECORD_PICK_TWIN_SQL =
  `INSERT INTO page_takes (book_slug, chapter_num, page_index, version, applied_at, twin_applied, twin_note)
   VALUES (?, ?, ?, ?, ?, ?, ?)`;

// Record a pick, including twin handling. Falls back to the plain
// insert when the twin columns are not present yet (older database),
// so recording a pick never fails an otherwise-complete apply.
async function recordPick(
  db: any, slug: string, chapterNum: number, pageIndex: number,
  version: number, appliedAt: string, twinApplied: boolean, twinNote: string | null,
): Promise<void> {
  try {
    await db.prepare(RECORD_PICK_TWIN_SQL)
      .bind(slug, chapterNum, pageIndex, version, appliedAt, twinApplied ? 1 : 0, twinNote).run();
  } catch {
    await db.prepare(RECORD_PICK_SQL).bind(slug, chapterNum, pageIndex, version, appliedAt).run();
  }
}

async function firstExistingKey(books: BooksLike, candidates: string[]): Promise<string | null> {
  for (const key of candidates) {
    const head = await books.head(key).catch(() => null);
    if (head) return key;
  }
  return null;
}

export interface ApplyResult {
  ok: true;
  liveKey: string;
  size: number;
  twinApplied: boolean; // the version's color twin was applied with the line take
  twinNote: string | null; // set when the version has no color copy (stale twin)
  snapshotVersion: number | null; // archive version holding the pre-apply state
}

// Apply one archived take to one page. Order is the safety contract:
// resolve the take and its twin, snapshot the live files about to be
// overwritten (throws -> abort, zero overwrites), then copy, clear the
// page's approval exactly like redo-image does, and record the pick.
// Returns null when the page has no copy in that version (nothing is
// snapshotted or copied in that case).
export async function applyPageTake(
  books: BooksLike, db: any, slug: string,
  chapterNum: number, pageIndex: number, version: number,
): Promise<ApplyResult | null> {
  const liveKey = await resolveLivePageKey(books, slug, chapterNum, pageIndex);
  const takeKey = await firstExistingKey(books, archiveKeyCandidates(liveKey, slug, version));
  if (!takeKey) return null;

  const twinLiveKey = colorTwinKey(liveKey, slug);
  const twinTakeKey = twinLiveKey
    ? await firstExistingKey(books, archiveKeyCandidates(twinLiveKey, slug, version))
    : null;

  // Snapshot exactly what is about to be overwritten, BEFORE touching it.
  const overwriteSet = [liveKey];
  if (twinTakeKey && twinLiveKey) overwriteSet.push(twinLiveKey);
  const snap = await snapshotLiveFiles(books, slug, overwriteSet, "takes");

  const copied = await copyObject(books, takeKey, liveKey);
  if (copied === null) throw new Error("apply failed: the archived take disappeared during apply");
  let twinApplied = false;
  if (twinTakeKey && twinLiveKey) {
    const tc = await copyObject(books, twinTakeKey, twinLiveKey);
    if (tc === null) throw new Error("apply failed: the archived color twin disappeared during apply");
    twinApplied = true;
  }
  const twinNote = twinLiveKey && !twinApplied ? STALE_TWIN_NOTE : null;

  await db.prepare(CLEAR_APPROVAL_SQL).bind(slug, chapterNum, pageIndex).run();
  await recordPick(db, slug, chapterNum, pageIndex, version, new Date().toISOString(), twinApplied, twinNote);
  return {
    ok: true, liveKey, size: copied, twinApplied, twinNote,
    snapshotVersion: snap ? snap.version : null,
  };
}

export interface BookApplyPage {
  chapterNum: number;
  pageIndex: number;
  changed: boolean;
  twinApplied: boolean;
}

export interface BookApplySummary {
  version: number;
  applied: number;   // pages whose live art was overwritten from the snapshot
  changed: number;   // of those, pages whose byte size actually differed
  missing: number;   // pages with no copy in that snapshot
  twinApplied: number; // pages whose color twin was applied alongside
  snapshotVersion: number | null; // archive version holding the pre-load state
  pages: BookApplyPage[];
}

// Apply a whole-book version: every editor page that has a copy in the
// snapshot gets it (plus its color twin when the snapshot has one)
// copied over the live key, its approval cleared, and the pick
// recorded. Pages without a snapshot copy are left untouched. The
// entire overwrite set is snapshotted as ONE new "takes" version
// before the first page is copied; a snapshot failure aborts the load
// with zero pages touched.
export async function applyBookVersion(
  books: BooksLike, db: any, slug: string, version: number,
): Promise<BookApplySummary> {
  // Page inventory from the editor's own chapter data.
  const pages: { chapterNum: number; pageIndex: number; liveKey: string }[] = [];
  let chapters: any[] | null = null;
  try {
    const obj = await books.get(`books/${slug}/editor_chapters.json`);
    if (obj) {
      const parsed = JSON.parse(await obj.text());
      if (Array.isArray(parsed)) chapters = parsed;
    }
  } catch { chapters = null; }
  if (chapters) {
    for (const ch of chapters) {
      const num = Number(ch?.num);
      if (!Number.isInteger(num) || !Array.isArray(ch?.pages)) continue;
      ch.pages.forEach((page: any, i: number) => {
        pages.push({
          chapterNum: num, pageIndex: i,
          liveKey: keyFromImageUrl(page?.image) || livePageKey(slug, num, i),
        });
      });
    }
  }

  // Plan phase: resolve every page's take and twin BEFORE copying
  // anything, so the snapshot set is exact.
  interface Plan {
    chapterNum: number; pageIndex: number; liveKey: string; liveSize: number | null;
    takeKey: string; twinLiveKey: string | null; twinTakeKey: string | null;
  }
  const plans: Plan[] = [];
  let missing = 0;
  for (const p of pages) {
    const takeKey = await firstExistingKey(books, archiveKeyCandidates(p.liveKey, slug, version));
    if (!takeKey) { missing += 1; continue; }
    const liveHead = await books.head(p.liveKey).catch(() => null);
    const twinLiveKey = colorTwinKey(p.liveKey, slug);
    const twinTakeKey = twinLiveKey
      ? await firstExistingKey(books, archiveKeyCandidates(twinLiveKey, slug, version))
      : null;
    plans.push({
      chapterNum: p.chapterNum, pageIndex: p.pageIndex, liveKey: p.liveKey,
      liveSize: liveHead ? Number(liveHead.size) : null,
      takeKey, twinLiveKey, twinTakeKey,
    });
  }

  // Snapshot phase: one new archive version with every live file the
  // load is about to overwrite. Throws -> abort, zero pages touched.
  const overwriteSet: string[] = [];
  for (const pl of plans) {
    overwriteSet.push(pl.liveKey);
    if (pl.twinTakeKey && pl.twinLiveKey) overwriteSet.push(pl.twinLiveKey);
  }
  const snap = plans.length ? await snapshotLiveFiles(books, slug, overwriteSet, "takes") : null;

  // Apply phase.
  const summary: BookApplySummary = {
    version, applied: 0, changed: 0, missing, twinApplied: 0,
    snapshotVersion: snap ? snap.version : null, pages: [],
  };
  const now = new Date().toISOString();
  for (const pl of plans) {
    const copied = await copyObject(books, pl.takeKey, pl.liveKey);
    if (copied === null) { summary.missing += 1; continue; }
    let twinApplied = false;
    if (pl.twinTakeKey && pl.twinLiveKey) {
      const tc = await copyObject(books, pl.twinTakeKey, pl.twinLiveKey);
      if (tc === null) throw new Error("book apply failed: an archived color twin disappeared during apply");
      twinApplied = true;
    }
    const twinNote = pl.twinLiveKey && !twinApplied ? STALE_TWIN_NOTE : null;
    const changed = pl.liveSize === null || copied !== pl.liveSize;
    await db.prepare(CLEAR_APPROVAL_SQL).bind(slug, pl.chapterNum, pl.pageIndex).run();
    await recordPick(db, slug, pl.chapterNum, pl.pageIndex, version, now, twinApplied, twinNote);
    summary.applied += 1;
    if (changed) summary.changed += 1;
    if (twinApplied) summary.twinApplied += 1;
    summary.pages.push({ chapterNum: pl.chapterNum, pageIndex: pl.pageIndex, changed, twinApplied });
  }
  return summary;
}

/* ---------- publish staleness (warn, never block) ---------- */

export interface PdfStaleness {
  stale: boolean;
  warning: string | null;
  latestTakeAt: string | null;
  pdfUploadedAt: number | null; // ms epoch of picture-book.pdf's upload
}

export const PDF_STALE_WARNING =
  "Page art changed after the last PDF assembly. The store PDFs still show the previous art until the factory reassembles them.";

// A book is PDF-stale when the newest recorded take was applied after
// picture-book.pdf was uploaded to R2. No PDF in R2 -> no warning (a
// book that was never assembled has nothing stale to show). Used by the
// editor (warning near Publish) and the publish endpoint (warning in
// the response payload). Never a blocker anywhere.
export async function getPdfStaleness(books: BooksLike, db: any, slug: string): Promise<PdfStaleness> {
  const none: PdfStaleness = { stale: false, warning: null, latestTakeAt: null, pdfUploadedAt: null };
  let latest: string | null = null;
  try {
    const row = await db.prepare(
      `SELECT MAX(applied_at) AS latest FROM page_takes WHERE book_slug = ?`
    ).bind(slug).first();
    latest = (row && typeof row.latest === "string") ? row.latest : null;
  } catch { latest = null; }
  if (!latest) return none;
  const head = await books.head(`books/${slug}/picture-book.pdf`).catch(() => null);
  if (!head || !head.uploaded) return { ...none, latestTakeAt: latest };
  const uploadedMs = new Date(head.uploaded).getTime();
  if (Number.isNaN(uploadedMs)) return { ...none, latestTakeAt: latest };
  const takeMs = Date.parse(latest);
  const stale = !Number.isNaN(takeMs) && takeMs > uploadedMs;
  return {
    stale,
    warning: stale ? PDF_STALE_WARNING : null,
    latestTakeAt: latest,
    pdfUploadedAt: uploadedMs,
  };
}
