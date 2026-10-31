// Delivery readiness: is this book actually ready to deliver
// EVERYTHING it is sold as? (CG, 2026-10-31, after his own defect
// pass found a book RGM had called ready carrying a typeset PDF
// cover, 28 truncated coloring captions, a truncated back cover,
// and no color edition.)
//
// The publish gate (publish-readiness.ts) covers the audio leg
// only. This module covers the whole advertised bundle: the
// storybook PDF, the coloring PDF, the EPUB, the audiobook (file
// present, composed cover embedded, full-cast production), the
// color edition, complete casting for every character in the
// book, and the assembly QA measurements recorded in book_qa by
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
  /** Assembly QA measurements; null = never measured. */
  qa: {
    coverTypeset: boolean;
    coloringCaptionsTruncated: number;
    backCoverTruncated: boolean;
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
          detail: "Line art purity: not measured yet. The base book is black-and-white line art only; colored line pages are a known defect class and readiness does not vouch for this until the factory audit measures it." }
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
    const uncast = f.cast.filter((c) => !c.cast).map((c) => c.name);
    checks.push(
      uncast.length === 0
        ? { id: "cast-complete", label: "Casting", state: "pass",
            detail: `Casting: all ${f.cast.length} characters are cast.` }
        : { id: "cast-complete", label: "Casting", state: "fail",
            detail: `Casting: ${uncast.join(", ")} ${uncast.length === 1 ? "is" : "are"} not cast yet. Audiobooks are full-cast, so every character needs a voice.` }
    );
  }

  checks.push(
    f.audioProduction === "full-cast"
      ? { id: "audio-production", label: "Audiobook production", state: "pass",
          detail: "Audiobook production: full-cast final." }
      : f.audioProduction === "single-voice"
        ? { id: "audio-production", label: "Audiobook production", state: "fail",
            detail: `Audiobook production: the file on record is a single-voice draft${f.audioVoiceName ? ` read in ${f.audioVoiceName}` : ""}. The final is a full-cast production.` }
        : f.audioProduction === "none"
          ? { id: "audio-production", label: "Audiobook production", state: "fail",
              detail: "Audiobook production: no production stamp on the audiobook, so it cannot be confirmed as a final." }
          : { id: "audio-production", label: "Audiobook production", state: "unknown",
              detail: "Audiobook production: the production stamp could not be read." }
  );

  if (!f.qa) {
    checks.push({ id: "pdf-qa", label: "PDF content QA", state: "unknown",
      detail: "PDF content QA: the PDFs have not been measured yet (covers, captions, back cover)." });
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

  return { slug: f.slug, title: f.title, checks, blockers, unknowns, verdict, statusLabel };
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

/** Measured line purity from book_qa: 1 = pure, 0 = colored
 *  pages found, null = no row or never measured. */
async function readLinePurity(db: any, slug: string): Promise<boolean | null> {
  try {
    await ensureBookQaTable(db);
    const row = await db
      .prepare(`SELECT line_purity FROM book_qa WHERE slug = ?`)
      .bind(slug)
      .first();
    if (!row || row.line_purity === null || row.line_purity === undefined) return null;
    return Number(row.line_purity) === 1;
  } catch {
    return null;
  }
}

async function readQa(db: any, slug: string): Promise<DeliveryFacts["qa"]> {
  try {
    await ensureBookQaTable(db);
    const row = await db
      .prepare(
        `SELECT cover_typeset, coloring_captions_truncated, back_cover_truncated
         FROM book_qa WHERE slug = ?`
      )
      .bind(slug)
      .first();
    if (!row) return null;
    return {
      coverTypeset: !!row.cover_typeset,
      coloringCaptionsTruncated: Number(row.coloring_captions_truncated || 0),
      backCoverTruncated: !!row.back_cover_truncated,
    };
  } catch {
    return null;
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

async function readMarketing(db: any, books: any, slug: string): Promise<DeliveryFacts["marketing"]> {
  try {
    await ensureBookMarketingTable(db);
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
  slug: string
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
    await ensureCastTables(db);
    await seedRecordedCasts(db);
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

  const qa = await readQa(db, slug);
  const marketing = await readMarketing(db, books, slug);

  return computeDeliveryReadiness({
    slug: book.slug,
    title: book.title,
    files: { picture, coloring, epub, audiobook, color },
    audioCover,
    // Measured by the vision-QC pass into book_qa (Fern's colored
    // line art is why this exists); unmeasured stays unknown.
    linePurity: await readLinePurity(db, slug),
    cast,
    audioProduction,
    audioVoiceName,
    qa,
    marketing,
  });
}
