// Pose box detection: propose one box per pose on a character sheet.
//
// This is an in-app port of the offline extraction pipeline's
// detection (scripts/extract-cast-poses.py: pose_mask + detect_boxes,
// the code that originally seeded every gallery box). The pipeline
// only ever ran by hand, offline, so the running app had no way to
// propose boxes: any sheet the pipeline never seeded opened in the
// croppers with zero boxes and every pose was hand work. This module
// runs the same algorithm server-side on the live sheet bytes:
//
//   foreground mask from a LOCAL background estimate (the sheet
//   downscaled to a coarse grid and back up, so gradients and paper
//   texture cancel; a pixel is foreground when its color distance
//   from that estimate beats the pipeline threshold, or it is
//   transparent), closing + opening to clean the mask, a dilation
//   pass that bridges hairline gaps inside one pose, connected
//   components filtered by area, an erosion split for a component
//   suspiciously larger than the median (poses chained together by
//   a shared shadow or a near-touch), then the pipeline's padding
//   rule and reading-order sort.
//
// The detection runs on a downscaled working copy (sheets are
// ~900-1600px; the mask math does not need full resolution), with
// areas scaled to match. Boxes come back as sheet fractions in
// reading order, capped at the gallery's 12-pose limit. Detection
// only PROPOSES: nothing here writes anything, and the croppers
// stage the boxes as unsaved work for the admin to adjust, tag,
// and save.

import { sortBoxesReadingOrder, type GalleryBox } from "./cast-gallery";

// Pipeline constants (scripts/extract-cast-poses.py), with the area
// floor scaled by the working resolution below.
const DIST_THRESHOLD = 26; // max-channel color distance from local bg
const MIN_AREA_FULLRES = 6500; // mask px at full res; filters captions/specks
const SPLIT_AREA_FULLRES = 100_000;
const MAX_BOXES = 12;
const WORK_MAX_DIM = 640;

export interface DecodedImage {
  data: Uint8Array; // RGBA
  width: number;
  height: number;
}

interface WorkImage {
  // Downscaled RGB + alpha, row-major, w*h entries per channel plane
  // packed as RGBA quads exactly like the source.
  data: Uint8Array;
  w: number;
  h: number;
  scale: number; // full-res px per working px
}

function downscale(img: DecodedImage): WorkImage {
  const scale = Math.max(1, Math.max(img.width, img.height) / WORK_MAX_DIM);
  const w = Math.max(1, Math.round(img.width / scale));
  const h = Math.max(1, Math.round(img.height / scale));
  const data = new Uint8Array(w * h * 4);
  const cell = Math.max(1, Math.floor(scale));
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(img.height - cell, Math.floor(y * scale));
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(img.width - cell, Math.floor(x * scale));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < Math.min(img.height, y0 + cell); yy++) {
        for (let xx = x0; xx < Math.min(img.width, x0 + cell); xx++) {
          const k = (yy * img.width + xx) * 4;
          r += img.data[k]; g += img.data[k + 1]; b += img.data[k + 2]; a += img.data[k + 3];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      data[o] = Math.round(r / n); data[o + 1] = Math.round(g / n);
      data[o + 2] = Math.round(b / n); data[o + 3] = Math.round(a / n);
    }
  }
  return { data, w, h, scale: img.width / w };
}

// Foreground mask: per-pixel distance from a background estimate.
// Two estimates, either one marking foreground:
//   local: the working image averaged into a coarse grid (the
//     pipeline's 28x38 resize trick), each pixel compared against
//     a bilinear blend of its cell averages. Alone this hollows out
//     big poses (their centers ARE the local average), leaving ring
//     masks that fragment at working resolution.
//   global: the corner-sampled paper color, with a wider threshold.
//     Our sheets sit on clean, near-uniform paper, so this fills
//     pose interiors solidly while the local term keeps catching
//     shading and edges the global term would miss.
const GLOBAL_DIST_THRESHOLD = 60;

function cornerBackground(data: Uint8Array, w: number, h: number): [number, number, number] {
  const p = Math.max(1, Math.min(10, Math.floor(Math.min(w, h) / 2)));
  const px: number[][] = [];
  const corners: [number, number][] = [[0, 0], [w - p, 0], [0, h - p], [w - p, h - p]];
  for (const [cx, cy] of corners) {
    for (let y = cy; y < cy + p; y++) {
      for (let x = cx; x < cx + p; x++) {
        const k = (y * w + x) * 4;
        px.push([data[k], data[k + 1], data[k + 2]]);
      }
    }
  }
  const med = (c: number) => {
    const vals = px.map((v) => v[c]).sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  };
  return [med(0), med(1), med(2)];
}

export function poseMask(img: WorkImage): Uint8Array {
  const { data, w, h } = img;
  const gw = Math.max(1, Math.min(28, w));
  const gh = Math.max(1, Math.min(38, h));
  const cellW = w / gw;
  const cellH = h / gh;
  const bg = new Float32Array(gw * gh * 3);
  const counts = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / cellH));
    for (let x = 0; x < w; x++) {
      const gx = Math.min(gw - 1, Math.floor(x / cellW));
      const k = (y * w + x) * 4;
      const c = (gy * gw + gx) * 3;
      bg[c] += data[k]; bg[c + 1] += data[k + 1]; bg[c + 2] += data[k + 2];
      counts[gy * gw + gx]++;
    }
  }
  for (let i = 0; i < gw * gh; i++) {
    const n = counts[i] || 1;
    bg[i * 3] /= n; bg[i * 3 + 1] /= n; bg[i * 3 + 2] /= n;
  }
  const paper = cornerBackground(data, w, h);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    // Bilinear blend of the four surrounding cell averages.
    const fy = Math.max(0, Math.min(gh - 1.001, y / cellH - 0.5));
    const gy0 = Math.floor(fy);
    const gy1 = Math.min(gh - 1, gy0 + 1);
    const ty = fy - gy0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(gw - 1.001, x / cellW - 0.5));
      const gx0 = Math.floor(fx);
      const gx1 = Math.min(gw - 1, gx0 + 1);
      const tx = fx - gx0;
      const k = (y * w + x) * 4;
      let localDist = 0;
      let globalDist = 0;
      for (let ch = 0; ch < 3; ch++) {
        const top = bg[(gy0 * gw + gx0) * 3 + ch] * (1 - tx) + bg[(gy0 * gw + gx1) * 3 + ch] * tx;
        const bot = bg[(gy1 * gw + gx0) * 3 + ch] * (1 - tx) + bg[(gy1 * gw + gx1) * 3 + ch] * tx;
        const est = top * (1 - ty) + bot * ty;
        localDist = Math.max(localDist, Math.abs(data[k + ch] - est));
        globalDist = Math.max(globalDist, Math.abs(data[k + ch] - paper[ch]));
      }
      mask[y * w + x] =
        localDist > DIST_THRESHOLD || globalDist > GLOBAL_DIST_THRESHOLD || data[k + 3] < 128 ? 1 : 0;
    }
  }
  return mask;
}

function morph(mask: Uint8Array, w: number, h: number, size: number, dilate: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  const r = size === 3 ? 1 : 0; // 3x3 neighborhood, or the 2x2 anchored at (x,y)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let any = false;
      let all = true;
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
          const nx = x + dx - r;
          const ny = y + dy - r;
          const v = nx >= 0 && nx < w && ny >= 0 && ny < h ? mask[ny * w + nx] : 0;
          if (v) any = true; else all = false;
        }
      }
      out[y * w + x] = dilate ? (any ? 1 : 0) : (all ? 1 : 0);
    }
  }
  return out;
}

const dilate3 = (m: Uint8Array, w: number, h: number) => morph(m, w, h, 3, true);
const erode3 = (m: Uint8Array, w: number, h: number) => morph(m, w, h, 3, false);

// Connected components (8-connectivity) over a 0/1 mask. Returns the
// label grid (0 = background) and the component count.
function labelComponents(mask: Uint8Array, w: number, h: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(w * h);
  let count = 0;
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i]) continue;
    count++;
    labels[i] = count;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w;
      const py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = count;
            stack.push(q);
          }
        }
      }
    }
  }
  return { labels, count };
}

// The pipeline's erosion split for a component that looks like two
// poses chained together: erode until it separates into pieces that
// are each big enough, then grow the pieces back over the original
// component, every pixel to its nearest seed. Returns per-piece
// masks, or null when no clean split exists.
function erodeSplit(
  sub: Uint8Array,
  w: number,
  h: number,
  minArea: number
): Uint8Array[] | null {
  let eroded = sub;
  for (let iter = 0; iter < 24; iter++) {
    eroded = erode3(eroded, w, h);
    let remaining = 0;
    for (let i = 0; i < eroded.length; i++) remaining += eroded[i];
    if (remaining === 0) return null;
    const { labels, count } = labelComponents(eroded, w, h);
    if (count < 2) continue;
    const areas = new Array<number>(count + 1).fill(0);
    for (let i = 0; i < labels.length; i++) if (labels[i]) areas[labels[i]]++;
    const keep = new Set<number>();
    for (let c = 1; c <= count; c++) if (areas[c] >= minArea) keep.add(c);
    if (keep.size < 2) continue;
    // Grow the kept seeds back over the component's own pixels.
    const grown = new Int32Array(w * h);
    const queue: number[] = [];
    for (let i = 0; i < eroded.length; i++) {
      if (labels[i] && keep.has(labels[i])) {
        grown[i] = labels[i];
        queue.push(i);
      }
    }
    let head = 0;
    while (head < queue.length) {
      const p = queue[head++];
      const px = p % w;
      const py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const q = ny * w + nx;
          if (sub[q] && !grown[q]) {
            grown[q] = grown[p];
            queue.push(q);
          }
        }
      }
    }
    const pieces: Uint8Array[] = [];
    for (const c of keep) {
      const m = new Uint8Array(w * h);
      let area = 0;
      for (let i = 0; i < grown.length; i++) {
        if (grown[i] === c) { m[i] = 1; area++; }
      }
      if (area >= minArea) pieces.push(m);
    }
    return pieces.length >= 2 ? pieces : null;
  }
  return null;
}

/** Detect pose boxes on one decoded character sheet. Returns boxes
 * as sheet fractions in reading order (possibly empty). */
export function detectPoseBoxes(img: DecodedImage): GalleryBox[] {
  const work = downscale(img);
  const { w, h } = work;
  const areaScale = 1 / (work.scale * work.scale);
  const minArea = MIN_AREA_FULLRES * areaScale;

  let mask = poseMask(work);
  // binary closing (3x3), then opening (2x2): the pipeline's cleanup.
  mask = erode3(dilate3(mask, w, h), w, h);
  mask = dilate3(erode3(mask, w, h), w, h);

  // Dilation bridges hairline gaps inside one pose before labeling;
  // component AREAS are still measured on the raw mask.
  let dil = mask;
  for (let i = 0; i < 3; i++) dil = dilate3(dil, w, h);
  const { labels, count } = labelComponents(dil, w, h);
  if (!count) return [];

  const rawAreas = new Array<number>(count + 1).fill(0);
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] && mask[i]) rawAreas[labels[i]]++;
  }
  const clusters: number[] = [];
  for (let c = 1; c <= count; c++) if (rawAreas[c] >= minArea) clusters.push(c);
  if (!clusters.length) return [];
  const sortedAreas = clusters.map((c) => rawAreas[c]).sort((a, b) => a - b);
  const medianArea = sortedAreas[Math.floor(sortedAreas.length / 2)];

  const poseMasks: Uint8Array[] = [];
  for (const c of clusters) {
    const sub = new Uint8Array(w * h);
    for (let i = 0; i < labels.length; i++) if (labels[i] === c && mask[i]) sub[i] = 1;
    const suspicious =
      rawAreas[c] > 1.45 * medianArea ||
      (clusters.length <= 2 && rawAreas[c] > SPLIT_AREA_FULLRES * areaScale);
    const grown = suspicious ? erodeSplit(sub, w, h, minArea) : null;
    if (grown) poseMasks.push(...grown);
    else poseMasks.push(sub);
  }

  const boxes: GalleryBox[] = [];
  for (const pm of poseMasks) {
    let area = 0;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!pm[y * w + x]) continue;
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (area < minArea || x1 < 0) continue;
    // Working px -> full-res px -> the pipeline's padded crop region.
    const fx0 = x0 * work.scale;
    const fy0 = y0 * work.scale;
    const fx1 = (x1 + 1) * work.scale;
    const fy1 = (y1 + 1) * work.scale;
    const pad = 0.04 * Math.max(fx1 - fx0, fy1 - fy0) + 6;
    const cx0 = Math.max(0, fx0 - pad);
    const cy0 = Math.max(0, fy0 - pad);
    const cx1 = Math.min(img.width, fx1 + pad);
    const cy1 = Math.min(img.height, fy1 + pad);
    boxes.push({
      x: cx0 / img.width,
      y: cy0 / img.height,
      w: (cx1 - cx0) / img.width,
      h: (cy1 - cy0) / img.height,
    });
  }
  if (!boxes.length) return [];
  return sortBoxesReadingOrder(boxes).slice(0, MAX_BOXES).map((o) => o.box);
}
