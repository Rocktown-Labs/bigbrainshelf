// Per-buyer PDF stamping at download time (owner-approved protection
// plan, 2026-10-29): a file a buyer owns should be traceable back to
// its purchase without annoying the family who paid for it. When
// /api/download serves a PDF, this pass adds:
//
//   - a visible footer line on interior pages, centered in the bottom
//     margin: "Licensed to {buyer email} · Order {#SHORTID}". The
//     factory's assembly footer (kidsbook-factory src/pdf.ts) puts the
//     brand line at the left margin and the page number at the right
//     margin, both at baseline y=22 on letter pages. A long email
//     centered on that same baseline could reach the brand text, so
//     the licensed line rides as a second short line just above it
//     (baseline y=31, still inside the bottom margin and clear of the
//     coloring caption, whose baseline is y=40). On a PDF that
//     predates the brand footer the line simply stands alone. Covers
//     (first and last page) are never stamped.
//   - a hidden marker: the order id and buyer email ride in the PDF
//     metadata (Subject carries the visible line; Keywords carry
//     machine-readable bbs-order / bbs-grant and bbs-buyer entries).
//   - a microtext order code on every 7th interior page: the short
//     order code alone, tiny (4.5pt) and very light, centered low in
//     the bottom margin at y=11, under the footer baseline. Present
//     for tracing, unobtrusive in normal reading and printing.
//
// The stamp is computed per request from the R2 bytes; nothing is
// written back to R2. A failure here must never break a legitimate
// download, so callers catch and serve the original bytes.
//
// It also inserts the dedication page when the caller supplies the
// child's first name (PdfStampInfo.childName): one page after the
// cover, "This book belongs to {name}", drawn in the brand navy with
// an orange rule. Personal to the family, generated per download,
// never stored.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { logoStackedPngBytes } from "./logo-art";

export interface PdfStampInfo {
  /** The buyer's email, printed on their own copy (the deterrent). */
  email: string;
  /**
   * The child's first name for the dedication page (CG's queued
   * delight, 2026-11-01): the page is inserted right after the
   * front cover on every stamped PDF; when a name is set it reads
   * "This book belongs to {name}", and with no name the line stays
   * blank for the family to fill in by hand.
   */
  childName?: string | null;
  /** The book's public title, printed on the dedication page. */
  bookTitle?: string | null;
  /**
   * Preformatted production date for the dedication page ("November
   * 1, 2026"): the purchase date of the granting order or box when
   * the caller knows it. Null omits the line.
   */
  producedOn?: string | null;
  /** Stacked brand logo PNG bytes for the dedication page, if loadable. */
  logoPng?: Uint8Array | null;
  /** "#A1B2C3D4" display form of the order id, or null for club-box grants. */
  shortId: string | null;
  /**
   * Machine marker for metadata: the full order id when the grant is
   * an order, otherwise the grant key (e.g. "club-box:{id}").
   */
  marker: string;
  /** True when marker is a real order id (drives the bbs-order keyword). */
  markerIsOrder: boolean;
}

const FOOTER_Y = 31; // a second line above the factory brand footer (y=22)
const MICRO_Y = 11; // below the brand baseline, still inside the margin
const FOOTER_GRAY = rgb(0.55, 0.55, 0.55); // matches the factory footer
const MICRO_GRAY = rgb(0.84, 0.84, 0.84);

/** Keep drawn text inside pdf-lib's WinAnsi repertoire (the "·" stays). */
function cleanText(s: string): string {
  return String(s || "").replace(/[^\x20-\x7E·]/g, "").trim();
}

export function licensedLine(info: PdfStampInfo): string {
  const email = cleanText(info.email) || "the buyer";
  return info.shortId ? `Licensed to ${email} · Order ${info.shortId}` : `Licensed to ${email}`;
}

/** The standalone microtext code: the short order code without its "#". */
export function microtextCode(info: PdfStampInfo): string {
  if (info.shortId) return info.shortId.replace(/^#/, "");
  return cleanText(info.marker).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).toUpperCase();
}

/** The dedication page's name: first token only, print-safe, capped. */
export function dedicationName(info: PdfStampInfo): string | null {
  const first = cleanText(String(info.childName || "").trim().split(/\s+/)[0] || "");
  return first ? first.slice(0, 24) : null;
}

const NAVY = rgb(0.102, 0.204, 0.329);
const ORANGE = rgb(0.93, 0.35, 0.05);
const INK = rgb(0.28, 0.25, 0.23);
const FOOT_GRAY = rgb(0.45, 0.42, 0.4);

/** The dedication blurb (CG picked A, 2026-11-01). */
export const DEDICATION_BLURB =
  "To a curious reader: every big idea starts as a small question. May you ask a thousand more.";

/** Greedy word wrap against a font metric; returns display lines. */
function wrapLines(text: string, font: any, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && font.widthOfTextAtSize(next, size) > maxWidth) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Insert the dedication page after the front cover (v2 design, CG
 * approved 2026-11-01 with his fixes: the line under the logo is
 * just "Presents", the child's name is orange, the footer is two
 * plain lines with no heart, and the page carries the production
 * date, which is the purchase date). The page takes the cover's
 * size so it sits naturally in the book, and it carries no licensed
 * footer: it is front matter, like a gift inscription.
 */
async function insertDedicationPage(doc: PDFDocument, name: string | null, info: PdfStampInfo): Promise<void> {
  const pages = doc.getPages();
  if (pages.length <= 2) return;
  const { width, height } = pages[0].getSize();
  const page = doc.insertPage(1, [width, height]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique);
  const centerX = (text: string, font: any, size: number) =>
    Math.max(0, (width - font.widthOfTextAtSize(text, size)) / 2);

  // Double frame: navy outer, thin orange inner.
  page.drawRectangle({ x: 26, y: 26, width: width - 52, height: height - 52, borderWidth: 2.5, borderColor: NAVY });
  page.drawRectangle({ x: 33, y: 33, width: width - 66, height: height - 66, borderWidth: 1, borderColor: ORANGE });

  // Brand: the stacked logo when the caller could load it, else the
  // text wordmark. Brand rule (CG): in typeset "Big Brain Shelf",
  // the word Brain is always orange. Layout chains downward from
  // the header so the stack can never collide, whatever the logo's
  // aspect or the page size.
  let cursor = height * 0.855;
  let logoDrawn = false;
  // The caller's bytes win; otherwise the bundled art (always
  // available at assembly time, per CG 2026-11-01).
  const logoBytes = info.logoPng || logoStackedPngBytes();
  if (logoBytes) {
    try {
      const img = await doc.embedPng(logoBytes);
      const targetW = Math.min(148, width * 0.32);
      const targetH = (img.height / img.width) * targetW;
      page.drawImage(img, { x: (width - targetW) / 2, y: cursor - targetH, width: targetW, height: targetH });
      cursor -= targetH;
      logoDrawn = true;
    } catch {
      logoDrawn = false;
    }
  }
  if (!logoDrawn) {
    const parts: Array<[string, any]> = [["BIG ", INK], ["BRAIN", ORANGE], [" SHELF", INK]];
    const size = 17;
    const total = parts.reduce((acc, [t]) => acc + bold.widthOfTextAtSize(t, size), 0);
    let x = Math.max(0, (width - total) / 2);
    for (const [t, color] of parts) {
      page.drawText(t, { x, y: cursor - size, size, font: bold, color });
      x += bold.widthOfTextAtSize(t, size);
    }
    cursor -= size;
  }

  cursor -= 24;
  const presents = "P R E S E N T S";
  page.drawText(presents, { x: centerX(presents, regular, 11), y: cursor, size: 11, font: regular, color: INK });

  // Title, wrapped to two lines at most.
  const title = cleanText(info.bookTitle || "").toUpperCase();
  if (title) {
    const lines = wrapLines(title, bold, 15, width * 0.78).slice(0, 2);
    lines.forEach((line, i) => {
      page.drawText(line, { x: centerX(line, bold, 15), y: cursor - 36 - i * 20, size: 15, font: bold, color: NAVY });
    });
    cursor = cursor - 36 - (lines.length - 1) * 20 - 14;
    const ruleW = 54;
    page.drawRectangle({ x: (width - ruleW) / 2, y: cursor, width: ruleW, height: 2.5, color: ORANGE });
  }

  const belongs = "This book belongs to";
  page.drawText(belongs, { x: centerX(belongs, regular, 16), y: cursor - 44, size: 16, font: regular, color: INK });

  // The name, or a blank write-in line when the family has no
  // reader profile yet: the page always prints (CG, 2026-11-01),
  // and a blank line invites them to write the name in by hand.
  const nameY = cursor - 44 - 52;
  if (name) {
    let nameSize = 46;
    while (nameSize > 18 && bold.widthOfTextAtSize(name, nameSize) > width * 0.82) nameSize -= 2;
    const nameW = bold.widthOfTextAtSize(name, nameSize);
    page.drawText(name, { x: Math.max(0, (width - nameW) / 2), y: nameY, size: nameSize, font: bold, color: ORANGE });
    page.drawRectangle({
      x: Math.max(0, (width - nameW) / 2),
      y: nameY - 16,
      width: nameW,
      height: 3,
      color: ORANGE,
    });
  } else {
    const lineW = width * 0.52;
    page.drawRectangle({ x: (width - lineW) / 2, y: nameY - 4, width: lineW, height: 2.5, color: ORANGE });
  }

  const blurbLines = wrapLines(DEDICATION_BLURB, oblique, 13.5, width * 0.68);
  blurbLines.forEach((line, i) => {
    page.drawText(line, { x: centerX(line, oblique, 13.5), y: nameY - 62 - i * 19, size: 13.5, font: oblique, color: INK });
  });

  const happy = "Happy reading!";
  page.drawText(happy, {
    x: centerX(happy, regular, 13),
    y: nameY - 62 - blurbLines.length * 19 - 14,
    size: 13,
    font: regular,
    color: INK,
  });

  // Footer: production date, then the two made-in lines.
  const foot: string[] = [];
  if (info.producedOn) foot.push(`Produced on ${cleanText(info.producedOn)}`);
  foot.push("Made in the USA", "Designed, assembled and packaged in Searcy, Arkansas");
  foot.forEach((line, i) => {
    page.drawText(line, {
      x: centerX(line, regular, 9.5),
      y: height * 0.115 - i * 14,
      size: 9.5,
      font: regular,
      color: FOOT_GRAY,
    });
  });
}

export async function stampPdfForBuyer(
  bytes: Uint8Array,
  info: PdfStampInfo
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const line = licensedLine(info);

  // Hidden markers in the document metadata.
  doc.setSubject(line);
  const keywords = [
    info.markerIsOrder ? `bbs-order:${info.marker}` : `bbs-grant:${info.marker}`,
    `bbs-buyer:${cleanText(info.email)}`,
  ];
  doc.setKeywords(keywords);

  const pages = doc.getPages();
  // Interior pages only: skip the front cover (first page) and the
  // back cover (last page), the same pages the brand footer skips.
  if (pages.length > 2) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const code = microtextCode(info);
    for (let p = 1; p < pages.length - 1; p++) {
      const page = pages[p];
      const width = page.getSize().width;
      const w = font.widthOfTextAtSize(line, 7);
      page.drawText(line, {
        x: Math.max(0, (width - w) / 2),
        y: FOOTER_Y,
        size: 7,
        font,
        color: FOOTER_GRAY,
      });
      // p is also the interior page number (the first interior page
      // is page index 1), so every 7th interior page gets the code.
      if (code && p % 7 === 0) {
        const cw = font.widthOfTextAtSize(code, 4.5);
        page.drawText(code, {
          x: Math.max(0, (width - cw) / 2),
          y: MICRO_Y,
          size: 4.5,
          font,
          color: MICRO_GRAY,
        });
      }
    }
  }
  // The dedication page goes in after the footer pass so it stays
  // clean front matter (inserted before save, at index 1). It
  // always prints: with no reader name on file the name line stays
  // blank for the family to fill in (CG, 2026-11-01).
  const name = dedicationName(info);
  try {
    await insertDedicationPage(doc, name, info);
  } catch {
    // A dedication must never break the stamp; the licensed copy
    // still ships without it.
  }
  return doc.save();
}
