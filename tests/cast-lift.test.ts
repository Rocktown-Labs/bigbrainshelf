import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import UPNG from "upng-js";
import {
  applyLiftedPose,
  boxesMatch,
  cutoutKey,
  normalizePoseMeta,
  saveCharacterGallery,
  type GalleryBox,
  type GalleryEntry,
  type GalleryManifest,
} from "../src/lib/cast-gallery";
import {
  claimNextLiftJob,
  completeLiftJob,
  decodePngBase64,
  enqueueLiftJob,
  ensureLiftJobsTable,
  failLiftJob,
  getLiftJob,
  liftWorkerTokenOk,
  listLiftJobs,
} from "../src/lib/lift-jobs";

// ---------------------------------------------------------------------------
// lift_jobs against in-memory sqlite (same adapter pattern as
// review-notes.test.ts)
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
  };
  return db;
}

const BOX: GalleryBox = { x: 0.1, y: 0.1, w: 0.4, h: 0.5 };
const T0 = 1_700_000_000;

function enq(db: any, slug: string, poseIndex: number, now = T0) {
  return enqueueLiftJob(db, { slug, poseIndex, box: BOX, sheetKey: "characters/x.png", now });
}

describe("lift job queue", () => {
  test("enqueue, dedupe while active, claim oldest first, complete", async () => {
    const db = makeDb();
    await ensureLiftJobsTable(db);
    const a = await enq(db, "ada", 2);
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error("unreachable");
    expect(a.job.status).toBe("queued");
    expect(a.job.pose_index).toBe(2);
    expect(a.job.box).toEqual(BOX);

    const dup = await enq(db, "ada", 2);
    expect(dup.ok).toBe(false);
    if (dup.ok) throw new Error("unreachable");
    expect(dup.existing?.id).toBe(a.job.id); // one active job per pose

    const other = await enq(db, "ada", 0, T0 + 5);
    expect(other.ok).toBe(true);
    if (!other.ok) throw new Error("unreachable");
    expect(other.job.id).not.toBe(a.job.id);

    const claimed = await claimNextLiftJob(db, T0 + 10);
    expect(claimed!.id).toBe(a.job.id); // oldest first
    expect(claimed!.status).toBe("running");
    expect(claimed!.started_at).toBe(T0 + 10);

    expect((await completeLiftJob(db, "no-such-job", T0 + 20)).ok).toBe(false);
    expect((await completeLiftJob(db, other.job.id, T0 + 20)).ok).toBe(false); // still queued
    expect((await completeLiftJob(db, a.job.id, T0 + 20)).ok).toBe(true);
    const done = await getLiftJob(db, a.job.id);
    expect(done!.status).toBe("done");
    expect(done!.finished_at).toBe(T0 + 20);

    // A completed pose can be lifted again.
    const again = await enq(db, "ada", 2, T0 + 30);
    expect(again.ok).toBe(true);
    const jobs = await listLiftJobs(db, "ada");
    expect(jobs.length).toBe(3);
    expect(jobs[0].id).toBe(again.ok ? again.job.id : ""); // newest first
  });

  test("fail records the error and frees the pose", async () => {
    const db = makeDb();
    await ensureLiftJobsTable(db);
    const job = await enq(db, "basil", 1);
    if (!job.ok) throw new Error("unreachable");
    await claimNextLiftJob(db, T0 + 1);
    expect((await failLiftJob(db, job.job.id, "matte exploded", T0 + 2)).ok).toBe(true);
    const stored = await getLiftJob(db, job.job.id);
    expect(stored!.status).toBe("failed");
    expect(stored!.error).toBe("matte exploded");
    const retry = await enq(db, "basil", 1, T0 + 3);
    expect(retry.ok).toBe(true);
  });

  test("a crashed worker's running job is reclaimed once stale", async () => {
    const db = makeDb();
    await ensureLiftJobsTable(db);
    const job = await enq(db, "wren", 0);
    if (!job.ok) throw new Error("unreachable");
    const claimed = await claimNextLiftJob(db, T0);
    expect(claimed!.id).toBe(job.job.id);
    // Fresh running job is not stolen.
    expect(await claimNextLiftJob(db, T0 + 60)).toBeNull();
    // Past the stale window (30 min) the next claim requeues + reclaims it.
    const reclaimed = await claimNextLiftJob(db, T0 + 31 * 60);
    expect(reclaimed!.id).toBe(job.job.id);
    expect(reclaimed!.status).toBe("running");
    expect(reclaimed!.started_at).toBe(T0 + 31 * 60);
  });

  test("enqueue validation rejects bad slug, pose, and box", async () => {
    const db = makeDb();
    await ensureLiftJobsTable(db);
    expect((await enqueueLiftJob(db, { slug: "Bad Slug!", poseIndex: 0, box: BOX, sheetKey: "k" })).ok).toBe(false);
    expect((await enqueueLiftJob(db, { slug: "ada", poseIndex: 12, box: BOX, sheetKey: "k" })).ok).toBe(false);
    expect((await enqueueLiftJob(db, { slug: "ada", poseIndex: -1, box: BOX, sheetKey: "k" })).ok).toBe(false);
    // An out-of-range box is clamped into the sheet (validBoxes' house rule).
    const clamped = await enqueueLiftJob(db, { slug: "ada", poseIndex: 0, box: { x: 0.9, y: 0, w: 0.4, h: 0.5 }, sheetKey: "k" });
    expect(clamped.ok).toBe(true);
    if (clamped.ok) expect(clamped.job.box.x + clamped.job.box.w).toBeLessThanOrEqual(1);
    expect((await enqueueLiftJob(db, { slug: "ada", poseIndex: 0, box: { x: 0, y: 0, w: 0, h: 0.5 }, sheetKey: "k" })).ok).toBe(false);
    expect((await enqueueLiftJob(db, { slug: "ada", poseIndex: 0, box: null, sheetKey: "k" })).ok).toBe(false);
  });

  test("worker token gate and PNG decode guards", () => {
    const req = (auth?: string) =>
      new Request("https://example.com/api/lift/worker", {
        method: "POST",
        headers: auth ? { Authorization: auth } : {},
      });
    expect(liftWorkerTokenOk(req("Bearer secret"), {})).toBe(false); // unset secret = closed
    expect(liftWorkerTokenOk(req(), { LIFT_WORKER_TOKEN: "secret" })).toBe(false);
    expect(liftWorkerTokenOk(req("secret"), { LIFT_WORKER_TOKEN: "secret" })).toBe(false); // needs Bearer
    expect(liftWorkerTokenOk(req("Bearer Secret"), { LIFT_WORKER_TOKEN: "secret" })).toBe(false);
    expect(liftWorkerTokenOk(req("Bearer secret2"), { LIFT_WORKER_TOKEN: "secret" })).toBe(false);
    expect(liftWorkerTokenOk(req("Bearer secret"), { LIFT_WORKER_TOKEN: "secret" })).toBe(true);

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const b64 = Buffer.from(png).toString("base64");
    expect(decodePngBase64(b64)).toEqual(png);
    expect(decodePngBase64(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]).toString("base64"))).toBeNull();
    expect(decodePngBase64("not base64!!")).toBeNull();
    expect(decodePngBase64("")).toBeNull();
    expect(decodePngBase64(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gallery lift behavior against a fake R2 bucket (cast-gallery.test.ts
// harness pattern)
// ---------------------------------------------------------------------------

class FakeObj {
  body: Uint8Array;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  constructor(body: Uint8Array) {
    this.body = body;
    this.uploaded = new Date();
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.body.buffer.slice(this.body.byteOffset, this.body.byteOffset + this.body.byteLength) as ArrayBuffer;
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(this.body);
  }
  async json<T>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }
}

class FakeBooks {
  store = new Map<string, FakeObj>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
    let bytes: Uint8Array;
    if (value instanceof Uint8Array) bytes = value;
    else if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else throw new Error(`FakeBooks.put: unsupported value for ${key}`);
    const obj = new FakeObj(bytes);
    obj.httpMetadata = opts?.httpMetadata;
    this.store.set(key, obj);
    return obj;
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async head(key: string) {
    return this.store.get(key) ?? null;
  }
}

function solidPng(rgb: [number, number, number], w = 4, h = 4): Uint8Array {
  // A real PNG (the save path decodes images); the distinct fill per
  // call site is what the byte comparisons assert on.
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(UPNG.encode([data.buffer as ArrayBuffer], w, h, 0));
}

const BOXES: GalleryBox[] = [
  { x: 0.0, y: 0.0, w: 0.5, h: 0.6 },
  { x: 0.5, y: 0.0, w: 0.5, h: 0.6 },
  { x: 0.25, y: 0.6, w: 0.5, h: 0.4 },
];

async function seedGallery(books: FakeBooks): Promise<GalleryEntry> {
  const entry: GalleryEntry = {
    slug: "testchar",
    name: "Test Char",
    bookSlug: "testbook",
    bookTitle: "Test Book",
    sheetKey: "characters/testchar.jpg",
    sheetSize: { w: 100, h: 100 },
    poseCount: 3,
    portraitIndex: 1,
    boxes: BOXES.map((b) => ({ ...b })),
    v: 1,
  };
  const manifest: GalleryManifest = { v: 1, updatedAt: "2026-01-01T00:00:00Z", characters: { testchar: entry } };
  await books.put("cast-gallery/manifest.json", JSON.stringify(manifest));
  await books.put("characters/testchar.jpg", solidPng([200, 190, 170], 100, 100));
  // Pose files as the sheet-crop pipeline would have made them.
  for (let n = 1; n <= 3; n++) {
    await books.put(`cast-gallery/testchar/pose-${n}.png`, solidPng([10 * n, 0, 0], 50, 60));
  }
  await books.put("cast-gallery/testchar/portrait.png", solidPng([20, 0, 0], 50, 60));
  return entry;
}

describe("gallery lift behavior", () => {
  test("normalizePoseMeta keeps the lifted triple only as a full set", () => {
    const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const full = normalizePoseMeta(
      [{ action: "swimming", lifted: true, cutoutKey: "cast-gallery/x/cutout-1.png", liftedBox: box }],
      1
    )[0];
    expect(full.lifted).toBe(true);
    expect(full.cutoutKey).toBe("cast-gallery/x/cutout-1.png");
    expect(full.liftedBox).toEqual(box);
    expect(full.action).toBe("swimming");

    const partial = normalizePoseMeta([{ action: "", lifted: true }], 1)[0];
    expect(partial.lifted).toBeUndefined();
    expect(partial.cutoutKey).toBeUndefined();

    const noBox = normalizePoseMeta([{ action: "", lifted: true, cutoutKey: "k" }], 1)[0];
    expect(noBox.lifted).toBeUndefined();
  });

  test("boxesMatch follows the editor's snapshot rounding", () => {
    expect(boxesMatch(BOXES[0], { ...BOXES[0] })).toBe(true);
    expect(boxesMatch(BOXES[0], { ...BOXES[0], x: BOXES[0].x + 0.000001 })).toBe(true);
    expect(boxesMatch(BOXES[0], { ...BOXES[0], x: BOXES[0].x + 0.001 })).toBe(false);
  });

  test("applyLiftedPose lands the placed image, the cutout, and the meta", async () => {
    const books = new FakeBooks();
    const entry = await seedGallery(books);
    const placed = solidPng([1, 2, 3], 50, 60);
    const cutout = solidPng([4, 5, 6], 30, 40);
    const res = await applyLiftedPose(books as never, "testchar", 2, placed, cutout, BOXES[2]);

    const poseObj = await books.get("cast-gallery/testchar/pose-3.png");
    expect(new Uint8Array(await poseObj!.arrayBuffer())).toEqual(placed);
    const cutObj = await books.get(cutoutKey("testchar", 3));
    expect(new Uint8Array(await cutObj!.arrayBuffer())).toEqual(cutout);

    const meta = res.entry.poseMeta?.[2];
    expect(meta?.lifted).toBe(true);
    expect(meta?.cutoutKey).toBe("cast-gallery/testchar/cutout-3.png");
    expect(meta?.liftedBox).toEqual(BOXES[2]);
    expect(res.entry.v).toBe((entry.v || 1) + 1);
    expect(res.backupTs).toBeGreaterThan(0);
    // The pre-lift crop is preserved under the backup prefix.
    const backup = await books.get(`cast-gallery/testchar/backup-${res.backupTs}/pose-3.png`);
    expect(backup).not.toBeNull();
    // Pose 3 is not the portrait: portrait.png keeps the pose-2 crop.
    const portrait = await books.get("cast-gallery/testchar/portrait.png");
    expect(new Uint8Array(await portrait!.arrayBuffer())).toEqual(solidPng([20, 0, 0], 50, 60));
  });

  test("lifting the portrait pose replaces portrait.png too", async () => {
    const books = new FakeBooks();
    await seedGallery(books);
    const placed = solidPng([7, 8, 9], 50, 60);
    await applyLiftedPose(books as never, "testchar", 1, placed, solidPng([1, 1, 1]), BOXES[1]);
    const portrait = await books.get("cast-gallery/testchar/portrait.png");
    expect(new Uint8Array(await portrait!.arrayBuffer())).toEqual(placed);
  });

  test("a save with the box unchanged preserves the placed image", async () => {
    const books = new FakeBooks();
    const entry = await seedGallery(books);
    const placed = solidPng([1, 2, 3], 50, 60);
    await applyLiftedPose(books as never, "testchar", 2, placed, solidPng([4, 5, 6]), BOXES[2]);

    const saved = await saveCharacterGallery(
      books as never,
      "testchar",
      BOXES.map((b) => ({ ...b })),
      entry.portraitIndex,
      { poseMeta: [{}, {}, {}], keepOrder: true }
    );
    const poseObj = await books.get("cast-gallery/testchar/pose-3.png");
    expect(new Uint8Array(await poseObj!.arrayBuffer())).toEqual(placed);
    expect(saved.entry.poseMeta?.[2]?.lifted).toBe(true);
    expect(saved.entry.poseMeta?.[2]?.cutoutKey).toBe("cast-gallery/testchar/cutout-3.png");
  });

  test("a save with the box moved clears the lift and ships a fresh crop", async () => {
    const books = new FakeBooks();
    const entry = await seedGallery(books);
    const placed = solidPng([1, 2, 3], 50, 60);
    await applyLiftedPose(books as never, "testchar", 2, placed, solidPng([4, 5, 6]), BOXES[2]);

    const moved = BOXES.map((b) => ({ ...b }));
    moved[2] = { ...moved[2], x: moved[2].x + 0.05, w: moved[2].w - 0.05 };
    const saved = await saveCharacterGallery(
      books as never,
      "testchar",
      moved,
      entry.portraitIndex,
      { poseMeta: [{}, {}, {}], keepOrder: true }
    );
    const poseObj = await books.get("cast-gallery/testchar/pose-3.png");
    expect(new Uint8Array(await poseObj!.arrayBuffer())).not.toEqual(placed);
    expect(saved.entry.poseMeta?.[2]?.lifted).toBeUndefined();
    expect(saved.entry.poseMeta?.[2]?.cutoutKey).toBeUndefined();
  });
});
