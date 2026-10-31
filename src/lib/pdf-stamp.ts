// Per-buyer PDF stamping at download time (owner-approved protection
// plan, 2026-10-29): a file a buyer owns should be traceable back to
// its purchase without annoying the family who paid for it. When
// /api/download or /api/order-download serves a PDF, this pass adds:
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
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface PdfStampInfo {
  /** The buyer's email, printed on their own copy (the deterrent). */
  email: string;
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
  return doc.save();
}
