// Delivery readiness: is this book actually ready to deliver
// EVERYTHING it is sold as? (CG, 2026-10-31, after his own defect
// pass found a book RGM had called ready carrying a typeset PDF
// cover, 28 truncated coloring captions, a truncated back cover,
// and no color edition.)
//
// The publish gate (publish-readiness.ts) covers the audio leg
// only. This module covers the whole advertised bundle: the
// storybook PDF, the coloring PDF, the EPUB, the audiobook (file
// present, composed cover embedded, single-voice production in
// the lead's cast voice), the color edition, the lead cast (the
// audiobook is read by the protagonist's voice; supporting
// voices are optional, saved for video), and the assembly QA
// measurements recorded in book_qa by
// whoever assembled or measured the PDFs (the factory composer
// writes them at assembly; RGM backfilled Mira's by hand from
// her R2 PDFs on 2026-10-31).
//
// Truth rule (CG): a check is pass, fail, or unknown. Unknown
// NEVER counts as ready. A book is "ready" only when every check
// passes; any fail makes it "not-ready" with the blockers named;
// no fails but some unknowns makes it "unverified".
import { bibleCast, ensureCastTables, seedRecordedCasts, type CastCharacter } from "./cast-registry";
import { audiobookMetaKey } from "./audiobooks";
import { voiceDisplayName } from "./publish-readiness";
import { assessColorEdition, getSignoffStates, type SignoffStateName } from "./qc-signoffs";
import { captureApprovalRevision } from "./approval-identity";

export type DeliveryCheckState = "pass" | "fail" | "unknown";

export interface DeliveryCheck {
  id: string;
  label: string;
  state: DeliveryCheckState;
  detail: string;
}

export type DeliveryVerdict = "ready" | "product-ready" | "not-ready" | "unverified";

export interface DeliveryReadiness {
  slug: string;
  title: string;
  checks: DeliveryCheck[];
  blockers: string[];
  unknowns: string[];
  verdict: DeliveryVerdict;
  statusLabel: string;
  /** Raw QC sign-off state names for the current revision, for
   * surfaces (the readiness step list) that present the sign-off
   * states directly rather than through a check. */
  signoffs?: { story: SignoffStateName; color: SignoffStateName } | null;
}

export interface DeliveryFacts {
  slug: string;
  title: string;
  /** R2 presence per deliverable; null = the check itself failed. */
  files: {
    picture: boolean | null;
    coloring: boolean | null;
    epub: boolean | null;
    audiobook: boolean | null;
    color: boolean | null;
  };
  /** What the audiobook's embedded cover looks like. */
  audioCover: "composed" | "bare" | "none" | "unknown";
  /** Line-art purity: the base book is black-and-white line art
   *  only, so a page drawn in color is a defect (CG caught Fern's
   *  line art carrying color, 2026-10-31, and noted readiness
   *  was overstating closeness). true = measured pure, false =
   *  measured colored pages, null = never measured, which reads
   *  as UNVERIFIED, never as fine. */
  linePurity: boolean | null;
  /** The book's bible cast with casting state; null = no bible found. */
  cast: { name: string; cast: boolean }[] | null;
  /** Production state from the generator's audiobook-meta stamp. */
  audioProduction: "full-cast" | "single-voice" | "none" | "unknown";
  audioVoiceName: string | null;
  /** Assembly QA measurements; null = never measured (or stale). */
  qa: {
    coverTypeset: boolean;
    coloringCaptionsTruncated: number;
    backCoverTruncated: boolean;
  } | null;
  /** True when a book_qa measurement exists but cannot be proven
   *  to describe the current storybook/coloring files (the assets
   *  are newer than the measurement, or freshness cannot be
   *  established). Stale measurements are reported as unverified,
   *  never as pass or fail. The guard is read-only: it never writes,
   *  deletes, publishes, blocks a publish, or triggers a re-measure. */
  qaStale?: boolean;
  /** QC sign-offs (CG, 2026-11-03): the two human attestations,
   *  full story then full color, bound to the book's current
   *  revision. Null = the states could not be checked, which reads
   *  as unknown, never as signed. */
  signoffs: {
    story: SignoffStateName;
    color: SignoffStateName;
    /** Color detail for the checklist copy: why the color sign-off
     * is unavailable (incomplete vs out of date), and for a voided
     * sign-off the date it was originally recorded. */
    colorReason?: "incomplete" | "stale" | null;
    colorAt?: string | null;
  } | null;
  /** Marketing assets (the LAST readiness step, CG 2026-10-31:
   *  everything else gets put together first, then marketing is
   *  made and can just run). Null = never measured. */
  marketing: {
    promoMain: boolean;
    promoParents: boolean;
    defects: string | null;
    /** The marketing kit manifest's own missing list (books/{slug}/
     *  marketing/manifest.json): null = no readable kit in storage,
     *  [] = the kit is complete. An incomplete kit fails this check
     *  on its own (CG, 2026-10-31: "make sure that gets caught"). */
    kitMissing: string[] | null;
  } | null;
}

function fileCheck(
  id: string,
  label: string,
  present: boolean | null,
  missingDetail: string
): DeliveryCheck {
  if (present === null)
    return { id, label, state: "unknown", detail: `${label}: presence could not be checked.` };
  return present
    ? { id, label, state: "pass", detail: `${label}: on file.` }
    : { id, label, state: "fail", detail: missingDetail };
}

/** The pure decision: measured facts in, verdict + named blockers out. */
export function computeDeliveryReadiness(f: DeliveryFacts): DeliveryReadiness {
  const checks: DeliveryCheck[] = [];

  checks.push(
    fileCheck("storybook-pdf", "Storybook PDF", f.files.picture,
      "Storybook PDF: no picture book file on record.")
  );
  checks.push(
    fileCheck("coloring-pdf", "Coloring book PDF", f.files.coloring,
      "Coloring book PDF: no coloring book file on record.")
  );
  checks.push(
    fileCheck("epub", "EPUB ebook", f.files.epub,
      "EPUB ebook: no EPUB on record, but the bundle sells an ebook.")
  );
  checks.push(
    fileCheck("audiobook-file", "Audiobook file", f.files.audiobook,
      "Audiobook file: no audiobook on record.")
  );

  checks.push(
    f.linePurity === null
      ? { id: "line-purity", label: "Line art purity", state: "unknown",
          detail: f.qaStale
            ? "Line art purity: the last measurement predates the current book files, so it is stale and does not count. Re-measure before treating this as ready."
            : "Line art purity: not measured yet. The base book is black-and-white line art only; colored line pages are a known defect class and readiness does not vouch for this until the factory audit measures it." }
      : f.linePurity
        ? { id: "line-purity", label: "Line art purity", state: "pass",
            detail: "Line art purity: measured, the line pages are black and white." }
        : { id: "line-purity", label: "Line art purity", state: "fail",
            detail: "Line art purity: measured colored pages in the line art. The base book is line only; colored pages belong to the color edition." }
  );

  checks.push(
    f.audioCover === "composed"
      ? { id: "audiobook-cover", label: "Audiobook cover", state: "pass",
          detail: "Audiobook cover: the composed cover is embedded." }
      : f.audioCover === "bare"
        ? { id: "audiobook-cover", label: "Audiobook cover", state: "fail",
            detail: "Audiobook cover: the file still embeds the bare art, not the composed cover." }
        : f.audioCover === "none"
          ? { id: "audiobook-cover", label: "Audiobook cover", state: "fail",
              detail: "Audiobook cover: the file has no embedded cover art." }
          : { id: "audiobook-cover", label: "Audiobook cover", state: "unknown",
              detail: "Audiobook cover: the embedded cover could not be inspected." }
  );

  checks.push(
    fileCheck("color-edition", "Color edition", f.files.color,
      "Color edition: no colorized story book exists, but the bundle advertises the full color story book.")
  );

  if (!f.cast) {
    checks.push({ id: "cast-complete", label: "Casting", state: "unknown",
      detail: "Casting: no cast list found for this book." });
  } else {
    // Single-voice standard (CG, 2026-11-04): the lead's voice
    // reads the whole audiobook, so only the lead must be cast.
    // The cast list is in bible order; the lead is first (the same
    // convention the generator's guard uses). Uncast supporting
    // characters are noted, never a blocker: their voices are
    // optional, saved for the video work.
    const lead = f.cast[0];
    const uncastSupporting = f.cast.slice(1).filter((c) => !c.cast).map((c) => c.name);
    checks.push(
      !lead
        ? { id: "cast-complete", label: "Casting", state: "unknown",
            detail: "Casting: the cast list is empty." }
        : lead.cast
          ? { id: "cast-complete", label: "Casting", state: "pass",
              detail: uncastSupporting.length === 0
                ? `Casting: all ${f.cast.length} characters are cast.`
                : `Casting: ${lead.name} is cast and reads the audiobook. ${uncastSupporting.join(", ")} ${uncastSupporting.length === 1 ? "is" : "are"} not cast; supporting voices are optional, saved for video.` }
          : { id: "cast-complete", label: "Casting", state: "fail",
              detail: `Casting: ${lead.name}, the lead, is not cast yet. The audiobook is read in the lead's voice, so the lead needs a voice before recording.` }
    );
  }

  checks.push(
    f.audioProduction === "full-cast"
      ? { id: "audio-production", label: "Audiobook production", state: "pass",
          detail: "Audiobook production: full-cast final (legacy production)." }
      : f.audioProduction === "single-voice"
        ? { id: "audio-production", label: "Audiobook production", state: "pass",
            detail: `Audiobook production: single-voice final${f.audioVoiceName ? `, read in ${f.audioVoiceName}` : ""}.` }
        : f.audioProduction === "none"
          ? { id: "audio-production", label: "Audiobook production", state: "fail",
              detail: "Audiobook production: no production stamp on the audiobook, so it cannot be confirmed as a final." }
          : { id: "audio-production", label: "Audiobook production", state: "unknown",
              detail: "Audiobook production: the production stamp could not be read." }
  );

  if (!f.qa) {
    checks.push({ id: "pdf-qa", label: "PDF content QA", state: "unknown",
      detail: f.qaStale
        ? "PDF content QA: the last measurement predates the current storybook or coloring files, so it is stale and does not count. Re-measure before treating this as ready."
        : "PDF content QA: the PDFs have not been measured yet (covers, captions, back cover)." });
  } else {
    const problems: string[] = [];
    if (f.qa.coverTypeset) problems.push("the PDF front covers are typeset, not the finished cover");
    if (f.qa.coloringCaptionsTruncated > 0)
      problems.push(`${f.qa.coloringCaptionsTruncated} coloring captions are truncated mid-sentence`);
    if (f.qa.backCoverTruncated) problems.push("the back-cover text is truncated");
    checks.push(
      problems.length === 0
        ? { id: "pdf-qa", label: "PDF content QA", state: "pass",
            detail: "PDF content QA: covers, captions, and back cover measured clean." }
        : { id: "pdf-qa", label: "PDF content QA", state: "fail",
            detail: `PDF content QA: ${problems.join("; ")}.` }
    );
  }

  // QC sign-offs (CG, 2026-11-03): full story, then full color.
  // Explicit states only: done, outstanding, or not yet available;
  // an unchecked state is unknown, never a pass.
  if (!f.signoffs) {
    checks.push({ id: "story-qc-signoff", label: "Full story QC sign-off", state: "unknown",
      detail: "Full story QC sign-off: the sign-off state could not be checked." });
    checks.push({ id: "color-qc-signoff", label: "Full color QC sign-off", state: "unknown",
      detail: "Full color QC sign-off: the sign-off state could not be checked." });
  } else {
    checks.push(
      f.signoffs.story === "done"
        ? { id: "story-qc-signoff", label: "Full story QC sign-off", state: "pass",
            detail: "Full story QC sign-off: recorded for the current revision." }
        : f.signoffs.story === "unknown"
          ? { id: "story-qc-signoff", label: "Full story QC sign-off", state: "unknown",
              detail: "Full story QC sign-off: the sign-off state could not be checked." }
          : { id: "story-qc-signoff", label: "Full story QC sign-off", state: "fail",
              detail: "Full story QC sign-off: outstanding. Read the full story in the QC viewer and sign off." }
    );
    checks.push(
      f.signoffs.color === "done"
        ? { id: "color-qc-signoff", label: "Full color QC sign-off", state: "pass",
            detail: "Full color QC sign-off: recorded for the current revision." }
        : f.signoffs.color === "voided"
          ? { id: "color-qc-signoff", label: "Full color QC sign-off", state: "fail",
              detail: `Full color QC sign-off: voided. The color edition changed after the sign-off was recorded${f.signoffs.colorAt ? ` (${String(f.signoffs.colorAt).slice(0, 10)})` : ""}, so it no longer counts. Read the full color edition in the QC viewer and sign off again.` }
          : f.signoffs.color === "unavailable" && f.signoffs.colorReason === "stale"
            ? { id: "color-qc-signoff", label: "Full color QC sign-off", state: "fail",
                detail: "Full color QC sign-off: not yet available. The color edition is out of date: some color pages are older than the line pages they were colored from. Re-run colorize so every color page is current, then sign off." }
            : f.signoffs.color === "unavailable"
              ? { id: "color-qc-signoff", label: "Full color QC sign-off", state: "fail",
                  detail: "Full color QC sign-off: not yet available. The color edition is incomplete, so there is no full color edition to sign off." }
              : f.signoffs.color === "unknown"
                ? { id: "color-qc-signoff", label: "Full color QC sign-off", state: "unknown",
                    detail: "Full color QC sign-off: the sign-off state could not be checked." }
                : { id: "color-qc-signoff", label: "Full color QC sign-off", state: "fail",
                    detail: "Full color QC sign-off: outstanding. Read the full color edition in the QC viewer and sign off." }
    );
  }

  if (!f.marketing) {
    checks.push({ id: "marketing-assets", label: "Marketing assets", state: "unknown",
      detail: "Marketing assets: not measured yet (the promo pair is the last readiness step)." });
  } else {
    const problems: string[] = [];
    if (f.marketing.defects) problems.push(f.marketing.defects);
    if (!f.marketing.promoMain) problems.push("the main promo is not made yet");
    if (!f.marketing.promoParents) problems.push("the parents promo is not made yet");
    if (f.marketing.kitMissing === null) problems.push("there is no marketing kit manifest yet");
    else if (f.marketing.kitMissing.length)
      problems.push(`the marketing kit still needs: ${f.marketing.kitMissing.join("; ")}`);
    checks.push(
      problems.length === 0
        ? { id: "marketing-assets", label: "Marketing assets", state: "pass",
            detail: "Marketing assets: the promo pair is made and the marketing kit is complete." }
        : { id: "marketing-assets", label: "Marketing assets", state: "fail",
            detail: `Marketing assets: ${problems.join("; ")}. Marketing is the last step, made once everything else is together.` }
    );
  }

  const failChecks = checks.filter((c) => c.state === "fail");
  const blockers = failChecks.map((c) => c.detail);
  const unknowns = checks.filter((c) => c.state === "unknown").map((c) => c.label);
  // Marketing is the final step by design: when it is the ONLY
  // thing outstanding, the product itself is ready and the book
  // sits one step from launch.
  const marketingOnly =
    failChecks.length > 0 &&
    failChecks.every((c) => c.id === "marketing-assets") &&
    unknowns.length === 0;
  const verdict: DeliveryVerdict =
    blockers.length === 0
      ? unknowns.length > 0
        ? "unverified"
        : "ready"
      : marketingOnly
        ? "product-ready"
        : "not-ready";
  const statusLabel =
    verdict === "ready"
      ? "Ready to deliver"
      : verdict === "product-ready"
        ? "Product ready: marketing is the last step"
        : verdict === "not-ready"
          ? `Not ready: ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`
          : `Unverified: ${unknowns.length} check${unknowns.length === 1 ? "" : "s"} not measured`;

  return {
    slug: f.slug, title: f.title, checks, blockers, unknowns, verdict, statusLabel,
    signoffs: f.signoffs ? { story: f.signoffs.story, color: f.signoffs.color } : null,
  };
}

// ---- Assembly QA flags (book_qa) ---------------------------------------

export async function ensureBookQaTable(db: any): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS book_qa (
        slug TEXT PRIMARY KEY,
        cover_typeset INTEGER NOT NULL DEFAULT 0,
        coloring_captions_truncated INTEGER NOT NULL DEFAULT 0,
        back_cover_truncated INTEGER NOT NULL DEFAULT 0,
        line_purity INTEGER,
        source TEXT,
        measured_at INTEGER
      )`
    )
    .run();
  // Older tables predate the line_purity column (added
  // 2026-10-31 for the vision-QC measurements); add it when
  // missing. NULL means never measured.
  try {
    await db.prepare(`ALTER TABLE book_qa ADD COLUMN line_purity INTEGER`).run();
  } catch { /* column already there */ }
}

function toSeconds(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }
  return null;
}

async function headUploadedSec(books: any, key: string | null): Promise<number | null> {
  if (!key || !books || typeof books.head !== "function") return null;
  try {
    const h = await books.head(key);
    return h ? toSeconds((h as any).uploaded) : null;
  } catch {
    return null;
  }
}

async function latestLineEditionSec(db: any, slug: string): Promise<number | null> {
  try {
    const row = await db
      .prepare(
        `SELECT MAX(created_at) AS latest FROM editions WHERE slug = ? AND edition != 'color'`
      )
      .bind(slug)
      .first();
    return row ? toSeconds((row as any).latest) : null;
  } catch {
    return null;
  }
}

export interface BookQaFacts {
  qa: DeliveryFacts["qa"];
  linePurity: boolean | null;
  stale: boolean;
}

// Freshness guard (CG, 2026-11-02): a book_qa measurement only
// counts while it can be proven to describe the CURRENT storybook
// and coloring files. The assets' last-change time is the latest of
// the non-color edition manifests and the two PDFs' R2 upload
// times. If the assets are newer than the measurement (beyond a
// five-minute clock/ordering grace), or freshness cannot be
// established at all, the measurement is stale: qa and line purity
// come back null so the verdict reads unverified. The guard is
// READ-ONLY and one-directional: it can only withhold a verdict,
// never create one, and it never writes, deletes, publishes, or
// triggers a re-measure (a re-measure happens only when the owner
// explicitly asks for one).
const QA_FRESHNESS_GRACE_SEC = 300;

async function readBookQaFacts(db: any, books: any, book: any, readOnly = false): Promise<BookQaFacts> {
  try {
    if (!readOnly) await ensureBookQaTable(db);
    const row = await db
      .prepare(
        `SELECT cover_typeset, coloring_captions_truncated, back_cover_truncated, line_purity, measured_at
         FROM book_qa WHERE slug = ?`
      )
      .bind(String(book.slug))
      .first();
    if (!row) return { qa: null, linePurity: null, stale: false };
    const measuredAt = toSeconds((row as any).measured_at);
    const assetSecs = (
      await Promise.all([
        latestLineEditionSec(db, String(book.slug)),
        headUploadedSec(books, book.picture_book_key ? String(book.picture_book_key) : null),
        headUploadedSec(books, book.coloring_book_key ? String(book.coloring_book_key) : null),
      ])
    ).filter((s): s is number => typeof s === "number");
    const latestAsset = assetSecs.length ? Math.max(...assetSecs) : null;
    const stale =
      measuredAt === null || latestAsset === null
        ? true
        : latestAsset > measuredAt + QA_FRESHNESS_GRACE_SEC;
    if (stale) return { qa: null, linePurity: null, stale: true };
    return {
      qa: {
        coverTypeset: !!(row as any).cover_typeset,
        coloringCaptionsTruncated: Number((row as any).coloring_captions_truncated || 0),
        backCoverTruncated: !!(row as any).back_cover_truncated,
      },
      linePurity:
        (row as any).line_purity === null || (row as any).line_purity === undefined
          ? null
          : Number((row as any).line_purity) === 1,
      stale: false,
    };
  } catch {
    // A row we cannot read proves nothing either way; report the
    // checks as unmeasured rather than inventing a verdict.
    return { qa: null, linePurity: null, stale: false };
  }
}

// ---- Marketing assets (book_marketing) ---------------------------------

export async function ensureBookMarketingTable(db: any): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS book_marketing (
        slug TEXT PRIMARY KEY,
        promo_main_key TEXT,
        promo_parents_key TEXT,
        known_defects TEXT,
        source TEXT,
        updated_at INTEGER
      )`
    )
    .run();
}

async function readMarketing(db: any, books: any, slug: string, readOnly = false): Promise<DeliveryFacts["marketing"]> {
  try {
    if (!readOnly) await ensureBookMarketingTable(db);
    const row = await db
      .prepare(
        `SELECT promo_main_key, promo_parents_key, known_defects FROM book_marketing WHERE slug = ?`
      )
      .bind(slug)
      .first();
    // The kit manifest itself is part of the check: if the kit
    // says it is still missing things, marketing is not done,
    // however clean the promo pair looks.
    let kitMissing: string[] | null = null;
    let kitPromos: { main: boolean; parents: boolean } | null = null;
    try {
      const obj = await books.get(`books/${slug}/marketing/manifest.json`);
      if (obj) {
        const m = JSON.parse(await obj.text());
        kitMissing = Array.isArray(m?.missing) ? m.missing.map(String) : [];
        if (m?.promos) kitPromos = { main: !!m.promos.main, parents: !!m.promos.parents };
      }
    } catch { kitMissing = null; }
    if (!row) {
      // No measurement row yet, but a kit manifest exists (every
      // book gets one): the kit alone still gets caught.
      if (kitMissing === null) return null;
      return {
        promoMain: kitPromos?.main ?? false,
        promoParents: kitPromos?.parents ?? false,
        defects: null,
        kitMissing,
      };
    }
    return {
      promoMain: !!row.promo_main_key,
      promoParents: !!row.promo_parents_key,
      defects: row.known_defects ? String(row.known_defects) : null,
      kitMissing,
    };
  } catch {
    return null;
  }
}

// ---- M4B cover inspection ----------------------------------------------
// The composed covers are portrait (the titled cover art); the bare
// art the generator used to embed is square. Walking moov > udta >
// meta > ilst > covr and reading the JPEG's dimensions separates
// the two without trusting anyone's say-so.

interface BoxHit { start: number; size: number; header: number }

function findBox(buf: Uint8Array, dv: DataView, start: number, end: number, want: string): BoxHit | null {
  let off = start;
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    let header = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < 8) return null;
    if (type === want) return { start: off, size, header };
    off += size;
  }
  return null;
}

function jpegDims(jpg: Uint8Array): { w: number; h: number } | null {
  if (jpg.length < 4 || jpg[0] !== 0xff || jpg[1] !== 0xd8) return null;
  const dv = new DataView(jpg.buffer, jpg.byteOffset, jpg.byteLength);
  let off = 2;
  while (off + 4 <= jpg.length) {
    if (jpg[off] !== 0xff) return null;
    const marker = jpg[off + 1];
    const len = dv.getUint16(off + 2);
    if (len < 2) return null;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (off + 9 > jpg.length) return null;
      return { h: dv.getUint16(off + 5), w: dv.getUint16(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}

export function audioCoverKind(bytes: Uint8Array): DeliveryFacts["audioCover"] {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const moov = findBox(bytes, dv, 0, bytes.length, "moov");
    if (!moov) return "unknown";
    const udta = findBox(bytes, dv, moov.start + moov.header, moov.start + moov.size, "udta");
    if (!udta) return "unknown";
    const meta = findBox(bytes, dv, udta.start + udta.header, udta.start + udta.size, "meta");
    if (!meta) return "unknown";
    const ilst = findBox(bytes, dv, meta.start + meta.header + 4, meta.start + meta.size, "ilst");
    if (!ilst) return "unknown";
    const covr = findBox(bytes, dv, ilst.start + ilst.header, ilst.start + ilst.size, "covr");
    if (!covr) return "none";
    const data = findBox(bytes, dv, covr.start + covr.header, covr.start + covr.size, "data");
    if (!data) return "unknown";
    const jpgStart = data.start + data.header + 8; // data atom: type flags + locale precede the image
    const jpg = bytes.subarray(jpgStart, data.start + data.size);
    const dims = jpegDims(jpg);
    if (!dims) return "unknown";
    return dims.h > dims.w ? "composed" : "bare";
  } catch {
    return "unknown";
  }
}

// ---- DB/R2 assembly ------------------------------------------------------

async function headOrNull(books: any, key: string | null): Promise<boolean | null> {
  if (!key) return false;
  if (!books || typeof books.head !== "function") return null;
  try {
    return !!(await books.head(key));
  } catch {
    return null;
  }
}

export async function getDeliveryReadiness(
  db: any,
  books: any,
  slug: string,
  options: { readOnly?: boolean } = {}
): Promise<DeliveryReadiness | null> {
  const book = await db
    .prepare(
      `SELECT slug, title, picture_book_key, coloring_book_key, epub_key, audiobook_key, color_book_key
       FROM books WHERE slug = ?`
    )
    .bind(slug)
    .first();
  if (!book) return null;

  const [picture, coloring, epub, audiobook, color] = await Promise.all([
    headOrNull(books, book.picture_book_key ? String(book.picture_book_key) : null),
    headOrNull(books, book.coloring_book_key ? String(book.coloring_book_key) : null),
    headOrNull(books, book.epub_key ? String(book.epub_key) : null),
    headOrNull(books, book.audiobook_key ? String(book.audiobook_key) : null),
    headOrNull(books, book.color_book_key ? String(book.color_book_key) : null),
  ]);

  // Cast completeness from the bible + the voice registry.
  let cast: DeliveryFacts["cast"] = null;
  try {
    if (!options.readOnly) {
      await ensureCastTables(db);
      await seedRecordedCasts(db);
    }
    const row = await db
      .prepare(`SELECT data FROM bibles WHERE book_slug = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(slug)
      .first();
    if (row?.data) {
      const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
      const members: CastCharacter[] = bibleCast(data);
      const { results } = await db
        .prepare(`SELECT character_name, voice_id FROM character_voices`)
        .all();
      const voiced = new Map<string, boolean>();
      for (const r of (results || []) as any[]) voiced.set(r.character_name, !!r.voice_id);
      cast = members.map((m) => ({ name: m.name, cast: voiced.get(m.name) ?? false }));
    }
  } catch {
    cast = null;
  }

  // Audiobook production stamp (raw meta: parseVoiceStamp drops the
  // production field, and the production model is what matters here).
  let audioProduction: DeliveryFacts["audioProduction"] = "unknown";
  let audioVoiceName: string | null = null;
  const audiobookKey = book.audiobook_key ? String(book.audiobook_key) : null;
  if (audiobookKey && books && typeof books.get === "function") {
    try {
      const obj = await books.get(audiobookMetaKey(audiobookKey));
      if (!obj) {
        audioProduction = "none";
      } else {
        const meta = JSON.parse(await obj.text());
        audioVoiceName = meta?.voiceId ? voiceDisplayName(meta.voiceId) : null;
        audioProduction = meta?.production === "full-cast" ? "full-cast" : "single-voice";
      }
    } catch {
      audioProduction = "unknown";
    }
  } else if (!audiobookKey) {
    audioProduction = "none";
  }

  // Embedded cover: read the front of the file (faststart keeps the
  // metadata up front) and walk to the covr atom.
  let audioCover: DeliveryFacts["audioCover"] = "unknown";
  if (audiobookKey && audiobook && books && typeof books.get === "function") {
    try {
      const obj = await books.get(audiobookKey, {
        range: { offset: 0, length: 2_500_000 },
      });
      if (obj) {
        const bytes = new Uint8Array(await obj.arrayBuffer());
        audioCover = audioCoverKind(bytes);
      }
    } catch {
      audioCover = "unknown";
    }
  }

  const qaFacts = await readBookQaFacts(db, books, book, options.readOnly);
  const marketing = await readMarketing(db, books, slug, options.readOnly);

  // QC sign-off states for the current revision. Read-only: a book
  // whose revision cannot be captured, or whose sign-offs cannot be
  // read, reports null and renders unknown, never signed.
  let signoffs: DeliveryFacts["signoffs"] = null;
  try {
    const snapshot = await captureApprovalRevision(db, books, slug, { readOnly: !!options.readOnly });
    const states = await getSignoffStates(
      db, slug, snapshot.manifest.revision, assessColorEdition(snapshot.manifest)
    );
    signoffs = {
      story: states.story.state,
      color: states.color.state,
      colorReason: states.color.unavailableReason ?? null,
      colorAt: states.color.at,
    };
  } catch {
    signoffs = null;
  }

  return computeDeliveryReadiness({
    slug: book.slug,
    title: book.title,
    files: { picture, coloring, epub, audiobook, color },
    audioCover,
    signoffs,
    // Measured by the vision-QC pass into book_qa (Fern's colored
    // line art is why this exists); unmeasured or stale stays
    // unknown, never a verdict.
    linePurity: qaFacts.linePurity,
    cast,
    audioProduction,
    audioVoiceName,
    qa: qaFacts.qa,
    qaStale: qaFacts.stale,
    marketing,
  });
}
