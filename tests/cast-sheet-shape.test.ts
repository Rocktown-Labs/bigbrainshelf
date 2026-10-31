import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import UPNG from "upng-js";
import {
  createLassoCapture,
  lassoPointerDown,
  lassoPointerUp,
  lassoPoints,
  cutSheetShape,
  shapeBoundingBox,
  sampleCornerBackground,
  type LassoPoint,
} from "../src/lib/lasso";
import {
  applyLiftedPose,
  invalidateCastGalleryCache,
  listPoseHistory,
  restorePoseVersion,
  saveCharacterGallery,
  type GalleryBox,
} from "../src/lib/cast-gallery";
import { decodeImage } from "../src/lib/crops";

// ---------------------------------------------------------------------------
// Sheet-level Shape + Undo lift.
//
// CG's ask: the pose-level lasso works on the already-cropped pose,
// but he thinks at the box stage: trace on the SHEET, "just cut it,
// and fill the background with the background." Pinned here:
//  1. the pure cut (src/lib/lasso.ts): the trace's bounding-box
//     region of the sheet, inside pixels exact (a thin wingtip
//     included), outside filled with the sheet's sampled background,
//     the other subject fully gone, source never mutated.
//  2. the save contract: a shape payload is the ONE edit allowed to
//     move its pose's box (to the trace bbox); its bytes are still
//     dimension-validated against the NEW box; the same payload
//     without the shape flag is dropped like any moved-box edit;
//     a shape cut clears the pose's lifted state.
//  3. undo lift at the lib level: after a lift (and even a later
//     save), the newest NON-lifted history version is the lift's
//     own backup, and restoring it lands the pre-lift crop.
// ---------------------------------------------------------------------------

const realNow = Date.now;
let fakeNow = 1_700_000_000_000;
beforeAll(() => { Date.now = () => fakeNow; });
afterAll(() => { Date.now = realNow; });
function tick(seconds = 60) { fakeNow += seconds * 1000; }

// ------------------------------------------------------------ pure cut

const BG = { r: 250, g: 246, b: 238 };
const NAVY: [number, number, number] = [38, 52, 84];
const RED: [number, number, number] = [198, 44, 38];

/** 160x120 sheet: a navy bird (body + a long thin wing) and a red
 * second subject parked below the wing's far end. */
function syntheticSheet() {
  const w = 160, h = 120;
  const data = new Uint8ClampedArray(w * h * 4);
  const fill = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const k = (y * w + x) * 4;
      data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = 255;
    }
  };
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = BG.r; data[i * 4 + 1] = BG.g; data[i * 4 + 2] = BG.b; data[i * 4 + 3] = 255;
  }
  fill(20, 45, 64, 85, NAVY);       // body
  fill(64, 50, 118, 54, NAVY);      // the long thin wing
  fill(84, 80, 118, 105, RED);      // second subject, below the wing
  return { data, w, h };
}

// Staircase trace around body + wing that steps down BEFORE the red
// subject: the red block sits inside the trace's bounding box but
// outside the outline itself.
const TRACE: LassoPoint[] = [
  { x: 12, y: 38 }, { x: 126, y: 38 }, { x: 126, y: 62 },
  { x: 76, y: 62 }, { x: 76, y: 92 }, { x: 12, y: 92 },
];

const pxAt = (data: Uint8ClampedArray, w: number, x: number, y: number) => {
  const k = (y * w + x) * 4;
  return [data[k], data[k + 1], data[k + 2]];
};

describe("cutSheetShape", () => {
  test("bounding box is the trace's pixel extent, clamped to the image", () => {
    expect(shapeBoundingBox(TRACE, 160, 120)).toEqual({ x0: 12, y0: 38, x1: 126, y1: 92 });
    expect(shapeBoundingBox(
      [{ x: -5, y: -5 }, { x: 500, y: 30 }, { x: 60, y: 500 }], 160, 120
    )).toEqual({ x0: 0, y0: 0, x1: 160, y1: 120 });
    expect(shapeBoundingBox([{ x: 1, y: 1 }, { x: 2, y: 2 }], 160, 120)).toBeNull();
    expect(cutSheetShape(new Uint8ClampedArray(160 * 120 * 4), 160, 120,
      [{ x: 1, y: 1 }, { x: 2, y: 2 }], BG)).toBeNull();
  });

  test("inside pixels are the sheet's exactly, wingtip included", () => {
    const { data, w, h } = syntheticSheet();
    const cut = cutSheetShape(data, w, h, TRACE, BG, 2)!;
    expect(cut.offsetX).toBe(12);
    expect(cut.offsetY).toBe(38);
    expect(cut.width).toBe(114);
    expect(cut.height).toBe(54);
    // Body, deep inside: (40,65) sheet -> (28,27) in the cut.
    expect(pxAt(cut.data, cut.width, 28, 27)).toEqual(NAVY);
    // The wingtip, the whole reason this tool exists: sheet (116,52)
    // -> (104,14) in the cut, pixel-identical to the sheet.
    expect(pxAt(cut.data, cut.width, 104, 14)).toEqual(pxAt(data, w, 116, 52));
    expect(pxAt(cut.data, cut.width, 104, 14)).toEqual(NAVY);
  });

  test("outside the trace is the sampled background; the other subject is fully gone", () => {
    const { data, w, h } = syntheticSheet();
    const cut = cutSheetShape(data, w, h, TRACE, BG, 2)!;
    // Sheet (100,90) was the red subject, inside the bbox but far
    // outside the trace: exactly the background in the cut.
    expect(pxAt(data, w, 100, 90)).toEqual(RED);
    expect(pxAt(cut.data, cut.width, 88, 52)).toEqual([BG.r, BG.g, BG.b]);
    // No red survives anywhere in the cut.
    let redLeft = 0;
    for (let i = 0; i < cut.width * cut.height; i++) {
      if (cut.data[i * 4] === RED[0] && cut.data[i * 4 + 1] === RED[1] && cut.data[i * 4 + 2] === RED[2]) redLeft++;
    }
    expect(redLeft).toBe(0);
    // A deep-outside corner of the region is flat background too.
    expect(pxAt(cut.data, cut.width, 2, 2)).toEqual([BG.r, BG.g, BG.b]);
  });

  test("the source sheet is never mutated", () => {
    const { data, w, h } = syntheticSheet();
    const before = Uint8ClampedArray.from(data);
    cutSheetShape(data, w, h, TRACE, BG, 2);
    expect(Buffer.from(data).equals(Buffer.from(before))).toBe(true);
  });

  test("the capture model feeds it: mixed clicks produce the same cut", () => {
    const cap = createLassoCapture();
    for (const p of TRACE) { lassoPointerDown(cap, p); lassoPointerUp(cap); }
    const { data, w, h } = syntheticSheet();
    const a = cutSheetShape(data, w, h, lassoPoints(cap), BG, 2)!;
    const b = cutSheetShape(data, w, h, TRACE, BG, 2)!;
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });

  test("sampleCornerBackground medians the four corners", () => {
    const w = 40, h = 40;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 10; data[i * 4 + 1] = 20; data[i * 4 + 2] = 30; data[i * 4 + 3] = 255;
    }
    // One corner patch is an outlier color; the median ignores it.
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const k = (y * w + x) * 4;
      data[k] = 200; data[k + 1] = 210; data[k + 2] = 220;
    }
    expect(sampleCornerBackground(data, w, h)).toEqual({ r: 10, g: 20, b: 30 });
  });
});

// ------------------------------------------------------------ save contract

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

function solidPng(w: number, h: number, r: number, g: number, b: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return new Uint8Array(UPNG.encode([data.buffer as ArrayBuffer], w, h, 0));
}

// 200x100 sheet: left half red, right half blue (as cast-history).
const sheetPng = (() => {
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
})();

const BOXES: GalleryBox[] = [
  { x: 0, y: 0, w: 0.5, h: 1 },
  { x: 0.5, y: 0, w: 0.5, h: 1 },
];
// The trace's bounding box as a pose box: the left quarter, 50x100px.
const TRACE_BOX: GalleryBox = { x: 0, y: 0, w: 0.25, h: 1 };
const SHAPE_INFO = { at: 1_700_000_500_000, sam: 0, brush: false, shape: true };

function seedBooks(extra: Record<string, any> = {}) {
  invalidateCastGalleryCache();
  const manifest = {
    generatedAt: 1,
    characters: {
      testo: {
        name: "Testo",
        bookSlug: "testbook",
        sheetKey: "characters/testo.png",
        portrait: "x/cast-gallery/testo/portrait.png",
        poses: ["x/cast-gallery/testo/pose-1.png", "x/cast-gallery/testo/pose-2.png"],
        poseCount: 2,
        boxes: BOXES,
        portraitIndex: 0,
        sheetSize: { w: 200, h: 100 },
        v: 1,
        ...extra,
      },
    },
  };
  return fakeBooks({
    "characters/testo.png": sheetPng,
    "cast-gallery/manifest.json": JSON.stringify(manifest),
    "cast-gallery/testo/portrait.png": solidPng(100, 100, 1, 2, 3),
    "cast-gallery/testo/pose-1.png": solidPng(100, 100, 4, 5, 6),
    "cast-gallery/testo/pose-2.png": solidPng(100, 100, 7, 8, 9),
  });
}

async function seedCropped(extra: Record<string, any> = {}) {
  const books = seedBooks(extra);
  tick();
  await saveCharacterGallery(books as any, "testo", BOXES, 0, { keepOrder: true });
  return books;
}

describe("shape save contract", () => {
  test("a shape payload ships its bytes AND moves the box to the trace bbox", async () => {
    const books = await seedCropped();
    const cut = solidPng(50, 100, 9, 99, 199);
    tick();
    const saved = await saveCharacterGallery(books as any, "testo", [TRACE_BOX, BOXES[1]], 0, {
      keepOrder: true,
      poseEdits: [{ index: 0, png: cut, eraseInfo: SHAPE_INFO, shape: true }],
    });
    const live = books.store.get("cast-gallery/testo/pose-1.png")!;
    expect(Buffer.from(live).equals(Buffer.from(cut))).toBe(true);
    expect(saved.entry.boxes?.[0]).toEqual(TRACE_BOX);
    expect(saved.entry.poseMeta?.[0].edited).toBe(true);
    expect(saved.entry.poseMeta?.[0].eraseInfo).toEqual(SHAPE_INFO);
  });

  test("the same payload WITHOUT the shape flag is dropped: a moved box ships a fresh crop", async () => {
    const books = await seedCropped();
    const cut = solidPng(50, 100, 9, 99, 199);
    tick();
    const saved = await saveCharacterGallery(books as any, "testo", [TRACE_BOX, BOXES[1]], 0, {
      keepOrder: true,
      poseEdits: [{ index: 0, png: cut, eraseInfo: { at: 1, sam: 0, brush: true } }],
    });
    const live = decodeImage(books.store.get("cast-gallery/testo/pose-1.png")!);
    expect(live.width).toBe(50);
    expect(live.data[0]).toBe(220); // the red sheet half: a fresh crop, not the payload
    expect(saved.entry.poseMeta?.[0].edited).toBeUndefined();
  });

  test("shape bytes are dimension-validated against the NEW box", async () => {
    const books = await seedCropped();
    tick();
    await expect(saveCharacterGallery(books as any, "testo", [TRACE_BOX, BOXES[1]], 0, {
      keepOrder: true,
      poseEdits: [{ index: 0, png: solidPng(60, 100, 9, 99, 199), eraseInfo: SHAPE_INFO, shape: true }],
    })).rejects.toThrow(/60x100px but the pose box crops to 50x100px/);
    // The failed save touched nothing live.
    const live = decodeImage(books.store.get("cast-gallery/testo/pose-1.png")!);
    expect(live.width).toBe(100);
    expect(live.data[0]).toBe(220);
  });

  test("a shape cut clears the pose's lifted state even when the box matches the lift", async () => {
    const books = await seedCropped({
      poseMeta: [{
        lifted: true,
        cutoutKey: "cast-gallery/testo/cutout-1.png",
        liftedBox: BOXES[0],
      }, {}],
    });
    // Re-crop once so the stored meta really carries the triple.
    tick();
    await saveCharacterGallery(books as any, "testo", BOXES, 0, { keepOrder: true });
    const cut = solidPng(100, 100, 9, 99, 199);
    tick();
    const saved = await saveCharacterGallery(books as any, "testo", BOXES, 0, {
      keepOrder: true,
      poseEdits: [{ index: 0, png: cut, eraseInfo: SHAPE_INFO, shape: true }],
    });
    const live = books.store.get("cast-gallery/testo/pose-1.png")!;
    expect(Buffer.from(live).equals(Buffer.from(cut))).toBe(true);
    expect(saved.entry.poseMeta?.[0].lifted).toBeUndefined();
    expect(saved.entry.poseMeta?.[0].cutoutKey).toBeUndefined();
    expect(saved.entry.poseMeta?.[0].edited).toBe(true);
    expect(saved.entry.poseMeta?.[0].eraseInfo?.shape).toBe(true);
  });
});

describe("undo lift (lib level)", () => {
  test("the newest non-lifted version is the lift's own backup, even after a later save", async () => {
    const books = await seedCropped();
    const preLift = books.store.get("cast-gallery/testo/pose-1.png")!;
    tick();
    const placed = solidPng(100, 100, 11, 22, 33);
    const liftedSave = await applyLiftedPose(books as any, "testo", 0, placed, solidPng(100, 100, 0, 0, 0), BOXES[0]);
    expect(liftedSave.entry.poseMeta?.[0].lifted).toBe(true);
    expect(Buffer.from(books.store.get("cast-gallery/testo/pose-1.png")!).equals(Buffer.from(placed))).toBe(true);
    // A later unrelated save snapshots the LIFTED state as the newest backup.
    tick();
    await saveCharacterGallery(books as any, "testo", BOXES, 0, { keepOrder: true });
    const versions = await listPoseHistory(books as any, "testo", 0, 50);
    expect(versions[0].meta?.lifted).toBe(true); // the later save's snapshot
    const target = versions.find((v) => !(v.meta && v.meta.lifted));
    expect(target).toBeDefined();
    tick();
    const rolled = await restorePoseVersion(books as any, "testo", 0, target!.ts);
    expect(rolled.entry.poseMeta?.[0].lifted).toBeUndefined();
    const live = books.store.get("cast-gallery/testo/pose-1.png")!;
    expect(Buffer.from(live).equals(Buffer.from(preLift))).toBe(true);
  });
});

describe("sheet shape + undo lift wiring (source pins)", () => {
  const fs = require("node:fs");
  const page = fs.readFileSync("src/pages/admin/characters/cast-crops.astro", "utf8");
  const lib = fs.readFileSync("src/lib/cast-gallery.ts", "utf8");
  const route = fs.readFileSync("src/pages/api/admin/cast-gallery.ts", "utf8");

  test("the sheet tracer modal and its cut button exist", () => {
    expect(page).toContain('id="shape-modal"');
    expect(page).toContain('id="shape-canvas"');
    expect(page).toContain('id="shape-cut"');
    expect(page).toContain("Cut to this shape");
    expect(page).toContain("async function openSheetShape()");
    expect(page).toContain("cutSheetShape(imgData.data, W, H, poly, shapeSession.bg, 2)");
    expect(page).toContain("This is the whole sheet, not just the pose");
  });

  test("staging: shape flag set, box becomes the bbox, manual drag still clears", () => {
    expect(page).toContain("state.shapeEdits[i] = true");
    expect(page).toContain("x: cut.offsetX / W, y: cut.offsetY / H");
    expect(page).toContain("state.shapeEdits[i] = false");
    expect(page).toContain("staged edits were cleared");
    expect(page).toContain("shapeEdits: state.shapeEdits");
    expect(page).toContain("state.shapeEdits = d.shapeEdits");
  });

  test("the save payload flags shape cuts for the server", () => {
    expect(page).toContain("state.shapeEdits[i] ? { shape: true } : {}");
    expect(route).toContain("shape: raw?.shape === true");
    expect(lib).toContain("editsByFrom.get(o.from)!.shape === true");
  });

  test("staged status lines name the pose and the save", () => {
    expect(page).toContain('"Shape staged on Pose " + (i + 1) + ". Save " + state.entry.name + " ships it."');
    expect(page).toContain('"Edit staged on Pose " + (i + 1) + ". Save " + state.entry.name + " ships it."');
  });

  test("undo lift: buttons, scan, and the status offer", () => {
    expect(page).toContain('id="undo-lift-btn"');
    expect(page).toContain('id="sel-undo-lift-btn"');
    expect(page).toContain("async function undoLiftFlow()");
    expect(page).toContain("versions.find((v) => !(v.meta && v.meta.lifted))");
    expect(page).toContain("&limit=50");
    expect(page).toContain("Not right? Undo lift brings back the plain crop it replaced.");
    expect(page).toContain("function renderUndoLift(lifted, active)");
    expect(route).toContain("Math.min(50, rawLimit)");
  });
});
