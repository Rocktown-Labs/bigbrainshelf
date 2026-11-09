// Composition similarity between a line master and a candidate color
// twin (CG, 2026-11-09). The gateway's image generation is not
// pixel-locked: given the master plus the character sheets as
// unlabeled references, the model can treat them as ingredients and
// recompose the scene (Tilda's back cover: Tilda moved from a branch
// onto a barrel that does not exist in the master, a burrow door and
// a crowd invented). Clef's cover QC asks nothing about composition,
// so the redraw passed. This metric is the missing check: a true
// paint-over keeps the master's edges where they are, a recomposition
// moves them.
//
// Method: decode both images (the purity module's decoder), reduce
// each to a 64x85 luminance grid, take gradient-magnitude edge maps,
// and score the Pearson correlation of the two maps. Color-invariant
// (luminance only) and size-invariant (fixed grid).
//
// Calibration (offline bench, 2026-11-09,
// factory-ops/audits/2026-11-09-twin-similarity-bench/): verified
// paint-over page pairs score 0.478-0.596; the recomposed Tilda cover
// rolls score 0.089-0.133; an unrelated scene scores -0.030. The bar
// sits in the empty middle of that gap.
import { decodePixels } from "./purity";

export const TWIN_SIMILARITY_BAR = 0.3;

const GRID_W = 64;
const GRID_H = 85;

function luminanceGrid(bytes: Uint8Array): Float64Array | null {
  const img = decodePixels(bytes);
  if (!img) return null;
  const { data, width, height } = img;
  const grid = new Float64Array(GRID_W * GRID_H);
  for (let gy = 0; gy < GRID_H; gy++) {
    const y0 = Math.floor((gy * height) / GRID_H);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / GRID_H));
    for (let gx = 0; gx < GRID_W; gx++) {
      const x0 = Math.floor((gx * width) / GRID_W);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / GRID_W));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        let idx = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++) {
          sum += 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
          idx += 4;
          n++;
        }
      }
      grid[gy * GRID_W + gx] = n ? sum / n / 255 : 0;
    }
  }
  return grid;
}

function edgeMap(grid: Float64Array): Float64Array {
  const out = new Float64Array(GRID_W * GRID_H);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const xm = x > 0 ? grid[y * GRID_W + x - 1] : grid[y * GRID_W + x];
      const xp = x < GRID_W - 1 ? grid[y * GRID_W + x + 1] : grid[y * GRID_W + x];
      const ym = y > 0 ? grid[(y - 1) * GRID_W + x] : grid[y * GRID_W + x];
      const yp = y < GRID_H - 1 ? grid[(y + 1) * GRID_W + x] : grid[y * GRID_W + x];
      out[y * GRID_W + x] = Math.hypot(xp - xm, yp - ym);
    }
  }
  return out;
}

function pearson(a: Float64Array, b: Float64Array): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den ? num / den : 0;
}

/** Edge-map Pearson correlation of candidate against master, or null
 *  when either image cannot be decoded (an unverifiable twin). */
export function twinSimilarity(master: Uint8Array, candidate: Uint8Array): number | null {
  const gm = luminanceGrid(master);
  const gc = luminanceGrid(candidate);
  if (!gm || !gc) return null;
  return pearson(edgeMap(gm), edgeMap(gc));
}
