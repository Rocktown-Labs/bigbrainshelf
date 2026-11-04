// PDF assembly with pdf-lib. US Letter portrait, images on top, text below.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Page art arrives as JPEG (Flux line art) or PNG (gateway color art)
// under the same keys, so embed by magic bytes, never by assumption.
async function embedImg(pdf: any, bytes: Uint8Array): Promise<any> {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  return isPng ? pdf.embedPng(bytes) : pdf.embedJpg(bytes);
}

const W = 612;
const H = 792;
const MARGIN = 56;

const NAVY = rgb(0.102, 0.204, 0.329);
const ORANGE = rgb(0.984, 0.573, 0.235);
const WHITE = rgb(1, 1, 1);
const GRAY = rgb(0.32, 0.32, 0.32);
const SKY = rgb(0.659, 0.839, 0.89);
const FOOTER_CLR = rgb(0.239, 0.408, 0.565);

// Interior footer (owner, 2026-10-29): every numbered content page of
// the story book and the coloring book carries a quiet footer in the
// bottom margin: the brand line at the left margin and the interior
// page number (first story/coloring page = 1) at the right margin.
// Baseline y=22 sits below every content element (story text ends
// well above it; the coloring caption baseline is y=40) and clear of
// the art, whose lowest edge is y=80 on coloring pages and higher on
// story pages. Covers and front/back matter (copyright, contents,
// glossary) are never stamped: the covers carry their own furniture
// and the back cover's barcode zone must stay clean.
const FOOTER_BRAND = "Big Brain Shelf · bigbrainshelf.com";
const FOOTER_GRAY = rgb(0.55, 0.55, 0.55);
const FOOTER_Y = 22;

function drawInteriorFooter(page: any, font: any, pageNum: number): void {
  page.drawText(FOOTER_BRAND, { x: MARGIN, y: FOOTER_Y, size: 8.5, font, color: FOOTER_GRAY });
  const label = String(pageNum);
  page.drawText(label, {
    x: W - MARGIN - font.widthOfTextAtSize(label, 10),
    y: FOOTER_Y,
    size: 10,
    font,
    color: FOOTER_GRAY,
  });
}

// Front/back matter composed from the bible (see matter.ts). backImage is
// the picture book's full-color back cover art; backLineImage is the B&W
// line-art version for the coloring book (a bonus coloring page).
export interface BookMatter {
  year: number;
  vocab: { term: string; storyName: string; definition: string }[];
  blurb: string;
  learn: string[];
  seriesLine?: string;
  ageLine: string;
  hook?: string;
  backImage: Uint8Array | null;
  backLineImage?: Uint8Array | null;
}

function wrap(text: string, font: any, size: number, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(t, size) <= maxW) {
      cur = t;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

async function drawStoryPage(
  pdf: any,
  font: any,
  bold: any,
  image: Uint8Array,
  text: string,
  pageNum?: number
): Promise<void> {
  const page = pdf.addPage([W, H]);
  const jpg = await embedImg(pdf, image);
  const maxImgW = W - MARGIN * 2;
  const maxImgH = H * 0.58;
  const scale = Math.min(maxImgW / jpg.width, maxImgH / jpg.height);
  const iw = jpg.width * scale;
  const ih = jpg.height * scale;
  page.drawImage(jpg, { x: (W - iw) / 2, y: H - 40 - ih, width: iw, height: ih });

  const lines = wrap(text, font, 15, W - MARGIN * 2 - 20);
  let y = H - 40 - ih - 48;
  for (const line of lines) {
    page.drawText(line, { x: MARGIN + 10, y, size: 15, font, color: rgb(0, 0, 0) });
    y -= 24;
  }
  if (pageNum) drawInteriorFooter(page, font, pageNum);
}

async function drawToc(pdf: any, bold: any, font: any, toc: string[]): Promise<void> {
  const page = pdf.addPage([W, H]);
  const heading = "Contents";
  page.drawText(heading, {
    x: (W - bold.widthOfTextAtSize(heading, 30)) / 2,
    y: H - 110,
    size: 30,
    font: bold,
    color: rgb(0.1, 0.2, 0.33),
  });
  let y = H - 170;
  toc.forEach((t, i) => {
    const lines = wrap(`${i + 1}.  ${t}`, font, 15, W - MARGIN * 2 - 40);
    for (const line of lines) {
      page.drawText(line, { x: MARGIN + 20, y, size: 15, font, color: rgb(0.15, 0.15, 0.15) });
      y -= 25;
    }
    y -= 7;
  });
}

async function drawCopyrightPage(pdf: any, font: any, bold: any, oblique: any, title: string, year: number): Promise<void> {
  const page = pdf.addPage([W, H]);
  const centered = (s: string, f: any, size: number) => (W - f.widthOfTextAtSize(s, size)) / 2;
  let y = H - 170;
  for (const line of wrap(title, bold, 22, W - MARGIN * 2)) {
    page.drawText(line, { x: centered(line, bold, 22), y, size: 22, font: bold, color: NAVY });
    y -= 30;
  }
  y -= 26;
  const copy = `© ${year} Big Brain Shelf`;
  page.drawText(copy, { x: centered(copy, bold, 13), y, size: 13, font: bold, color: rgb(0.15, 0.15, 0.15) });
  y -= 34;
  const rights =
    "All rights reserved. No part of this book may be reproduced, stored in a retrieval system, or transmitted in any form or by any means, without written permission from the publisher, except for brief quotations in a review.";
  for (const line of wrap(rights, font, 11.5, W - MARGIN * 2 - 60)) {
    page.drawText(line, { x: centered(line, font, 11.5), y, size: 11.5, font, color: GRAY });
    y -= 17;
  }
  y -= 16;
  const pub = "Big Brain Shelf · Searcy, Arkansas";
  page.drawText(pub, { x: centered(pub, font, 12), y, size: 12, font, color: rgb(0.15, 0.15, 0.15) });
  y -= 22;
  const ed = `First edition, ${year}.`;
  page.drawText(ed, { x: centered(ed, font, 12), y, size: 12, font, color: rgb(0.15, 0.15, 0.15) });
  y -= 40;
  const tag = "Every Big Brain Shelf book turns one real grown-up idea into a story little kids can follow, with the real words saved at the back for grown-ups to share.";
  for (const line of wrap(tag, oblique, 11.5, W - MARGIN * 2 - 60)) {
    page.drawText(line, { x: centered(line, oblique, 11.5), y, size: 11.5, font: oblique, color: GRAY });
    y -= 17;
  }
}

function drawGlossary(pdf: any, bold: any, font: any, vocab: BookMatter["vocab"]): void {
  if (!vocab.length) return;
  let page = pdf.addPage([W, H]);
  const heading = "Words to Know";
  page.drawText(heading, {
    x: (W - bold.widthOfTextAtSize(heading, 30)) / 2,
    y: H - 110,
    size: 30,
    font: bold,
    color: NAVY,
  });
  const sub = "The real words in this book, and what they are called in the story.";
  page.drawText(sub, {
    x: (W - font.widthOfTextAtSize(sub, 12.5)) / 2,
    y: H - 138,
    size: 12.5,
    font,
    color: GRAY,
  });
  let y = H - 185;
  for (const v of vocab) {
    const head = v.storyName ? `${v.term}: in the story, ${v.storyName}` : v.term;
    const headLines = wrap(head, bold, 14.5, W - MARGIN * 2);
    const defLines = v.definition ? wrap(v.definition, font, 12.5, W - MARGIN * 2 - 14) : [];
    const need = headLines.length * 21 + defLines.length * 18 + 14;
    if (y - need < 70) {
      page = pdf.addPage([W, H]);
      y = H - 110;
    }
    for (const line of headLines) {
      page.drawText(line, { x: MARGIN, y, size: 14.5, font: bold, color: rgb(0.12, 0.12, 0.12) });
      y -= 21;
    }
    for (const line of defLines) {
      page.drawText(line, { x: MARGIN + 14, y, size: 12.5, font, color: GRAY });
      y -= 18;
    }
    y -= 14;
  }
}

// Back cover design (house template, CG + Claude review, 2026-10-27):
// when the book has color back art, the back cover is a PAINTING, not a
// form: the art fills the page, an optional hook headline sits in the
// sky in the title treatment (white with navy outline), the blurb rides
// a cream panel as a story pitch, three framed sample pages from the
// book show the product, shorter bullets + a trust strip + a series
// line follow, and the footer matches the front exactly (steel band,
// navy pill centered). The barcode zone (x >= W-162, y <= 122) stays a
// clean white box, so left-column elements stop at x=450. Books with
// no color back art fall back to the banded layout (light blue story
// band, tan discover panel, steel footer).
const LIGHTBLUE = rgb(0.659, 0.839, 0.89);
const STEEL = rgb(0.239, 0.412, 0.565);
const TAN = rgb(0.937, 0.875, 0.729);
const CREAM = rgb(0.984, 0.953, 0.863);
const ZONE_BORDER = rgb(0.75, 0.75, 0.75);

function roundRect(page: any, x: number, y: number, w: number, h: number, r: number, color: any, opacity = 1): void {
  page.drawRectangle({ x: x + r, y, width: w - 2 * r, height: h, color, opacity });
  page.drawRectangle({ x, y: y + r, width: w, height: h - 2 * r, color, opacity });
  for (const [cx, cy] of [[x + r, y + r], [x + w - r, y + r], [x + r, y + h - r], [x + w - r, y + h - r]]) {
    page.drawCircle({ x: cx, y: cy, size: r, color, opacity });
  }
}
// (capStr, the back cover's text truncator, was deleted
// 2026-10-31: back-cover text is never cut. Blocks step their
// font size down until the full text fits, the same pattern the
// trust strip always used.)
function pick3<T>(items: T[]): T[] {
  if (items.length <= 3) return items.slice();
  return [items[0], items[Math.floor(items.length / 2)], items[items.length - 1]];
}

interface BackCoverOpts {
  samples?: Uint8Array[];
  hook?: string;
  trustLine?: string;
}

async function drawBackCover(pdf: any, font: any, bold: any, oblique: any, m: BookMatter, image: Uint8Array | null, opts?: BackCoverOpts): Promise<void> {
  if (m.backImage) {
    await drawBackCoverPainted(pdf, font, bold, oblique, m, opts);
  } else {
    await drawBackCoverBanded(pdf, font, bold, oblique, m);
  }
}

async function drawBackCoverPainted(pdf: any, font: any, bold: any, oblique: any, m: BookMatter, opts?: BackCoverOpts): Promise<void> {
  const page = pdf.addPage([W, H]);
  const INK = rgb(0.12, 0.12, 0.12);
  // The painting fills the page.
  const art = await embedImg(pdf, m.backImage!);
  {
    const s = Math.max(W / art.width, H / art.height);
    const w = art.width * s;
    const h = art.height * s;
    page.drawImage(art, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
  }
  // Barcode placeholder: the zone stays a clean white box.
  page.drawRectangle({ x: W - 162, y: 0, width: 162, height: 122, color: WHITE, borderColor: ZONE_BORDER, borderWidth: 0.75 });
  // Hook headline in the title treatment: white with a navy outline.
  const hook = opts?.hook ?? m.hook;
  if (hook) {
    const size = 33;
    let hy = H - 56;
    for (const line of wrap(hook, bold, size, 520)) {
      const tw = bold.widthOfTextAtSize(line, size);
      const x = (W - tw) / 2;
      for (const [dx, dy] of [[-1.7, 0], [1.7, 0], [0, -1.7], [0, 1.7], [-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) {
        page.drawText(line, { x: x + dx, y: hy + dy, size, font: bold, color: NAVY });
      }
      page.drawText(line, { x, y: hy, size, font: bold, color: WHITE });
      hy -= 42;
    }
  }
  // Blurb on a cream panel: full text, size steps down to fit
  // (the old loop silently dropped the lines that overflowed).
  roundRect(page, 30, 468, W - 60, 158, 14, CREAM, 0.94);
  {
    let bSize = 13;
    let bLines = wrap(m.blurb, font, bSize, W - 96);
    while (bLines.length * bSize * 1.5 > 118 && bSize > 10.5) {
      bSize -= 0.5;
      bLines = wrap(m.blurb, font, bSize, W - 96);
    }
    let y = 468 + 158 - 32;
    for (const line of bLines) {
      page.drawText(line, { x: 48, y, size: bSize, font, color: INK });
      y -= bSize * 1.5;
    }
  }
  // The product: three framed sample pages from the book.
  const samples = (opts?.samples ?? []).slice(0, 3);
  const centers: [number, number][] = [[112, 350], [306, 362], [500, 350]];
  for (let i = 0; i < samples.length; i++) {
    const img = await embedImg(pdf, samples[i]);
    const [cx, cy] = centers[i];
    const bw = 168;
    const bh = 205;
    const s = Math.min(bw / img.width, bh / img.height);
    const iw = img.width * s;
    const ih = img.height * s;
    page.drawRectangle({ x: cx - bw / 2 - 2, y: cy - bh / 2 - 9, width: bw + 18, height: bh + 18, color: rgb(0, 0, 0), opacity: 0.16 });
    page.drawRectangle({ x: cx - bw / 2 - 9, y: cy - bh / 2 - 9, width: bw + 18, height: bh + 18, color: WHITE });
    page.drawRectangle({ x: cx - bw / 2 - 9, y: cy - bh / 2 - 9, width: bw + 18, height: 3, color: NAVY });
    page.drawRectangle({ x: cx - bw / 2 - 9, y: cy + bh / 2 + 6, width: bw + 18, height: 3, color: NAVY });
    page.drawRectangle({ x: cx - bw / 2 - 9, y: cy - bh / 2 - 9, width: 3, height: bh + 18, color: NAVY });
    page.drawRectangle({ x: cx + bw / 2 + 6, y: cy - bh / 2 - 9, width: 3, height: bh + 18, color: NAVY });
    page.drawImage(img, { x: cx - iw / 2, y: cy - ih / 2, width: iw, height: ih });
  }
  // Bullets on a cream panel: full text, wrapped, size steps
  // down to fit (the old capStr cut every bullet at 76 chars
  // with "...", CG defect pass 2026-10-31).
  roundRect(page, 30, 120, W - 60, 112, 14, CREAM, 0.94);
  {
    let y = 120 + 112 - 28;
    if (m.learn.length) {
      page.drawText("In this book, kids discover:", { x: 48, y, size: 13.5, font: bold, color: NAVY });
      y -= 24;
      let lSize = 12.5;
      const wrappedAt = (size: number) =>
        m.learn.map((idea) => wrap(idea, font, size, W - 96 - 15));
      let wrapped = wrappedAt(lSize);
      const blockH = (ws: string[][], size: number) =>
        ws.reduce((a, ls) => a + ls.length * size * 1.35, 0) + (ws.length - 1) * 4;
      while (blockH(wrapped, lSize) > 74 && lSize > 9.5) {
        lSize -= 1;
        wrapped = wrappedAt(lSize);
      }
      for (const lines of wrapped) {
        lines.forEach((line, i) => {
          page.drawText(i === 0 ? `•  ${line}` : line, {
            x: i === 0 ? 48 : 63,
            y,
            size: lSize,
            font,
            color: INK,
          });
          y -= lSize * 1.35;
        });
        y -= 4;
      }
    }
  }
  // Trust strip.
  if (opts?.trustLine) {
    page.drawRectangle({ x: 30, y: 88, width: 420, height: 24, color: STEEL });
    let size = 10.5;
    while (bold.widthOfTextAtSize(opts.trustLine, size) > 404 && size > 7) size -= 0.5;
    const tw = bold.widthOfTextAtSize(opts.trustLine, size);
    page.drawText(opts.trustLine, { x: 30 + (420 - tw) / 2, y: 95, size, font: bold, color: WHITE });
  }
  // Series line chip.
  if (m.seriesLine) {
    roundRect(page, 30, 56, 420, 24, 10, CREAM, 0.94);
    let sSize = 10.5;
    while (oblique.widthOfTextAtSize(m.seriesLine, sSize) > 396 && sSize > 7.5) sSize -= 0.5;
    page.drawText(m.seriesLine, { x: 42, y: 63, size: sSize, font: oblique, color: INK });
  }
  // Footer: the front's treatment, steel band + navy pill centered.
  page.drawRectangle({ x: 0, y: 0, width: 450, height: 50, color: STEEL });
  drawPill(page, bold, W / 2 - pillWidth(bold) / 2, 4);
}

async function drawBackCoverBanded(pdf: any, font: any, bold: any, oblique: any, m: BookMatter): Promise<void> {
  const page = pdf.addPage([W, H]);
  const INK = rgb(0.12, 0.12, 0.12);
  // Light blue story band: y 462..H
  page.drawRectangle({ x: 0, y: 462, width: W, height: H - 462, color: LIGHTBLUE });
  let y = H - 68;
  for (const line of wrap(m.blurb, font, 14.5, W - MARGIN * 2)) {
    page.drawText(line, { x: MARGIN, y, size: 14.5, font, color: INK });
    y -= 22;
  }
  // Tan discover panel: y 126..462
  page.drawRectangle({ x: 0, y: 126, width: W, height: 462 - 126, color: TAN });
  y = 462 - 52;
  if (m.learn.length) {
    page.drawText("In this book, kids discover:", { x: MARGIN, y, size: 15, font: bold, color: NAVY });
    y -= 28;
    // Full bullets, wrapped; the size steps down until the whole
    // block fits above the series/age lines (the old loop silently
    // dropped the bullets that did not fit).
    let lSize = 13;
    const wrappedAt = (size: number) =>
      m.learn.map((idea) => wrap(idea, font, size, W - MARGIN * 2 - 15));
    let wrapped = wrappedAt(lSize);
    const need = (ws: string[][], size: number) =>
      ws.reduce((a, ls) => a + ls.length * size * 1.5 + 6, 0);
    while (y - need(wrapped, lSize) < 176 && lSize > 10.5) {
      lSize -= 1.25;
      wrapped = wrappedAt(lSize);
    }
    for (const lines of wrapped) {
      lines.forEach((line, i) => {
        page.drawText(i === 0 ? `•  ${line}` : line, {
          x: i === 0 ? MARGIN : MARGIN + 15,
          y,
          size: lSize,
          font,
          color: INK,
        });
        y -= lSize * 1.5;
      });
      y -= 6;
    }
  }
  if (m.seriesLine) {
    const lines = wrap(m.seriesLine, oblique, 13, W - MARGIN * 2);
    if (y - 10 - lines.length * 20 >= 140) {
      y -= 10;
      for (const line of lines) {
        page.drawText(line, { x: MARGIN, y, size: 13, font: oblique, color: INK });
        y -= 20;
      }
    }
  }
  y -= 6;
  if (y >= 140) page.drawText(m.ageLine, { x: MARGIN, y, size: 12.5, font, color: GRAY });
  // Steel footer band with the house pill, clear of the barcode zone.
  page.drawRectangle({ x: 0, y: 0, width: 450, height: 118, color: STEEL });
  drawPill(page, bold, MARGIN, 38);
}

// The house pill logo, drawn like the site header: navy pill, white
// wordmark, "brain" in orange. On covers it sits bottom-LEFT because
// the bottom RIGHT is the KDP barcode location: 2" x 1.2" (144 x 86.4
// pt), at least 0.25" (18 pt) from the trim, and KDP rejects covers
// with any image or text in that zone when they place the barcode.
// Keep the zone x >= W-162, y <= 122 completely empty.
const PILL_SEGS: { t: string; c: any }[] = [
  { t: "big", c: WHITE },
  { t: "brain", c: ORANGE },
  { t: "shelf", c: WHITE },
];
function pillWidth(bold: any): number {
  return PILL_SEGS.reduce((a, s) => a + bold.widthOfTextAtSize(s.t, 21), 0) + 76;
}

function drawPill(page: any, bold: any, px: number, py: number): void {
  const segs = PILL_SEGS;
  const size = 21;
  const textW = segs.reduce((a, s) => a + bold.widthOfTextAtSize(s.t, size), 0);
  const pillW = textW + 76;
  const pillH = 42;
  page.drawRectangle({ x: px, y: py, width: pillW, height: pillH, color: NAVY });
  page.drawCircle({ x: px, y: py + pillH / 2, size: pillH / 2, color: NAVY });
  page.drawCircle({ x: px + pillW, y: py + pillH / 2, size: pillH / 2, color: NAVY });
  let tx = px + (pillW - textW) / 2;
  const ty = py + pillH / 2 - size * 0.35;
  for (const s of segs) {
    page.drawText(s.t, { x: tx, y: ty, size, font: bold, color: s.c });
    tx += bold.widthOfTextAtSize(s.t, size);
  }
}

// The FINISHED front cover: the book's composed titled cover (the
// same image the store sells with, books/{slug}/cover-titled.jpg)
// drawn as the whole page. Letter-fit: scaled to page width, the
// small height overflow split between the top (solid sky band in
// the art) and the bottom (solid footer band), the split weighted
// to the top so the footer pill is never clipped (anchored and
// verified on Mira, 2026-10-31). This is the cover of record: the
// typeset furniture cover below it is only the fallback for a book
// whose titled cover does not exist yet. (CG defect pass,
// 2026-10-31: the typeset cover "sucks" next to the real one, and
// having two covers means they can disagree.)
async function drawFinishedCover(pdf: any, coverArt: Uint8Array): Promise<void> {
  const page = pdf.addPage([W, H]);
  const img = await embedImg(pdf, coverArt);
  const s = Math.max(W / img.width, H / img.height);
  const iw = img.width * s;
  const ih = img.height * s;
  // Overflow split: 74.5% of any height overflow falls off the top,
  // 25.5% off the bottom; width overflow centers.
  const y = ih > H ? -(ih - H) * 0.255 : (H - ih) / 2;
  page.drawImage(img, { x: (W - iw) / 2, y, width: iw, height: ih });
}

// The composed front cover, shared by the picture book and the
// coloring book: sky title band on top, footer band with the house
// pill at the bottom, and the color art COVER-FIT between them,
// bottom-anchored: it fills the slot edge to edge (the Fern style)
// and any overflow spills up under the sky band. The old full-bleed
// layout painted the band over the art's top, which decapitated
// whatever stood at the top of a scene (the crane on Wren's cover,
// 2026-10-24); cover art is now generated at cover aspect with
// clear sky across its top, so the spill is always sky. Bands are
// furniture zones; the pill never touches the art.
async function drawComposedCover(pdf: any, bold: any, title: string, coverArt: Uint8Array): Promise<void> {
  const page = pdf.addPage([W, H]);
  const BAND_H = 176;
  const FOOTER_H = 56;
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: SKY });
  const img = await embedImg(pdf, coverArt);
  const regionH = H - BAND_H - FOOTER_H;
  // Cover-fit, bottom-anchored: the art fills the region edge to edge
  // and any overflow spills UP, where the sky band (drawn after, over
  // the spill) hides it. Cover art is generated at cover aspect with
  // clear sky across its top, so the spill is always sky, never a
  // character. (Contain letterboxing left ugly side bars, 2026-10-24.)
  const s = Math.max(W / img.width, regionH / img.height);
  const iw = img.width * s;
  const ih = img.height * s;
  page.drawImage(img, { x: (W - iw) / 2, y: FOOTER_H, width: iw, height: ih });
  page.drawRectangle({ x: 0, y: H - BAND_H, width: W, height: BAND_H, color: SKY });
  page.drawRectangle({ x: 0, y: 0, width: W, height: FOOTER_H, color: FOOTER_CLR });
  const lines = wrap(title, bold, 38, W - MARGIN * 2);
  const blockH = lines.length * 48 - 10;
  let ty = H - (BAND_H - blockH) / 2 - 38;
  for (const line of lines) {
    const tw = bold.widthOfTextAtSize(line, 38);
    const tx = (W - tw) / 2;
    for (const [dx, dy] of [[-1.7, 0], [1.7, 0], [0, -1.7], [0, 1.7]] as const) {
      page.drawText(line, { x: tx + dx, y: ty + dy, size: 38, font: bold, color: NAVY });
    }
    page.drawText(line, { x: tx, y: ty, size: 38, font: bold, color: WHITE });
    ty -= 48;
  }
  // The pill lives in the footer band, bottom-left: branding never
  // touches the art, and the KDP barcode zone stays empty.
  drawPill(page, bold, MARGIN, 7);
}

// (fitCaption, the one-line caption ellipsizer, was deleted
// 2026-10-31: captions carry the full story text, wrapped. There
// is deliberately no truncating helper left in this file to
// reach for; text that does not fit steps its size down or the
// layout yields room, in that order.)

export async function buildColoringBook(
  title: string,
  pages: { image: Uint8Array; caption: string }[],
  toc?: string[],
  matter?: BookMatter,
  coverArt?: Uint8Array | null,
  composedCoverArt?: Uint8Array | null,
  expectedInventoryPages?: number,
  onPageCount?: (count: number) => void
): Promise<Uint8Array> {
  if (expectedInventoryPages !== undefined && pages.length !== expectedInventoryPages)
    throw new Error('PDF inputs do not reconcile to inventory');
  const pdf = await PDFDocument.create();
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const oblique = await pdf.embedFont(StandardFonts.HelveticaOblique);

  if (composedCoverArt) {
    await drawFinishedCover(pdf, composedCoverArt);
  } else if (coverArt) {
    await drawComposedCover(pdf, bold, title, coverArt);
  } else {
    const cover = pdf.addPage([W, H]);
    const titleLines = wrap(title, bold, 44, W - MARGIN * 2);
    let y = H / 2 + titleLines.length * 26;
    for (const line of titleLines) {
      const tw = bold.widthOfTextAtSize(line, 44);
      cover.drawText(line, { x: (W - tw) / 2, y, size: 44, font: bold });
      y -= 56;
    }
    const sub = "A Big Brain Shelf Coloring Book";
    cover.drawText(sub, {
      x: (W - font.widthOfTextAtSize(sub, 20)) / 2,
      y: y - 10,
      size: 20,
      font,
      color: rgb(0.25, 0.25, 0.25),
    });
  }

  if (matter) await drawCopyrightPage(pdf, font, bold, oblique, title, matter.year);

  if (toc?.length) await drawToc(pdf, bold, font, toc);

  const interiorStart = pdf.getPageCount();
  let coloringPageNum = 0;
  for (const p of pages) {
    coloringPageNum += 1;
    const page = pdf.addPage([W, H]);
    const jpg = await embedImg(pdf, p.image);
    // The page's FULL story text, wrapped under the art. Never
    // truncated: the one-line fitCaption this replaces ellipsized
    // 28 of Mira's 32 captions mid-sentence (CG defect pass,
    // 2026-10-31). The size steps down before the lines multiply,
    // and the art yields the room: caption block first, art in
    // what is left.
    const caption = String(p.caption ?? "").replace(/\s+/g, " ").trim();
    let capSize = 11.5;
    let capLines = wrap(caption, font, capSize, W - MARGIN * 2);
    while (capLines.length > 4 && capSize > 9.5) {
      capSize -= 1;
      capLines = wrap(caption, font, capSize, W - MARGIN * 2);
    }
    const capTop = 96;
    const artMaxH = H - 56 - (capTop + 14);
    const scale = Math.min((W - MARGIN * 2) / jpg.width, artMaxH / jpg.height);
    const iw = jpg.width * scale;
    const ih = jpg.height * scale;
    page.drawImage(jpg, { x: (W - iw) / 2, y: H - 56 - ih, width: iw, height: ih });
    let cy = capTop;
    for (const line of capLines) {
      page.drawText(line, {
        x: (W - font.widthOfTextAtSize(line, capSize)) / 2,
        y: cy,
        size: capSize,
        font,
        color: rgb(0.3, 0.3, 0.3),
      });
      cy -= capSize * 1.35;
    }
    drawInteriorFooter(page, font, coloringPageNum);
  }
  if (expectedInventoryPages !== undefined && pdf.getPageCount() - interiorStart !== expectedInventoryPages)
    throw new Error('PDF interior count does not reconcile to inventory');
  if (matter) {
    drawGlossary(pdf, bold, font, matter.vocab);
    const age = (matter.ageLine.match(/ages (.+)\./)?.[1] ?? "4 to 8").toUpperCase();
    const trustLine = `${pages.length} PAGES TO COLOR · AGES ${age} · WORDS TO KNOW FOR GROWN-UPS INSIDE`;
    await drawBackCover(pdf, font, bold, oblique, matter, matter.backLineImage ?? matter.backImage, {
      samples: pick3(pages.map((p) => p.image)),
      hook: matter.hook,
      trustLine,
    });
  }
  onPageCount?.(pdf.getPageCount());
  return pdf.save();
}

export async function buildPictureBook(
  title: string,
  pages: { image: Uint8Array; story: string }[],
  finale: { image: Uint8Array; story: string } | null,
  toc?: string[],
  matter?: BookMatter,
  coverArt?: Uint8Array | null,
  composedCoverArt?: Uint8Array | null,
  expectedInventoryPages?: number,
  onPageCount?: (count: number) => void
): Promise<Uint8Array> {
  if (expectedInventoryPages !== undefined && pages.length + (finale ? 1 : 0) !== expectedInventoryPages)
    throw new Error('PDF inputs do not reconcile to inventory');
  const pdf = await PDFDocument.create();
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const oblique = await pdf.embedFont(StandardFonts.HelveticaOblique);

  if (composedCoverArt) {
    await drawFinishedCover(pdf, composedCoverArt);
  } else if (coverArt) {
    // The composed cover: bands are furniture zones, art is contained
    // between them, never cropped and never covered.
    await drawComposedCover(pdf, bold, title, coverArt);
  } else {
    const cover = pdf.addPage([W, H]);
    const titleLines = wrap(title, bold, 40, W - MARGIN * 2);
    let y = H - 90;
    for (const line of titleLines) {
      const tw = bold.widthOfTextAtSize(line, 40);
      cover.drawText(line, { x: (W - tw) / 2, y, size: 40, font: bold });
      y -= 52;
    }
    y -= 24;
    const jpg0 = await embedImg(pdf, pages[0].image);
    const s0 = Math.min((W - MARGIN * 2) / jpg0.width, (y - 70) / jpg0.height);
    const iw0 = jpg0.width * s0;
    const ih0 = jpg0.height * s0;
    cover.drawImage(jpg0, { x: (W - iw0) / 2, y: y - ih0, width: iw0, height: ih0 });
  }

  if (matter) await drawCopyrightPage(pdf, font, bold, oblique, title, matter.year);

  if (toc?.length) await drawToc(pdf, bold, font, toc);
  const interiorStart = pdf.getPageCount();
  let storyPageNum = 0;
  for (const p of pages) {
    storyPageNum += 1;
    await drawStoryPage(pdf, font, bold, p.image, p.story, storyPageNum);
  }
  if (finale) {
    storyPageNum += 1;
    await drawStoryPage(pdf, font, bold, finale.image, finale.story, storyPageNum);
  }
  if (expectedInventoryPages !== undefined && pdf.getPageCount() - interiorStart !== expectedInventoryPages)
    throw new Error('PDF interior count does not reconcile to inventory');
  if (matter) {
    drawGlossary(pdf, bold, font, matter.vocab);
    const allPages = finale ? [...pages, finale] : pages;
    await drawBackCover(pdf, font, bold, oblique, matter, matter.backImage ?? matter.backLineImage ?? null, {
      samples: pick3(allPages.map((p) => p.image)),
      hook: matter.hook,
    });
  }
  onPageCount?.(pdf.getPageCount());
  return pdf.save();
}


/** Count current matter with the exact glossary layout; no book/PDF bytes are written. */
export async function expectedBookPageCount(interiorPages: number, chapterCount: number, vocab: BookMatter['vocab']): Promise<number> {
  if (!Number.isSafeInteger(interiorPages) || interiorPages < 0 || !Number.isSafeInteger(chapterCount) || chapterCount < 0)
    throw new Error('Invalid inventory count');
  const pdf = await PDFDocument.create();
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  drawGlossary(pdf, bold, font, vocab);
  // Front cover, copyright, optional contents, glossary, back cover.
  return interiorPages + 3 + (chapterCount ? 1 : 0) + pdf.getPageCount();
}
