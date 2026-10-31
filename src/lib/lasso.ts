// Lasso trace math for the cast crop editor's Erase mode.
//
// CG's ask: the cropper only knows rectangles, and the SAM
// click-to-remove mask hugs the inside of drawn lines, so a thin
// extremity near a removed region (a beak, a whisker, a tail tip)
// can get clipped. The lasso gives him manual boundary control:
// trace an outline that mixes straight polygon segments and
// freehand curves, close it, then erase inside it or outside it.
//
// Everything here is pure and DOM-free so it is unit-testable
// (tests/cast-lasso.test.ts): the point-capture model, the close
// test, polygon rasterization with a feathered edge, and the erase
// blend itself. The editor's canvas code consumes these functions
// through a small bundled script that exposes them as
// window.BbsLasso; rasterization happens at the pose's real pixel
// resolution, never the display size.
//
// Self-intersecting paths are HANDLED, not prevented: the fill uses
// the even-odd rule, so a crossed trace still produces a
// deterministic mask (crossed lobes alternate in/out) instead of
// corrupting the edit.

export interface LassoPoint {
  x: number;
  y: number;
}

/** One contribution to a path: a `vertex` is a single clicked point
 * (straight segment from the previous point), a `stroke` is a
 * freehand stretch captured during one drag (a polyline). "Undo
 * point" removes one whole contribution, so a drag comes off as one
 * piece, never point by point. */
export interface LassoContribution {
  kind: "vertex" | "stroke";
  points: LassoPoint[];
}

export interface LassoCapture {
  contributions: LassoContribution[];
  /** In-progress drag: pointer is down and may still become either
   * a click (no real movement) or a freehand stroke. */
  drag: { start: LassoPoint; points: LassoPoint[]; moved: boolean } | null;
}

export function createLassoCapture(): LassoCapture {
  return { contributions: [], drag: null };
}

function dist(a: LassoPoint, b: LassoPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Pointer pressed. Begins a potential drag; nothing is committed
 * until the pointer comes back up. */
export function lassoPointerDown(cap: LassoCapture, p: LassoPoint): void {
  cap.drag = { start: { x: p.x, y: p.y }, points: [{ x: p.x, y: p.y }], moved: false };
}

/** Pointer moved while down. Points closer than minDist to the last
 * captured one are dropped (decimation keeps the polygon lean).
 * Movement beyond dragThreshold (from the press point) turns the
 * press into a freehand stroke rather than a click.
 * Returns true when the preview needs a redraw. */
export function lassoPointerMove(
  cap: LassoCapture,
  p: LassoPoint,
  minDist = 2,
  dragThreshold = 4
): boolean {
  const drag = cap.drag;
  if (!drag) return false;
  if (!drag.moved && dist(drag.start, p) >= dragThreshold) drag.moved = true;
  if (!drag.moved) return false;
  const last = drag.points[drag.points.length - 1];
  if (dist(last, p) < minDist) return false;
  drag.points.push({ x: p.x, y: p.y });
  return true;
}

/** Pointer released: a press that never moved commits a single
 * vertex at the press point; a moved press commits its whole drag
 * as one freehand stroke contribution. */
export function lassoPointerUp(cap: LassoCapture): void {
  const drag = cap.drag;
  if (!drag) return;
  cap.drag = null;
  if (!drag.moved) {
    cap.contributions.push({ kind: "vertex", points: [drag.start] });
  } else if (drag.points.length >= 2) {
    cap.contributions.push({ kind: "stroke", points: drag.points });
  } else {
    cap.contributions.push({ kind: "vertex", points: [drag.start] });
  }
}

/** The path as a flat point list, including any in-progress drag
 * (for the live preview). Consecutive duplicate points are dropped.
 * The closing point is NOT repeated: polygon consumers close the
 * loop themselves. */
export function lassoPoints(cap: LassoCapture): LassoPoint[] {
  const out: LassoPoint[] = [];
  const push = (p: LassoPoint) => {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push({ x: p.x, y: p.y });
  };
  for (const c of cap.contributions) for (const p of c.points) push(p);
  if (cap.drag && cap.drag.moved) for (const p of cap.drag.points) push(p);
  return out;
}

/** Remove the last contribution (one vertex or one whole freehand
 * stretch). An in-progress drag is abandoned first. Returns false
 * when there was nothing to remove. */
export function lassoUndoLast(cap: LassoCapture): boolean {
  if (cap.drag) {
    cap.drag = null;
    return true;
  }
  return cap.contributions.pop() !== undefined;
}

export function lassoClear(cap: LassoCapture): void {
  cap.contributions = [];
  cap.drag = null;
}

export function lassoHasPath(cap: LassoCapture): boolean {
  return cap.contributions.length > 0 || (cap.drag !== null && cap.drag.moved);
}

/** A loop needs at least 3 distinct points to enclose anything. */
export function lassoCanClose(cap: LassoCapture): boolean {
  return lassoPoints(cap).length >= 3;
}

/** Close test: is p within tol pixels of the path's first point?
 * (Only meaningful once the path can close at all.) */
export function lassoNearStart(cap: LassoCapture, p: LassoPoint, tol = 10): boolean {
  const pts = lassoPoints(cap);
  if (pts.length < 3) return false;
  return dist(pts[0], p) <= tol;
}

/** Even-odd point-in-polygon test; the polygon closes implicitly. */
export function pointInPolygon(p: LassoPoint, poly: LassoPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Rasterize a closed polygon into a per-pixel strength mask
 * (Float32Array, w*h, row-major): 1 deep inside, 0 far outside,
 * with a smooth falloff across roughly 2*featherPx at the boundary
 * so a cut along the trace does not look scissored. featherPx = 0
 * gives a hard binary mask. Fill is scanline even-odd; the feather
 * is a separable box blur of the binary mask. */
export function rasterizeLassoMask(
  poly: LassoPoint[],
  w: number,
  h: number,
  featherPx = 2
): Float32Array {
  const mask = new Float32Array(w * h);
  if (poly.length < 3 || w <= 0 || h <= 0) return mask;
  // Scanline even-odd fill, sampling at pixel centers.
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > cy !== b.y > cy) {
        xs.push(((b.x - a.x) * (cy - a.y)) / (b.y - a.y) + a.x);
      }
    }
    if (xs.length < 2) continue;
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = x0; x <= x1; x++) mask[y * w + x] = 1;
    }
  }
  const r = Math.max(0, Math.round(featherPx));
  if (r === 0) return mask;
  // Two box-blur passes approximate a soft gaussian-ish falloff.
  return boxBlur(boxBlur(mask, w, h, r), w, h, r);
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / win;
      const xa = Math.max(0, x - r);
      const xb = Math.min(w - 1, x + r + 1);
      acc += src[y * w + xb] - src[y * w + xa];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win;
      const ya = Math.max(0, y - r);
      const yb = Math.min(h - 1, y + r + 1);
      acc += tmp[yb * w + x] - tmp[ya * w + x];
    }
  }
  return out;
}

/** Median color of an image's four corner patches: how the erase
 * tools (and the sheet shape cut) learn "the background" from the
 * picture itself instead of guessing a constant. Patch size follows
 * the editor's long-standing rule: up to 10px, never more than half
 * the smaller dimension. */
export function sampleCornerBackground(
  data: Uint8ClampedArray,
  w: number,
  h: number
): { r: number; g: number; b: number } {
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
  return { r: med(0), g: med(1), b: med(2) };
}

/** Pixel bounding box of a closed trace, clamped to the image:
 * floor of the minima, ceil of the maxima, so every traced pixel is
 * inside the box. Null when the path cannot enclose a region. */
export function shapeBoundingBox(
  poly: LassoPoint[],
  w: number,
  h: number
): { x0: number; y0: number; x1: number; y1: number } | null {
  if (poly.length < 3 || w <= 0 || h <= 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(minX)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(minY)));
  const x1 = Math.max(x0 + 1, Math.min(w, Math.ceil(maxX)));
  const y1 = Math.max(y0 + 1, Math.min(h, Math.ceil(maxY)));
  return { x0, y0, x1, y1 };
}

export interface SheetShapeCut {
  /** The cut region's pixels (RGBA), a fresh buffer: the source is
   * never mutated. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Where the region sat in the source image (pixels). */
  offsetX: number;
  offsetY: number;
}

/** The sheet-level shape cut: trace an outline ANYWHERE on a sheet
 * and make it a pose. The result is the trace's bounding-box region
 * of the source: pixels inside the trace are the source's exactly,
 * pixels outside it are filled with the sampled background color,
 * feathered ~featherPx at the boundary like every other cut in this
 * editor. This is the operation CG described: lasso around the
 * wing, cut it, fill the background with the background. */
export function cutSheetShape(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  poly: LassoPoint[],
  bg: { r: number; g: number; b: number },
  featherPx = 2
): SheetShapeCut | null {
  const bb = shapeBoundingBox(poly, w, h);
  if (!bb) return null;
  const rw = bb.x1 - bb.x0;
  const rh = bb.y1 - bb.y0;
  if (rw < 1 || rh < 1) return null;
  const region = new Uint8ClampedArray(rw * rh * 4);
  for (let y = 0; y < rh; y++) {
    const src = ((bb.y0 + y) * w + bb.x0) * 4;
    region.set(data.subarray(src, src + rw * 4), y * rw * 4);
  }
  const local = poly.map((p) => ({ x: p.x - bb.x0, y: p.y - bb.y0 }));
  const mask = rasterizeLassoMask(local, rw, rh, featherPx);
  applyLassoErase(region, rw, rh, mask, "outside", bg);
  return { data: region, width: rw, height: rh, offsetX: bb.x0, offsetY: bb.y0 };
}

/** Blend RGBA pixels toward the sampled background color along a
 * lasso mask. mode "inside": the traced region is erased (strength
 * = mask). mode "outside": everything EXCEPT the traced region is
 * erased (strength = 1 - mask), which is the keep-the-subject cut.
 * Alpha is left untouched: pose pictures are opaque cream-backed
 * PNGs. Mutates and returns data. */
export function applyLassoErase(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  mask: Float32Array,
  mode: "inside" | "outside",
  bg: { r: number; g: number; b: number }
): Uint8ClampedArray {
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const m = mask[i];
    const s = mode === "inside" ? m : 1 - m;
    if (s <= 0) continue;
    const k = i * 4;
    if (s >= 1) {
      data[k] = bg.r;
      data[k + 1] = bg.g;
      data[k + 2] = bg.b;
    } else {
      data[k] = data[k] * (1 - s) + bg.r * s;
      data[k + 1] = data[k + 1] * (1 - s) + bg.g * s;
      data[k + 2] = data[k + 2] * (1 - s) + bg.b * s;
    }
  }
  return data;
}
