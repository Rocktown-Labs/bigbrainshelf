import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import UPNG from "upng-js";
import {
  applyLiftedPose,
  invalidateCastGalleryCache,
  normalizePoseMeta,
  saveCharacterGallery,
  validEraseInfo,
  type GalleryBox,
} from "../src/lib/cast-gallery";
import {
  claimNextLiftJob,
  enqueueLiftJob,
  enqueueSegmentJob,
  ensureLiftJobsTable,
  eraseOutKey,
  eraseSrcKey,
  getLiftJob,
  listLiftJobs,
} from "../src/lib/lift-jobs";
import { decodeImage } from "../src/lib/crops";

// ---------------------------------------------------------------------------
// Erase (click-to-remove) jobs + edited-pose saves.
//
// Two halves pinned here:
//  1. lift_jobs grows a 'segment' kind: enqueue shape (point, src/out
//     keys), per-pose dedupe independent of lift jobs, FIFO claiming
//     across kinds, and the column migration on a pre-segment table.
//  2. saveCharacterGallery ships editor-supplied erase bytes instead
//     of a crop when the pose's box is unchanged, stamps poseMeta
//     edited + eraseInfo, preserves a stored edit across later saves
//     while the box stays put, and clears the whole edited state when
//     the box moves (the pose ships as a fresh sheet crop).
// ---------------------------------------------------------------------------

function makeDb(): any {
  const sqlite = new Database(":memory:");
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async run() {
          const info = sqlite.query(sql).run(...(binds as never[]));
          return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
        },
        async first<T>() {
          return (sqlite.query(sql).get(...(binds as never[])) ?? null) as T | null;
        },
        async all<T>() {
          return { results: sqlite.query(sql).all(...(binds as never[])) as T[] };
        },
      };
      return stmt;
    },
    _sqlite: sqlite,
  };
  return db;
}

const BOX: GalleryBox = { x: 0.1, y: 0.1, w: 0.4, h: 0.5 };
const T0 = 1_700_000_000;

describe("segment job queue", () => {
  test("enqueue stores kind, point, src and out keys; dedupes per pose", async () => {
    const db = makeDb();
    await ensureLiftJobsTable(db);
    const a = await enqueueSegmentJob(db, {
      slug: "cato",
      poseIndex: 0,
      point: { x: 12, y: 34 },
      srcKey: "cast-gallery/cato/pose-1.png",
      sheetKey: "characters/cato.png",
      now: T0,
      id: "seg-1",
    });
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error("unreachable");
    expect(a.job.kind).toBe("segment");
    expect(a.job.point).toEqual({ x: 12, y: 34 });
    expect(a.job.src_key).toBe("cast-gallery/cato/pose-1.png");
    expect(a.job.out_key).toBe(eraseOutKey("cato", "seg-1"));
    expect(eraseSrcKey("cato", "seg-1")).toBe("cast-gallery/cato/erase-src-seg-1.png");

    const dup = await enqueueSegmentJob(db, {
      slug: "cato",
      poseIndex: 0,
      point: { x: 1, y: 1 },
      srcKey: "cast-gallery/cato/pose-1.png",
      now: T0 + 1,
    });
    expect(dup.ok).toBe(false);
    if (dup.ok) throw new Error("unreachable");
    expect(dup.existing?.id).toBe("seg-1");

    // A lift for the same pose is a different family: not blocked.
    const lift = await enqueueLiftJob(db, {
      slug: "cato", poseIndex: 0, box: BOX, sheetKey: "characters/cato.png", now: T0 + 2,
    });
    expect(lift.ok).toBe(true);

    // Bad inputs are refused.
    const badPoint = await enqueueSegmentJob(db, {
      slug: "cato", poseIndex: 1, point: { x: -1, y: 0 }, srcKey: "cast-gallery/cato/pose-2.png",
    });
    expect(badPoint.ok).toBe(false);
    const badSrc = await enqueueSegmentJob(db, {
      slug: "cato", poseIndex: 1, point: { x: 0, y: 0 }, srcKey: "books/x/y.png",
    });
    expect(badSrc.ok).toBe(false);
  });

  test("claim is FIFO across kinds and the row round-trips", async () => {
    const db = makeDb();
    await ensureLiftJobsTable(db);
    await enqueueSegmentJob(db, {
      slug: "fern", poseIndex: 1, point: { x: 5, y: 6 },
      srcKey: "cast-gallery/fern/pose-2.png", now: T0, id: "seg-9",
    });
    const claimed = await claimNextLiftJob(db, T0 + 10);
    expect(claimed?.id).toBe("seg-9");
    expect(claimed?.kind).toBe("segment");
    expect(claimed?.point).toEqual({ x: 5, y: 6 });
    const fetched = await getLiftJob(db, "seg-9");
    expect(fetched?.status).toBe("running");
    const onlySegments = await listLiftJobs(db, "fern", 20, "segment");
    expect(onlySegments.length).toBe(1);
    const onlyLifts = await listLiftJobs(db, "fern", 20, "lift");
    expect(onlyLifts.length).toBe(0);
  });

  test("ensure migrates a pre-segment lift_jobs table", async () => {
    const db = makeDb();
    db._sqlite.query(
      `CREATE TABLE lift_jobs (
         id TEXT PRIMARY KEY, slug TEXT NOT NULL, pose_index INTEGER NOT NULL,
         box TEXT NOT NULL, sheet_key TEXT NOT NULL DEFAULT '',
         status TEXT NOT NULL DEFAULT 'queued', error TEXT,
         created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER)`
    ).run();
    await ensureLiftJobsTable(db);
    await ensureLiftJobsTable(db); // idempotent
    const seg = await enqueueSegmentJob(db, {
      slug: "ada", poseIndex: 2, point: { x: 3, y: 4 },
      srcKey: "cast-gallery/ada/pose-3.png", now: T0, id: "seg-old",
    });
    expect(seg.ok).toBe(true);
    const lift = await enqueueLiftJob(db, {
      slug: "ada", poseIndex: 0, box: BOX, sheetKey: "characters/ada.png", now: T0,
    });
    expect(lift.ok).toBe(true);
    if (!lift.ok) throw new Error("unreachable");
    expect(lift.job.kind).toBe("lift"); // rows default to the lift family
  });
});

describe("pose meta erase state", () => {
  test("normalizePoseMeta keeps edited only with a sane eraseInfo", () => {
    const good = normalizePoseMeta(
      [{ edited: true, eraseInfo: { at: 1234, sam: 2, brush: true } }], 1);
    expect(good[0].edited).toBe(true);
    expect(good[0].eraseInfo).toEqual({ at: 1234, sam: 2, brush: true });
    const bare = normalizePoseMeta([{ edited: true }], 1);
    expect(bare[0].edited).toBeUndefined();
    const junk = normalizePoseMeta(
      [{ edited: true, eraseInfo: { at: -5, sam: 1 } }], 1);
    expect(junk[0].edited).toBeUndefined();
    expect(validEraseInfo({ at: 100, sam: 500, brush: 1 })).toEqual(
      { at: 100, sam: 99, brush: false });
    expect(validEraseInfo(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gallery saves with erase edits (fake BOOKS, same pattern as
// cast-gallery.test.ts)
// ---------------------------------------------------------------------------

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

// 200x100 sheet: left half red, right half blue (as cast-gallery.test.ts).
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
  { x: 0, y: 0, w: 0.5, h: 1 },   // pose 1: 100x100 red
  { x: 0.5, y: 0, w: 0.5, h: 1 }, // pose 2: 100x100 blue
];
const INFO = { at: 1_700_000_000_000, sam: 1, brush: true };

function seedBooks(extra: Record<string, any> = {}) {
  invalidateCastGalleryCache(); // the lib caches the manifest per isolate
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

describe("save with erase edits", () => {
  test("edit bytes ship for an unchanged box; meta stamps edited; portrait follows", async () => {
    const books = seedBooks();
    const edited = solidPng(100, 100, 250, 240, 230);
    const { entry, backupTs } = await saveCharacterGallery(books as any, "testo", BOXES, 0, {
      keepOrder: true,
      poseEdits: [{ index: 0, png: edited, eraseInfo: INFO }],
    });
    expect(entry.poseMeta?.[0].edited).toBe(true);
    expect(entry.poseMeta?.[0].eraseInfo).toEqual(INFO);
    expect(entry.poseMeta?.[1].edited).toBeUndefined();
    const pose1 = books.store.get("cast-gallery/testo/pose-1.png")!;
    expect(Buffer.from(pose1).equals(Buffer.from(edited))).toBe(true);
    const portrait = books.store.get("cast-gallery/testo/portrait.png")!;
    expect(Buffer.from(portrait).equals(Buffer.from(edited))).toBe(true);
    // Backup-first: the pre-save pose bytes are restorable.
    const backup = books.store.get(`cast-gallery/testo/backup-${backupTs}/pose-1.png`)!;
    expect(decodeImage(backup).data[0]).toBe(4);
    // Pose 2 shipped as the plain sheet crop (blue half).
    const pose2 = decodeImage(books.store.get("cast-gallery/testo/pose-2.png")!);
    expect(pose2.data[2]).toBe(220);
  });

  test("a stored edit survives a later save while its box stays put", async () => {
    const books = seedBooks();
    const edited = solidPng(100, 100, 250, 240, 230);
    await saveCharacterGallery(books as any, "testo", BOXES, 0, {
      keepOrder: true,
      poseEdits: [{ index: 0, png: edited, eraseInfo: INFO }],
    });
    // Second save touches only pose 2's tag; no edit payload.
    const again = await saveCharacterGallery(books as any, "testo", BOXES, 0, {
      keepOrder: true,
      poseMeta: [{}, { action: "swimming" }],
    });
    expect(again.entry.poseMeta?.[0].edited).toBe(true);
    expect(again.entry.poseMeta?.[0].eraseInfo).toEqual(INFO);
    const pose1 = books.store.get("cast-gallery/testo/pose-1.png")!;
    expect(Buffer.from(pose1).equals(Buffer.from(edited))).toBe(true);
  });

  test("moving the box clears the edit and ships a fresh crop", async () => {
    const books = seedBooks();
    const edited = solidPng(100, 100, 250, 240, 230);
    await saveCharacterGallery(books as any, "testo", BOXES, 0, {
      keepOrder: true,
      poseEdits: [{ index: 0, png: edited, eraseInfo: INFO }],
    });
    const moved: GalleryBox[] = [{ x: 0.02, y: 0, w: 0.48, h: 1 }, BOXES[1]];
    const res = await saveCharacterGallery(books as any, "testo", moved, 0, {
      keepOrder: true,
      // Even a fresh payload for the moved pose is refused by shape:
      // its pixels were painted under the old box.
      poseEdits: [{ index: 0, png: solidPng(96, 100, 9, 9, 9), eraseInfo: INFO }],
    });
    expect(res.entry.poseMeta?.[0].edited).toBeUndefined();
    const pose1 = decodeImage(books.store.get("cast-gallery/testo/pose-1.png")!);
    expect(pose1.width).toBe(96); // the moved box's own crop
    expect(pose1.data[0]).toBe(220); // sheet red, not the edit's cream
  });

  test("an edit with the wrong pixel size aborts the save before any write", async () => {
    const books = seedBooks();
    const before = books.store.get("cast-gallery/testo/pose-1.png")!;
    await expect(
      saveCharacterGallery(books as any, "testo", BOXES, 0, {
        keepOrder: true,
        poseEdits: [{ index: 0, png: solidPng(50, 50, 1, 1, 1), eraseInfo: INFO }],
      })
    ).rejects.toThrow(/erase edit for pose 1 is 50x50/);
    const after = books.store.get("cast-gallery/testo/pose-1.png")!;
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
    const backups = [...books.store.keys()].filter((k) => k.includes("/backup-"));
    expect(backups.length).toBe(0); // aborted before backup/overwrite
  });

  test("a lift landing on an edited pose clears the edited state", async () => {
    const books = seedBooks();
    const edited = solidPng(100, 100, 250, 240, 230);
    await saveCharacterGallery(books as any, "testo", BOXES, 0, {
      keepOrder: true,
      poseEdits: [{ index: 0, png: edited, eraseInfo: INFO }],
    });
    const placed = solidPng(100, 100, 200, 200, 200);
    const cutout = solidPng(40, 40, 0, 0, 0);
    const { entry } = await applyLiftedPose(books as any, "testo", 0, placed, cutout, BOXES[0]);
    expect(entry.poseMeta?.[0].lifted).toBe(true);
    expect(entry.poseMeta?.[0].edited).toBeUndefined();
    expect(entry.poseMeta?.[0].eraseInfo).toBeUndefined();
  });
});

describe("editor + route wiring (source pins)", () => {
  const fs = require("node:fs");
  const page = fs.readFileSync("src/pages/admin/characters/cast-crops.astro", "utf8");
  const adminRoute = fs.readFileSync("src/pages/api/admin/cast-erase.ts", "utf8");
  const workerRoute = fs.readFileSync("src/pages/api/lift/worker.ts", "utf8");
  const galleryRoute = fs.readFileSync("src/pages/api/admin/cast-gallery.ts", "utf8");

  test("editor carries the erase mode", () => {
    expect(page).toContain('id="erase-modal"');
    expect(page).toContain('id="erase-canvas"');
    expect(page).toContain("sampleCornerBg");
    expect(page).toContain("Click to remove");
    expect(page).toContain("staged edits were cleared");
    expect(page).toContain("poseEdits");
  });

  test("admin erase route is session-gated and validates the point", () => {
    expect(adminRoute).toContain("locals");
    expect(adminRoute).toContain("enqueueSegmentJob");
    expect(adminRoute).toContain("click point must land inside the pose image");
  });

  test("worker route branches segment completes and lifts stay intact", () => {
    expect(workerRoute).toContain('job.kind === "segment"');
    expect(workerRoute).toContain("resultPng");
    expect(workerRoute).toContain("applyLiftedPose");
    expect(workerRoute).toContain("sourceKey");
  });

  test("gallery save route decodes poseEdits as PNG payloads", () => {
    expect(galleryRoute).toContain("poseEdits");
    expect(galleryRoute).toContain("decodePngBase64");
  });
});

describe("selected-pose action bar (source pins)", () => {
  const fs = require("node:fs");
  const page = fs.readFileSync("src/pages/admin/characters/cast-crops.astro", "utf8");

  test("the bar sits under the sheet with the three named actions", () => {
    const sheetAt = page.indexOf('class="stage-scroll"');
    const barAt = page.indexOf('id="sel-actions"');
    expect(sheetAt).toBeGreaterThan(-1);
    expect(barAt).toBeGreaterThan(sheetAt);
    expect(page).toContain('id="sel-actions-label"');
    expect(page).toContain('id="sel-lift-btn"');
    expect(page).toContain('id="sel-shape-btn"');
    expect(page).toContain('id="sel-erase-btn"');
    expect(page).toContain('id="sel-actions-status"');
    expect(page).toContain("Shape around the object");
    expect(page).toContain('id="sel-actions-hint"');
    expect(page).toContain("Shape traces around the object and cuts the rest away");
  });

  test("the bar mirrors the panel buttons from the same render functions", () => {
    expect(page).toContain("function renderSelActions()");
    expect(page).toContain("selLift.disabled = liftBtn.disabled");
    expect(page).toContain("selLift.textContent = liftBtn.textContent");
    expect(page).toContain("selErase.disabled = eraseBtn.disabled");
    expect(page).toContain("selErase.textContent = eraseBtn.textContent");
    // Shape no longer mirrors Erase: it traces on the sheet and
    // produces the next box, so unsaved boxes do not block it.
    expect(page).toContain('document.getElementById("sel-shape-btn").disabled = state.saving');
    // renderLift, renderErase, and the lift click path all re-sync the bar
    expect(page.split("renderSelActions();").length - 1).toBeGreaterThanOrEqual(5);
    expect(page).toContain('bar.classList.add("hidden")');
    expect(page).toContain('"Pose " + (i + 1)');
  });

  test("both lift buttons run the one queueLift path", () => {
    expect(page).toContain("async function queueLift()");
    expect(page).toContain('getElementById("lift-btn").addEventListener("click", queueLift)');
    expect(page).toContain('getElementById("sel-lift-btn").addEventListener("click", queueLift)');
  });

  test("the erase modal still supports a preselected tool for its own callers", () => {
    expect(page).toContain("async function openErase(startTool)");
    expect(page).toContain('startTool === "lasso" ? "lasso" : "brush"');
    // the tool is chosen before the session's first tool render
    expect(page).toContain("setEraseTool(tool)");
    expect(page.indexOf('startTool === "lasso"')).toBeLessThan(page.indexOf("setEraseTool(tool)"));
    // lasso help line rides along with the preselected tool
    expect(page).toContain('getElementById("erase-lasso-help").classList.toggle("hidden", tool !== "lasso")');
    // Shape itself moved to the sheet tracer (pinned in cast-sheet-shape.test.ts)
    expect(page).toContain('getElementById("sel-shape-btn").addEventListener("click", () => openSheetShape())');
  });

  test("the plain erase entries behave exactly as before (brush first)", () => {
    expect(page).toContain('getElementById("erase-btn").addEventListener("click", () => openErase())');
    expect(page).toContain('getElementById("sel-erase-btn").addEventListener("click", () => openErase())');
    // the panel sections themselves are untouched
    expect(page).toContain('id="lift-btn"');
    expect(page).toContain('id="erase-btn"');
    expect(page).toContain('id="history-list"');
  });
});
