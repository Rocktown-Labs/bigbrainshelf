// Tests for the cropper's staged batch save (createCropsBatch in
// src/lib/crops.ts). Contract pinned here: a batch of staged crops
// lands with ONE manifest write; pose numbers keep growing inside
// the batch; a bad item is reported per item and never blocks the
// rest; and what the batch wrote is exactly what a fresh manifest
// read returns afterwards (read-after-write persistence proof).
//
// Run with: bun tests/crops-batch.test.ts
import UPNG from "upng-js";
import {
  createCropsBatch, getCropsManifest, isPng,
  type BatchSheet,
} from "../src/lib/crops";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

function fakeBooks() {
  const store = new Map<string, Uint8Array>();
  let manifestWrites = 0;
  return {
    store,
    get manifestWrites() { return manifestWrites; },
    async get(key: string) {
      const data = store.get(key);
      if (!data) return null;
      return {
        async text() { return new TextDecoder().decode(data); },
        async arrayBuffer() { return data.slice().buffer as ArrayBuffer; },
      };
    },
    async put(key: string, value: any) {
      if (key.endsWith("crops.json")) manifestWrites++;
      if (typeof value === "string") store.set(key, new TextEncoder().encode(value));
      else if (value instanceof ArrayBuffer) store.set(key, new Uint8Array(value));
      else store.set(key, new Uint8Array(value));
    },
    async delete(key: string) { store.delete(key); },
    async head(key: string) { return store.has(key) ? {} : null; },
  };
}

// One synthetic sheet: cream paper, one dark pose block.
function makeSheetPng(): Uint8Array {
  const w = 400, h = 400;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      const inPose = x >= 100 && x < 300 && y >= 80 && y < 320;
      data[k] = inPose ? 40 : 250;
      data[k + 1] = inPose ? 44 : 246;
      data[k + 2] = inPose ? 62 : 238;
      data[k + 3] = 255;
    }
  }
  return new Uint8Array(UPNG.encode([data.buffer as ArrayBuffer], w, h, 0));
}

const sheet = makeSheetPng();
const sheets = new Map<string, BatchSheet>([
  ["fern", { name: "Fern", sheetKey: "library/characters/algorithms/fern-sheet.jpg", bytes: sheet }],
  ["moss", { name: "Moss", sheetKey: "library/characters/algorithms/moss-sheet.jpg", bytes: sheet }],
  ["orin", { name: "Orin", sheetKey: null, bytes: null }],
]);

const books = fakeBooks();
const box = { x: 0.2, y: 0.15, w: 0.55, h: 0.65 };
const { created, errors } = await createCropsBatch(books as any, "algorithms", [
  { character: "Fern", action: "standing", bbox: box },
  { character: "Fern", action: "standing", bbox: { ...box, x: 0.3 } },
  { character: "moss", action: "Sitting", bbox: box },
  { character: "Nobody", action: "standing", bbox: box },
  { character: "Fern", action: "", bbox: box },
  { character: "Orin", action: "standing", bbox: box },
  { character: "Fern", action: "flying", bbox: { x: 0.1, y: 0.1, w: 0.001, h: 0.001 } },
], sheets);

assert(created.length === 3, `batch: 3 crops created (got ${created.length})`);
assert(
  created.map((c) => c.tag).join(",") === "fern-p1-standing,fern-p2-standing,moss-p1-sitting",
  `batch: pose numbers grow inside the batch (got ${created.map((c) => c.tag).join(",")})`
);
assert(errors.length === 4, `batch: 4 per-item errors (got ${errors.length})`);
assert(errors.some((e) => e.index === 3 && /no character 'Nobody'/.test(e.error)), "batch: unknown character reported per item");
assert(errors.some((e) => e.index === 4 && /action tag is required/.test(e.error)), "batch: missing action reported per item");
assert(errors.some((e) => e.index === 5 && /no sheet on file for Orin/.test(e.error)), "batch: sheetless character reported per item");
assert(errors.some((e) => e.index === 6 && /crop failed/.test(e.error)), "batch: sliver crop reported per item");
assert(books.manifestWrites === 1, `batch: exactly one manifest write (got ${books.manifestWrites})`);

/* ---------- read-after-write: the manifest IS the proof ---------- */
const readBack = await getCropsManifest(books as any, "algorithms");
assert(
  readBack.map((c) => c.tag).join(",") === "fern-p1-standing,fern-p2-standing,moss-p1-sitting",
  "persist: fresh manifest read returns exactly the batch's crops"
);
for (const entry of readBack) {
  const bytes = books.store.get(entry.key);
  assert(!!bytes && isPng(bytes), `persist: ${entry.tag} PNG stored at its manifest key`);
  assert(entry.key === `books/algorithms/crops/${entry.tag}.png`, `persist: ${entry.tag} key follows the factory contract`);
}

/* ---------- a second batch continues the numbering ---------- */
const second = await createCropsBatch(books as any, "algorithms", [
  { character: "Fern", action: "standing", bbox: box },
], sheets);
assert(second.created.length === 1 && second.created[0].tag === "fern-p3-standing",
  `persist: second batch continues at p3 (got ${second.created[0]?.tag})`);
const finalRead = await getCropsManifest(books as any, "algorithms");
assert(finalRead.length === 4, `persist: manifest now holds all 4 crops (got ${finalRead.length})`);

if (failures) { console.error(failures + " FAILURES"); process.exit(1); }
console.log("ALL PASS");
