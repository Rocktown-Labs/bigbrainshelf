import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import UPNG from "upng-js";
import {
  invalidateCastGalleryCache,
  listBackupTimestamps,
  listPoseHistory,
  restoreCharacterGallery,
  restorePoseVersion,
  saveCharacterGallery,
  type GalleryBox,
} from "../src/lib/cast-gallery";
import { decodeImage } from "../src/lib/crops";

// ---------------------------------------------------------------------------
// Post-save rollback. Every gallery save snapshots the pre-save
// gallery under cast-gallery/{slug}/backup-{ts}/ (bytes + entry), so
// a pose slot accumulates versions. These tests pin: the history
// listing, per-pose restore landing the chosen version's bytes AND
// metadata AND box, the snapshot-first rule that makes a restore
// itself undoable (restore the snapshot = redo), and the wholesale
// restore's same property. The clock is stubbed so each save lands
// in its own backup second, like real saves minutes apart.
// ---------------------------------------------------------------------------

const realNow = Date.now;
let fakeNow = 1_700_000_000_000;
beforeAll(() => { Date.now = () => fakeNow; });
afterAll(() => { Date.now = realNow; });
function tick(seconds = 60) { fakeNow += seconds * 1000; }

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

// 200x100 sheet: left half red, right half blue.
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
const EDIT_INFO = { at: 1_700_000_500_000, sam: 0, brush: false, lasso: true };

function seedBooks() {
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

const EDITED = solidPng(100, 100, 250, 240, 230);

/** Seed, save plain crops, then save a lasso erase edit on pose 1.
 * Returns the books store with live = edited pose 1, two backups. */
async function seedEdited() {
  const books = seedBooks();
  tick();
  await saveCharacterGallery(books as any, "testo", BOXES, 0, { keepOrder: true });
  tick();
  const saved = await saveCharacterGallery(books as any, "testo", BOXES, 0, {
    keepOrder: true,
    poseEdits: [{ index: 0, png: EDITED, eraseInfo: EDIT_INFO }],
  });
  return { books, saved };
}

describe("pose history listing", () => {
  test("no saves yet: empty history, and restoring is a clean error", async () => {
    const books = seedBooks();
    expect(await listPoseHistory(books as any, "testo", 0)).toEqual([]);
    await expect(restorePoseVersion(books as any, "testo", 0, 12345)).rejects.toThrow(/missing its entry\.json/);
  });

  test("versions accumulate newest first with their metadata", async () => {
    const { books } = await seedEdited();
    const versions = await listPoseHistory(books as any, "testo", 0);
    expect(versions.length).toBe(2);
    expect(versions[0].ts).toBeGreaterThan(versions[1].ts);
    // Newest backup = the pre-edit state: the plain red crop.
    expect(versions[0].meta).toBeNull();
    expect(versions[0].isCurrent).toBe(false);
    const newest = decodeImage(books.store.get(`cast-gallery/testo/backup-${versions[0].ts}/pose-1.png`)!);
    expect(newest.data[0]).toBe(220);
    // Pose 2 was never edited; its newest backup matches live bytes.
    const pose2 = await listPoseHistory(books as any, "testo", 1);
    expect(pose2[0].isCurrent).toBe(true);
  });
});

describe("per-pose restore", () => {
  test("save, edit, save, rollback lands the first version's bytes and metadata; rollback again is a redo", async () => {
    const { books, saved } = await seedEdited();
    expect(saved.entry.poseMeta?.[0].eraseInfo).toEqual(EDIT_INFO);
    const versions = await listPoseHistory(books as any, "testo", 0);
    const plainTs = versions[0].ts;

    tick();
    const rolled = await restorePoseVersion(books as any, "testo", 0, plainTs);
    expect(rolled.restoredFrom).toBe(plainTs);
    expect(rolled.snapshotTs).not.toBeNull();
    // Bytes: back to the plain red crop, portrait follows (pose 1 is the portrait).
    const pose1 = decodeImage(books.store.get("cast-gallery/testo/pose-1.png")!);
    expect(pose1.data[0]).toBe(220);
    const portrait = books.store.get("cast-gallery/testo/portrait.png")!;
    expect(Buffer.from(portrait).equals(Buffer.from(books.store.get("cast-gallery/testo/pose-1.png")!))).toBe(true);
    // Metadata: the edited flag and its lasso eraseInfo are gone.
    expect(rolled.entry.poseMeta?.[0].edited).toBeUndefined();
    expect(rolled.entry.poseMeta?.[0].eraseInfo).toBeUndefined();
    expect(rolled.entry.v).toBeGreaterThan(saved.entry.v || 1);

    // The snapshot of the pre-restore (edited) state is now the
    // newest version; restoring it redoes the edit wholesale.
    tick();
    const history2 = await listPoseHistory(books as any, "testo", 0);
    expect(history2[0].ts).toBe(rolled.snapshotTs);
    expect(history2[0].meta?.edited).toBe(true);
    expect(history2[0].meta?.eraseInfo).toEqual(EDIT_INFO);
    const redone = await restorePoseVersion(books as any, "testo", 0, rolled.snapshotTs!);
    const pose1Again = books.store.get("cast-gallery/testo/pose-1.png")!;
    expect(Buffer.from(pose1Again).equals(Buffer.from(EDITED))).toBe(true);
    expect(redone.entry.poseMeta?.[0].edited).toBe(true);
    expect(redone.entry.poseMeta?.[0].eraseInfo).toEqual(EDIT_INFO);
  });

  test("restoring the version that is already live is a clean no-op", async () => {
    const { books } = await seedEdited();
    const before = await listBackupTimestamps(books as any, "testo");
    const versions = await listPoseHistory(books as any, "testo", 1);
    const current = versions.find((v) => v.isCurrent)!;
    const res = await restorePoseVersion(books as any, "testo", 1, current.ts);
    expect(res.snapshotTs).toBeNull();
    const after = await listBackupTimestamps(books as any, "testo");
    expect(after.length).toBe(before.length); // no snapshot was taken
  });

  test("a restore also brings back the version's box", async () => {
    const books = seedBooks();
    tick();
    await saveCharacterGallery(books as any, "testo", BOXES, 0, { keepOrder: true });
    tick();
    const blueBoxes: GalleryBox[] = [{ x: 0.5, y: 0, w: 0.5, h: 1 }, BOXES[1]];
    await saveCharacterGallery(books as any, "testo", blueBoxes, 0, { keepOrder: true });
    let pose1 = decodeImage(books.store.get("cast-gallery/testo/pose-1.png")!);
    expect(pose1.data[2]).toBe(220); // blue channel: pose 1 now crops the blue half
    const versions = await listPoseHistory(books as any, "testo", 0);
    tick();
    const rolled = await restorePoseVersion(books as any, "testo", 0, versions[0].ts);
    expect(rolled.entry.boxes?.[0]).toEqual(BOXES[0]);
    pose1 = decodeImage(books.store.get("cast-gallery/testo/pose-1.png")!);
    expect(pose1.data[0]).toBe(220); // red half again
    expect(pose1.data[2]).toBe(30);
  });
});

describe("wholesale restore is undoable too", () => {
  test("restore, then restore again, toggles back (redo)", async () => {
    const { books } = await seedEdited();
    tick();
    const first = await restoreCharacterGallery(books as any, "testo");
    expect(first.entry.poseMeta?.[0]?.edited).toBeUndefined();
    let pose1 = decodeImage(books.store.get("cast-gallery/testo/pose-1.png")!);
    expect(pose1.data[0]).toBe(220); // plain crop
    tick();
    const second = await restoreCharacterGallery(books as any, "testo");
    expect(second.entry.poseMeta?.[0]?.edited).toBe(true);
    pose1 = decodeImage(books.store.get("cast-gallery/testo/pose-1.png")!);
    expect(Buffer.from(books.store.get("cast-gallery/testo/pose-1.png")!).equals(Buffer.from(EDITED))).toBe(true);
  });
});

describe("history wiring (source pins)", () => {
  const fs = require("node:fs");
  const route = fs.readFileSync("src/pages/api/admin/cast-gallery.ts", "utf8");
  const lib = fs.readFileSync("src/lib/cast-gallery.ts", "utf8");

  test("route exposes history reads and per-pose restore", () => {
    expect(route).toContain("listPoseHistory");
    expect(route).toContain("restorePoseVersion");
    expect(route).toContain("restorePose");
    expect(route).toContain("history");
  });

  test("restores snapshot before they overwrite", () => {
    expect(lib).toContain("await backupCurrent(BOOKS, slug, entry, snapshotTs)");
    expect(lib).toContain("export async function restorePoseVersion");
    expect(lib).toContain("export async function listPoseHistory");
  });
});
