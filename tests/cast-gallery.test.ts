// Focused tests for the cast gallery crop editor logic
// (src/lib/cast-gallery.ts).
//
// Contract pinned here: boxes are fractions of the source sheet and a
// box is the EXACT region cropped into its pose PNG (pixel origin =
// round(fraction * dimension), the convention the boxes were derived
// with); saves renumber poses in reading order, keep the starred box
// as the portrait, back the whole previous gallery up first, and a
// restore returns the previous pose bytes byte-for-byte.
//
// Run with: bun tests/cast-gallery.test.ts
import UPNG from "upng-js";
import {
  bakedManifest,
  loadCastGallery,
  invalidateCastGalleryCache,
  saveCharacterGallery,
  restoreCharacterGallery,
  latestBackup,
  sortBoxesReadingOrder,
  validBoxes,
  versioned,
  cropSheetBox,
  normalizePoseMeta,
  focalFor,
  objectPosition,
  mirrorGalleryTags,
} from "../src/lib/cast-gallery";
import { decodeImage } from "../src/lib/crops";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
function eq(a: any, b: any) { return JSON.stringify(a) === JSON.stringify(b); }

/* ---------- baked manifest carries boxes ---------- */
const baked = bakedManifest();
const slugs = Object.keys(baked.characters);
assert(slugs.length === 28, `baked: 28 gallery characters (got ${slugs.length})`); // 27 registered + the Otter, generated 2026-10-28
let boxesOk = true;
for (const s of slugs) {
  const e = baked.characters[s];
  if (!Array.isArray(e.boxes) || e.boxes.length !== e.poseCount) boxesOk = false;
  if (!e.sheetSize || !e.sheetKey) boxesOk = false;
}
assert(boxesOk, "baked: every entry has boxes matching poseCount, sheetSize, sheetKey");
assert(baked.characters["bix"].sheetKey === "characters/bix.png", "baked: bix sheetKey normalized to the bucket sheet");

/* ---------- pure helpers ---------- */
const sorted = sortBoxesReadingOrder([
  { x: 0.55, y: 0.55, w: 0.3, h: 0.35 }, // row 2, right  -> pose 4
  { x: 0.05, y: 0.05, w: 0.3, h: 0.35 }, // row 1, left   -> pose 1
  { x: 0.55, y: 0.08, w: 0.3, h: 0.35 }, // row 1, right  -> pose 2
  { x: 0.05, y: 0.55, w: 0.3, h: 0.35 }, // row 2, left   -> pose 3
]);
assert(eq(sorted.map((s) => s.from), [1, 2, 3, 0]), "sort: reading order groups rows then left-to-right");
assert(validBoxes([{ x: 0, y: 0, w: 0.5, h: 0.5 }]) !== null, "validBoxes: a good box passes");
assert(validBoxes([]) === null, "validBoxes: empty rejected");
assert(validBoxes([{ x: 0, y: 0, w: 0.001, h: 0.5 }]) === null, "validBoxes: sliver rejected");
assert(validBoxes([{ x: 0, y: 0, w: "a", h: 0.5 }]) === null, "validBoxes: non-number rejected");
assert(validBoxes(Array.from({ length: 13 }, () => ({ x: 0, y: 0, w: 0.2, h: 0.2 }))) === null, "validBoxes: >12 rejected");
const clamped = validBoxes([{ x: -0.5, y: 0.9, w: 0.8, h: 0.8 }])![0];
assert(clamped.x === 0 && clamped.x + clamped.w <= 1 && clamped.y + clamped.h <= 1, "validBoxes: out-of-range clamped into the sheet");
assert(versioned("https://x/pose-1.png", 3) === "https://x/pose-1.png?v=3", "versioned: appends ?v=");
assert(versioned("https://x/pose-1.png", undefined) === "https://x/pose-1.png", "versioned: no version, no suffix");

/* ---------- synthetic sheet + crop convention ---------- */
function makeSheetPng(): Uint8Array {
  // 200x100, left half red, right half blue.
  const w = 200, h = 100;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x < 100) { data[i] = 220; data[i + 1] = 30; data[i + 2] = 30; }
      else { data[i] = 30; data[i + 1] = 30; data[i + 2] = 220; }
      data[i + 3] = 255;
    }
  }
  return new Uint8Array(UPNG.encode([data.buffer as ArrayBuffer], w, h, 0));
}
const sheetPng = makeSheetPng();
const right = cropSheetBox(sheetPng, { x: 0.5, y: 0, w: 0.5, h: 1 });
assert(right.px.x === 100 && right.px.w === 100 && right.sheetSize.w === 200, "crop: round() pixel convention");
const rightDecoded = decodeImage(right.png);
const mid = ((50 * rightDecoded.width + 50) * 4);
assert(rightDecoded.data[mid + 2] === 220 && rightDecoded.data[mid] === 30, "crop: right-half crop is the blue half");

/* ---------- fake BOOKS + save/restore round trip ---------- */
function fakeBooks(seed: Record<string, Uint8Array | string>) {
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(seed)) {
    store.set(k, typeof v === "string" ? new TextEncoder().encode(v) : v);
  }
  return {
    store,
    async get(key: string) {
      const data = store.get(key);
      if (!data) return null;
      return {
        async text() { return new TextDecoder().decode(data); },
        async arrayBuffer() { return data.slice().buffer as ArrayBuffer; },
      };
    },
    async put(key: string, value: any) {
      if (typeof value === "string") store.set(key, new TextEncoder().encode(value));
      else if (value instanceof ArrayBuffer) store.set(key, new Uint8Array(value));
      else store.set(key, new Uint8Array(value));
    },
    async delete(key: string) { store.delete(key); },
    async list(opts: { prefix: string }) {
      const objects = [...store.keys()].filter((k) => k.startsWith(opts.prefix)).map((key) => ({ key }));
      return { objects, truncated: false };
    },
  };
}

const origPose1 = new TextEncoder().encode("ORIGINAL-POSE-1");
const origPose2 = new TextEncoder().encode("ORIGINAL-POSE-2");
const origPortrait = new TextEncoder().encode("ORIGINAL-PORTRAIT");
const seedManifest = {
  generatedAt: 1,
  characters: {
    testo: {
      name: "Testo",
      bookSlug: "testbook",
      sheetKey: "characters/testo.png",
      portrait: "https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev/cast-gallery/testo/portrait.png",
      poses: [
        "https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev/cast-gallery/testo/pose-1.png",
        "https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev/cast-gallery/testo/pose-2.png",
      ],
      poseCount: 2,
      boxes: [
        { x: 0, y: 0, w: 0.5, h: 1 },
        { x: 0.5, y: 0, w: 0.5, h: 1 },
      ],
      portraitIndex: 0,
      sheetSize: { w: 200, h: 100 },
      v: 1,
    },
  },
};
const books = fakeBooks({
  "characters/testo.png": sheetPng,
  "cast-gallery/manifest.json": JSON.stringify(seedManifest),
  "cast-gallery/testo/portrait.png": origPortrait,
  "cast-gallery/testo/pose-1.png": origPose1,
  "cast-gallery/testo/pose-2.png": origPose2,
});

const loaded = await loadCastGallery(books as any);
assert(loaded.characters["testo"].name === "Testo", "load: runtime manifest read from R2");
invalidateCastGalleryCache();
const fallback = await loadCastGallery(fakeBooks({}) as any);
assert(fallback.characters["juno"].poseCount === 5, "load: empty R2 falls back to the baked manifest");

invalidateCastGalleryCache();
// Nudge pose 1's box a few pixels right and star pose 2 as portrait.
const nudged = [
  { x: 0.03, y: 0, w: 0.47, h: 1 },
  { x: 0.5, y: 0, w: 0.5, h: 1 },
];
const saved = await saveCharacterGallery(books as any, "testo", nudged, 1);
assert(saved.entry.poseCount === 2 && saved.entry.v === 2, "save: manifest entry updated, version bumped");
assert(saved.entry.portraitIndex === 1, "save: starred box became the portrait");
assert(eq(saved.entry.boxes, nudged), "save: boxes stored as given (already in reading order)");
const newPose1 = books.store.get("cast-gallery/testo/pose-1.png")!;
assert(!eq([...newPose1], [...origPose1]), "save: pose-1 bytes changed after the nudge");
const newPose1Decoded = decodeImage(newPose1);
assert(newPose1Decoded.width === 94, `save: nudged crop width is 94px (got ${newPose1Decoded.width})`);
const backupTs = await latestBackup(books as any, "testo");
assert(backupTs === saved.backupTs, "save: backup recorded");
const backupPose1 = books.store.get(`cast-gallery/testo/backup-${saved.backupTs}/pose-1.png`)!;
assert(eq([...backupPose1], [...origPose1]), "save: backup holds the ORIGINAL pose-1 bytes");
const backupEntry = JSON.parse(new TextDecoder().decode(books.store.get(`cast-gallery/testo/backup-${saved.backupTs}/entry.json`)!));
assert(backupEntry.v === 1 && backupEntry.boxes[0].x === 0, "save: backup entry is the pre-save manifest entry");

const restored = await restoreCharacterGallery(books as any, "testo");
assert(eq([...books.store.get("cast-gallery/testo/pose-1.png")!], [...origPose1]), "restore: pose-1 bytes return byte-for-byte");
assert(eq([...books.store.get("cast-gallery/testo/portrait.png")!], [...origPortrait]), "restore: portrait bytes return byte-for-byte");
assert(restored.entry.boxes[0].x === 0 && restored.entry.portraitIndex === 0, "restore: manifest boxes and portrait pick return");
assert(restored.entry.v === 3, "restore: version bumps again so caches move on");

/* ---------- pose meta: normalization + focal helpers ---------- */
assert(eq(normalizePoseMeta([{ action: "Swimming!" }], 1), [{ action: "swimming" }]),
  "meta: action stored in slug form");
assert(eq(normalizePoseMeta([{ focal: { x: 0.5, y: 0.5 } }], 1), [{}]),
  "meta: centered focal is the default and is dropped");
assert(eq(normalizePoseMeta([{ focal: { x: 1.4, y: -0.2 } }], 1), [{ focal: { x: 1, y: 0 } }]),
  "meta: focal clamped into 0..1");
assert(eq(normalizePoseMeta(undefined, 2), [{}, {}]), "meta: missing meta yields empty entries");
assert(eq(focalFor({}, 0), { x: 0.5, y: 0.5 }), "focalFor: default is centered");
assert(eq(focalFor({ poseMeta: [{ focal: { x: 0.25, y: 0.3 } }] }, 0), { x: 0.25, y: 0.3 }),
  "focalFor: stored focal returned");
assert(objectPosition({ x: 0.5, y: 0.3 }) === "50% 30%", "objectPosition: focal becomes CSS percentages");

/* ---------- keepOrder save: explicit order + meta follow their pose ---------- */
const books2 = fakeBooks({
  "characters/testo.png": sheetPng,
  "cast-gallery/manifest.json": JSON.stringify(seedManifest),
  "cast-gallery/testo/portrait.png": origPortrait,
  "cast-gallery/testo/pose-1.png": origPose1,
  "cast-gallery/testo/pose-2.png": origPose2,
});
invalidateCastGalleryCache();
await loadCastGallery(books2 as any);
// Deliberately NOT reading order: right half first, starred as portrait.
const swapped = [
  { x: 0.5, y: 0, w: 0.5, h: 1 },
  { x: 0, y: 0, w: 0.5, h: 1 },
];
const kept = await saveCharacterGallery(books2 as any, "testo", swapped, 0, {
  keepOrder: true,
  poseMeta: [{ action: "flying", focal: { x: 0.5, y: 0.25 } }, { action: "standing" }],
});
assert(eq(kept.entry.boxes, swapped), "keepOrder: boxes stay in the editor's order (no reading-order renumber)");
assert(kept.entry.portraitIndex === 0, "keepOrder: starred pose stays the portrait");
assert(kept.entry.poseMeta?.[0]?.action === "flying" && kept.entry.poseMeta?.[1]?.action === "standing",
  "keepOrder: tags stay with their poses");
assert(eq(kept.entry.poseMeta?.[0]?.focal, { x: 0.5, y: 0.25 }), "keepOrder: focal stays with its pose");
assert(eq([...books2.store.get("cast-gallery/testo/portrait.png")!], [...books2.store.get("cast-gallery/testo/pose-1.png")!]),
  "keepOrder: portrait bytes are pose 1's bytes");
// A later save with no poseMeta option keeps the tags, remapped through
// the legacy reading-order sort (stored order is [right, left]; the
// sort flips it, and flying must follow the right half to index 1).
const resorted = await saveCharacterGallery(books2 as any, "testo", swapped, 0);
assert(eq(resorted.entry.boxes, [swapped[1], swapped[0]]), "legacy save: reading-order sort still applies without keepOrder");
assert(resorted.entry.poseMeta?.[0]?.action === "standing" && resorted.entry.poseMeta?.[1]?.action === "flying",
  "legacy save: stored tags follow their poses through the sort");
assert(resorted.entry.portraitIndex === 1, "legacy save: portrait follows the starred box through the sort");

/* ---------- tag mirror into the book's factory crops manifest ---------- */
const mirrorEntry: any = {
  name: "Testo",
  bookSlug: "testbook",
  sheetKey: "characters/testo.png",
  portrait: "https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev/cast-gallery/testo/portrait.png",
  poses: [],
  poseCount: 2,
  boxes: [
    { x: 0, y: 0, w: 0.5, h: 1 },
    { x: 0.5, y: 0, w: 0.5, h: 1 },
  ],
  portraitIndex: 0,
  poseMeta: [{ action: "standing" }, { action: "flying" }],
  v: 9,
};
const books3 = fakeBooks({});
const m1 = await mirrorGalleryTags(books3 as any, "testo", mirrorEntry);
assert(eq(m1.mirrored, ["testo-p1-standing", "testo-p2-flying"]) && m1.skipped.length === 0,
  "mirror: both tagged poses mirrored");
const bookCrops = JSON.parse(new TextDecoder().decode(books3.store.get("books/testbook/crops.json")!));
assert(bookCrops.length === 2, "mirror: book crops manifest holds exactly the mirrored entries");
const mc = bookCrops[0];
assert(mc.tag === "testo-p1-standing" && mc.character === "Testo" && mc.action === "standing" &&
  mc.source === "cast-gallery" && mc.key === "cast-gallery/testo/pose-1.png" &&
  mc.sheetKey === "characters/testo.png" && eq(mc.bbox, mirrorEntry.boxes[0]) &&
  typeof mc.createdAt === "number",
  "mirror: entry matches the factory crop shape (tag/character/action/source/bbox/key/sheetKey)");
// Retag pose 1 and untag pose 2: the mirror replaces, never accumulates.
mirrorEntry.poseMeta = [{ action: "running" }, {}];
const m2 = await mirrorGalleryTags(books3 as any, "testo", mirrorEntry);
const bookCrops2 = JSON.parse(new TextDecoder().decode(books3.store.get("books/testbook/crops.json")!));
assert(eq(m2.mirrored, ["testo-p1-running"]) && bookCrops2.length === 1 && bookCrops2[0].tag === "testo-p1-running",
  "mirror: retag/untag replaces the character's mirrored entries wholesale");
// A same-named Crop Mode entry (different key) is never overwritten.
const cropModeEntry = {
  tag: "testo-p1-standing", character: "Testo", action: "standing", source: "sheet",
  bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, createdAt: 1,
  key: "books/testbook/crops/testo-p1-standing.png",
};
const books4 = fakeBooks({ "books/testbook/crops.json": JSON.stringify([cropModeEntry]) });
mirrorEntry.poseMeta = [{ action: "standing" }, {}];
const m3 = await mirrorGalleryTags(books4 as any, "testo", mirrorEntry);
const bookCrops3 = JSON.parse(new TextDecoder().decode(books4.store.get("books/testbook/crops.json")!));
assert(eq(m3.skipped, ["testo-p1-standing"]) && m3.mirrored.length === 0 &&
  bookCrops3.length === 1 && bookCrops3[0].key === cropModeEntry.key,
  "mirror: a tag owned by a different crop is skipped, not overwritten");

console.log(failures === 0 ? "\nALL CAST-GALLERY TESTS PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
