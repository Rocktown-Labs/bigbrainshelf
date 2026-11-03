// Line-art purity gate (factory reset, 2026-10-24; v2 gates, 2026-10-27).
//
// The base book is black-and-white line art ONLY. Color, flat color
// fills, and gray wash kept leaking into the "line" renders because the
// only gates were Clef's has_text and character_match questions: nothing
// ever measured whether a render was actually line art. Juno shipped
// with a solid navy bird, Wren with an orange beak, and nobody's metric
// noticed.
//
// v1 measured two fractions with a strict saturation definition
// ((max-min)/max > 0.35). Verified blind on 2026-10-26: every leaking
// page in Juno and Maisie PASSES the 2% bar under that definition,
// because the leaks are signature markings (a green patch, a gold key,
// pink ears) that cover a fraction of a percent of the frame, and
// Maisie's worst pages are muted color and flat GRAY fills, which a
// saturation ratio barely sees at all (one fully colored page measured
// satFrac 0.000%).
//
// v2 therefore measures three things on every pixel:
//   chromaFrac: pixels with real chroma (max-min > 40). Catches muted
//     color the saturation ratio missed. Clean pages sit at ~0.
//   midFillFrac: low-chroma pixels in the mid-luminance band. Catches
//     gray fills and washes, which are invisible to any color metric.
//   darkFrac: near-black pixels. Thin ink lines run 5-20% of a frame;
//     a solid filled character blows past 30%.
// And it can FIX the small leaks instead of re-rolling them: a page in
// the autofix band gets its chroma stripped and its midtones binarized
// (the deliverable is black-and-white line art, so this is lossless
// for the product), then it is re-measured. Filled characters and
// heavy color still reject. Thresholds were calibrated on the
// visually verified corpus (clean Mira/Fern/Juno pages vs the
// confirmed Juno/Maisie leaks) on 2026-10-27.

import UPNG from "upng-js";
import jpeg from "jpeg-js";
import { isPng } from "./transcode";

export interface DecodedPage {
  data: Uint8Array; // RGBA
  width: number;
  height: number;
  png: boolean;
}

export function decodePixels(bytes: Uint8Array): DecodedPage | null {
  try {
    const buf =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.slice().buffer as ArrayBuffer);
    if (isPng(bytes)) {
      const img: any = UPNG.decode(buf);
      if (!img?.width || !img?.height) return null;
      const frames = UPNG.toRGBA8(img);
      if (!frames?.length) return null;
      return { data: new Uint8Array(frames[0]), width: img.width, height: img.height, png: true };
    }
    const img: any = jpeg.decode(buf, { useTArray: true });
    if (!img?.data || !img.width) return null;
    return { data: new Uint8Array(img.data), width: img.width, height: img.height, png: false };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- legacy v1

export interface Purity {
  pure: boolean;
  satFrac: number;
  darkFrac: number;
  decoded: boolean;
}

const SAT_MAX = 0.02; // >2% colored pixels = not line art (v1 bar)
const DARK_MAX = 0.3; // >30% near-black pixels = filled, not lines

export function linePurity(bytes: Uint8Array): Purity {
  const a = analyzePage(bytes);
  if (!a.decoded) return { pure: true, satFrac: 0, darkFrac: 0, decoded: false };
  return {
    pure: a.satFrac <= SAT_MAX && a.darkFrac <= DARK_MAX,
    satFrac: a.satFrac,
    darkFrac: a.darkFrac,
    decoded: true,
  };
}

// ------------------------------------------------------------- v2 analysis

export interface PageAnalysis {
  decoded: boolean;
  width: number;
  height: number;
  chromaFrac: number;
  satFrac: number;
  midFillFrac: number;
  fillFrac: number;
  darkFrac: number;
}

export function analyzePage(bytes: Uint8Array): PageAnalysis {
  const dec = decodePixels(bytes);
  if (!dec) {
    return { decoded: false, width: 0, height: 0, chromaFrac: 0, satFrac: 0, midFillFrac: 0, fillFrac: 0, darkFrac: 0 };
  }
  const { data, width, height } = dec;
  // Fill detection: a gray FILL is a large contiguous midtone region,
  // while anti-aliasing is a thin midtone skin along the ink. Raw
  // midtone fraction cannot tell them apart (calibration: visually
  // clean Mira pages run 3-7% midtone from soft lines, Maisie's filled
  // pages 7-11%, ranges overlapping). So midtone is also accumulated
  // per 16px block, and fillFrac counts blocks that are mostly midtone.
  const BLOCK = 16;
  const blocksX = Math.ceil(width / BLOCK);
  const blocksY = Math.ceil(height / BLOCK);
  const blockMid = new Uint32Array(blocksX * blocksY);
  const blockTot = new Uint32Array(blocksX * blocksY);
  let total = 0;
  let chroma = 0;
  let sat = 0;
  let mid = 0;
  let dark = 0;
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    const blockRow = Math.floor(y / BLOCK) * blocksX;
    for (let x = 0; x < width; x++) {
      const i = (rowBase + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      total++;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const ch = mx - mn;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (ch > 40) chroma++;
      if (mx > 50 && ch / mx > 0.35) sat++;
      const bi = blockRow + Math.floor(x / BLOCK);
      blockTot[bi]++;
      if (lum < 70) dark++;
      else if (lum <= 210 && ch <= 40) {
        mid++;
        blockMid[bi]++;
      }
    }
  }
  if (!total) {
    return { decoded: false, width, height, chromaFrac: 0, satFrac: 0, midFillFrac: 0, fillFrac: 0, darkFrac: 0 };
  }
  let fillBlocks = 0;
  for (let bi = 0; bi < blockMid.length; bi++) {
    if (blockTot[bi] && blockMid[bi] / blockTot[bi] > 0.6) fillBlocks++;
  }
  return {
    decoded: true,
    width,
    height,
    chromaFrac: chroma / total,
    satFrac: sat / total,
    midFillFrac: mid / total,
    fillFrac: fillBlocks / (blocksX * blocksY),
    darkFrac: dark / total,
  };
}

// Calibrated 2026-10-27 against the verified corpus (see header).
// Chroma: clean pages measure 0.000-0.025%; signature-marking specks
// (the leaks worth auto-stripping) measure 0.18-1.01%; filled or
// heavily colored pages measure 1.27% and up.
export const CHROMA_CLEAN = 0.0005; // <= 0.05% chroma: clean
export const CHROMA_AUTOFIX_MAX = 0.011; // <= 1.1% chroma: strippable specks
export const FILL_CLEAN = 0.01; // <= 1% fill blocks: clean
export const FILL_AUTOFIX_MAX = 0.03; // <= 3% fill blocks: light wash only

export type PageVerdict = "clean" | "autofix" | "reject";

export function pageVerdict(a: PageAnalysis): { verdict: PageVerdict; reasons: string[] } {
  const reasons: string[] = [];
  if (!a.decoded) return { verdict: "clean", reasons }; // fail open; Clef still gates
  if (a.darkFrac > DARK_MAX) reasons.push(`dark fill ${(a.darkFrac * 100).toFixed(1)}% > 30%`);
  if (a.chromaFrac > CHROMA_AUTOFIX_MAX) reasons.push(`chroma ${(a.chromaFrac * 100).toFixed(2)}% > 1.1%`);
  if (a.fillFrac > FILL_AUTOFIX_MAX) reasons.push(`gray fill blocks ${(a.fillFrac * 100).toFixed(1)}% > 3%`);
  if (reasons.length) return { verdict: "reject", reasons };
  if (a.chromaFrac > CHROMA_CLEAN) reasons.push(`chroma specks ${(a.chromaFrac * 100).toFixed(3)}%`);
  if (a.fillFrac > FILL_CLEAN) reasons.push(`light fill blocks ${(a.fillFrac * 100).toFixed(2)}%`);
  if (reasons.length) return { verdict: "autofix", reasons };
  return { verdict: "clean", reasons };
}

// Strip chroma and binarize midtones in place, then re-encode in the
// source format. Colored pixels become black when dark (they were ink
// with a tint) and white when light (they were fill). Midtone pixels
// split at luminance 160: light wash becomes paper, dark gray becomes
// ink (and the dark-fraction gate then judges the result honestly).
export function purifyPage(bytes: Uint8Array): Uint8Array | null {
  const dec = decodePixels(bytes);
  if (!dec) return null;
  const { data, width, height } = dec;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (mx - mn > 15) {
      const out = mx < 140 ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = out;
    } else if (lum >= 70 && lum <= 210) {
      const out = lum >= 160 ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = out;
    }
  }
  try {
    if (dec.png) {
      const buf = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? (data.buffer as ArrayBuffer)
        : (data.slice().buffer as ArrayBuffer);
      const encoded: any = (UPNG as any).encode([buf], width, height, 0);
      return new Uint8Array(encoded);
    }
    const encoded: any = jpeg.encode({ data, width, height }, 92);
    return new Uint8Array(encoded.data);
  } catch {
    return null;
  }
}

// NOTE (2026-10-27): a colorize structure check via dark-mask IoU was
// calibrated against Fern's known-good and known-multiplied color
// pages and does NOT separate them (good 0.015-0.086, multiplied
// 0.005-0.079 on a 128x171 luminance<80 mask): the colorize artist
// re-renders rather than pixel-locking, so line positions drift on
// every page, good or bad. No mask gate is wired; multiplication
// defense stays with the cast-integrity QC and the cast-listing judge.
