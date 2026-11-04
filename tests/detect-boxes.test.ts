// Tests for the in-app pose box detection (src/lib/detect-boxes.ts),
// the TypeScript port of the extraction pipeline's detect_boxes
// (scripts/extract-cast-poses.py). The pipeline only ever ran
// offline; these pin the in-app port's behavior on synthetic sheets:
// poses found in reading order, caption specks filtered, blank
// sheets empty, and a shadow-chained pair split into two poses.
//
// Run with: bun tests/detect-boxes.test.ts
import UPNG from "upng-js";
import { detectPoseBoxes } from "../src/lib/detect-boxes";
import { decodeImage } from "../src/lib/crops";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const CREAM: [number, number, number] = [250, 246, 238];
const INK: [number, number, number] = [38, 42, 60];

interface Rect { x: number; y: number; w: number; h: number; color?: [number, number, number] }

function makeSheet(w: number, h: number, rects: Rect[]): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = CREAM[0]; data[i * 4 + 1] = CREAM[1]; data[i * 4 + 2] = CREAM[2]; data[i * 4 + 3] = 255;
  }
  for (const r of rects) {
    const c = r.color || INK;
    for (let y = r.y; y < Math.min(h, r.y + r.h); y++) {
      for (let x = r.x; x < Math.min(w, r.x + r.w); x++) {
        const k = (y * w + x) * 4;
        data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = 255;
      }
    }
  }
  return new Uint8Array(UPNG.encode([data.buffer as ArrayBuffer], w, h, 0));
}

function centerInside(box: { x: number; y: number; w: number; h: number }, rect: Rect, W: number, H: number) {
  const cx = (rect.x + rect.w / 2) / W;
  const cy = (rect.y + rect.h / 2) / H;
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
}

/* ---------- 2x2 grid: four poses, reading order ---------- */
const W = 800, H = 1000;
const grid: Rect[] = [
  { x: 60, y: 60, w: 200, h: 280 },   // top-left
  { x: 480, y: 70, w: 200, h: 280 },  // top-right
  { x: 70, y: 560, w: 200, h: 280 },  // bottom-left
  { x: 490, y: 550, w: 200, h: 280 }, // bottom-right
];
const boxes = detectPoseBoxes(decodeImage(makeSheet(W, H, grid)));
assert(boxes.length === 4, `grid: 4 poses detected (got ${boxes.length})`);
for (let i = 0; i < Math.min(4, boxes.length); i++) {
  assert(centerInside(boxes[i], grid[i], W, H), `grid: box ${i + 1} is the reading-order pose ${i + 1}`);
  const r = grid[i];
  assert(
    boxes[i].x <= r.x / W + 0.01 && boxes[i].y <= r.y / H + 0.01 &&
    boxes[i].x + boxes[i].w >= (r.x + r.w) / W - 0.01 &&
    boxes[i].y + boxes[i].h >= (r.y + r.h) / H - 0.01,
    `grid: box ${i + 1} contains its pose (padding included)`
  );
}

/* ---------- caption speck is filtered ---------- */
const withSpeck = detectPoseBoxes(decodeImage(makeSheet(W, H, [
  ...grid,
  { x: 350, y: 950, w: 46, h: 12 }, // a caption-like speck, far under the area floor
])));
assert(withSpeck.length === 4, `speck: caption filtered, still 4 poses (got ${withSpeck.length})`);

/* ---------- blank sheet ---------- */
const blank = detectPoseBoxes(decodeImage(makeSheet(400, 500, [])));
assert(blank.length === 0, `blank: no poses on an empty sheet (got ${blank.length})`);

/* ---------- shadow-chained pair splits in two ---------- */
const pair: Rect[] = [
  { x: 60, y: 200, w: 260, h: 380 },
  { x: 480, y: 200, w: 260, h: 380 },
  // a shared ground shadow band chaining the two poses together
  { x: 60, y: 540, w: 680, h: 16, color: [120, 118, 112] },
];
const split = detectPoseBoxes(decodeImage(makeSheet(W, H, pair)));
assert(split.length === 2, `chained pair: erosion split yields 2 poses (got ${split.length})`);
if (split.length === 2) {
  assert(centerInside(split[0], pair[0], W, H), "chained pair: first box is the left pose");
  assert(centerInside(split[1], pair[1], W, H), "chained pair: second box is the right pose");
}

if (failures) { console.error(failures + " FAILURES"); process.exit(1); }
console.log("ALL PASS");
