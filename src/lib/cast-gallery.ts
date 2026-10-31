// Cast gallery manifest: the Meet the Cast pose galleries.
//
// The manifest lives at cast-gallery/manifest.json in R2 (seeded by
// scripts/derive-cast-boxes.py from the baked src/data/cast-gallery.json
// plus per-pose source boxes). Public pages read it through
// loadCastGallery() with a short in-isolate cache and fall back to the
// baked copy, so admin crop edits go live without a code deploy.
//
// Each character entry carries, beyond the extraction fields:
//   boxes:         [{x, y, w, h}] fractions of the source sheet, in
//                  reading order; a box is the EXACT region cropped
//                  into pose-{n}.png (pipeline padding included).
//                  Pixel origin = round(fraction * sheet dimension).
//   portraitIndex: which box becomes portrait.png (default 0).
//   sheetSize:     {w, h} of the source sheet in pixels.
//   v:             art version, bumped on every admin save; public
//                  pages append ?v={v} so caches never serve stale art.
//
// Saves are recoverable: before a character's gallery is overwritten,
// its current crops + manifest entry are copied to
// cast-gallery/{slug}/backup-{ts}/ and can be restored wholesale.

import UPNG from "upng-js";
import bakedGallery from "../data/cast-gallery.json";
import {
  decodeImage,
  getCropsManifest,
  saveCropsManifest,
  makeTag,
  actionSlug,
  type CropEntry,
} from "./crops";
import { nameKey } from "./character-sheets";

import { R2_PUBLIC, MEDIA_PUBLIC, mediaUrl } from "./media";
export { R2_PUBLIC };
export { mediaUrl as castMediaUrl };
export const GALLERY_MANIFEST_KEY = "cast-gallery/manifest.json";

export interface GalleryBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GalleryFocal {
  x: number;
  y: number;
}

/** Per-pose editor metadata, parallel to boxes/poses:
 *   action: optional factory action token (slug form, e.g. "swimming");
 *           a tagged pose is mirrored into the home book's factory
 *           crops manifest as {character}-p{n}-{action}.
 *   focal:  optional display focal point (fractions of the pose crop);
 *           public object-cover frames render with object-position
 *           derived from it. Absent = centered (0.5, 0.5).
 *   lifted: the pose's PNG is not a sheet crop but a placed cutout
 *           (subject matted off the sheet and composed on clean cream
 *           by the Lift pipeline, src/lib/lift-jobs.ts). cutoutKey is
 *           the transparent cutout in R2; liftedBox is the saved box
 *           the lift was computed from. A gallery save whose box still
 *           matches liftedBox keeps the placed art; a save that moves
 *           the box clears the triple and ships a normal crop.
 *   edited: the pose's PNG carries Erase edits (brush fills and/or
 *           SAM click-removes made in the crop editor) on top of its
 *           crop or placed art. Server-owned like the lifted triple:
 *           a save that ships new edit bytes sets it, a save that
 *           keeps the box (and therefore the edited bytes) preserves
 *           it, and a save that moves the box clears it along with
 *           eraseInfo, because the pose ships as a fresh sheet crop.
 *           eraseInfo is a small summary: when the edit landed (ms
 *           epoch), how many click-removes it includes, and whether
 *           the brush or the lasso touched it (lasso is sparse: the
 *           key only appears when true). shape (also sparse) marks
 *           a sheet shape cut: the pose's picture is not a crop or
 *           an erase of one, but the bounding box of an outline
 *           traced on the SHEET itself, inside kept and outside
 *           filled with the sheet's background. A shape payload is
 *           the one edit allowed to CHANGE its pose's box (to the
 *           trace's bounding box); it also clears any lifted state,
 *           because the picture is sheet-derived again. */
export interface GalleryEraseInfo {
  at: number;
  sam: number;
  brush: boolean;
  lasso?: boolean;
  shape?: boolean;
}

export interface GalleryPoseMeta {
  action?: string;
  focal?: GalleryFocal;
  lifted?: boolean;
  cutoutKey?: string;
  liftedBox?: GalleryBox;
  edited?: boolean;
  eraseInfo?: GalleryEraseInfo;
}

export interface GalleryEntry {
  name: string;
  bookSlug: string;
  sheetKey: string;
  portrait: string;
  poses: string[];
  poseCount: number;
  method?: string;
  published?: boolean;
  boxes?: GalleryBox[];
  portraitIndex?: number;
  sheetSize?: { w: number; h: number };
  v?: number;
  poseMeta?: GalleryPoseMeta[];
}

export interface GalleryManifest {
  generatedAt?: number;
  characters: Record<string, GalleryEntry>;
}

export function bakedManifest(): GalleryManifest {
  return bakedGallery as unknown as GalleryManifest;
}

// ------------------------------------------------------------ runtime read

const CACHE_TTL_MS = 60_000;
let cache: { at: number; manifest: GalleryManifest } | null = null;

export async function loadCastGallery(BOOKS: any): Promise<GalleryManifest> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.manifest;
  try {
    const obj = await BOOKS.get(GALLERY_MANIFEST_KEY);
    if (obj) {
      const parsed = JSON.parse(await obj.text());
      if (parsed && parsed.characters && typeof parsed.characters === "object") {
        cache = { at: now, manifest: parsed as GalleryManifest };
        return cache.manifest;
      }
    }
  } catch {
    /* fall through to the baked copy */
  }
  return bakedManifest();
}

export function invalidateCastGalleryCache(): void {
  cache = null;
}

export async function saveCastGallery(BOOKS: any, manifest: GalleryManifest): Promise<void> {
  await BOOKS.put(GALLERY_MANIFEST_KEY, JSON.stringify(manifest, null, 1), {
    httpMetadata: { contentType: "application/json" },
  });
  cache = { at: Date.now(), manifest };
}

// ------------------------------------------------------------ box helpers

export function clampBox(b: GalleryBox): GalleryBox {
  const x = Math.max(0, Math.min(0.99, b.x));
  const y = Math.max(0, Math.min(0.99, b.y));
  const w = Math.max(0.01, Math.min(1 - x, b.w));
  const h = Math.max(0.01, Math.min(1 - y, b.h));
  return { x, y, w, h };
}

export function validBoxes(raw: any): GalleryBox[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 12) return null;
  const out: GalleryBox[] = [];
  for (const b of raw) {
    if (!b || ![b.x, b.y, b.w, b.h].every((v: any) => typeof v === "number" && Number.isFinite(v))) {
      return null;
    }
    if (b.w < 0.01 || b.h < 0.01) return null;
    out.push(clampBox({ x: b.x, y: b.y, w: b.w, h: b.h }));
  }
  return out;
}

// ------------------------------------------------------------ pose meta

export const DEFAULT_FOCAL: GalleryFocal = { x: 0.5, y: 0.5 };

export function validFocal(raw: any): GalleryFocal | null {
  if (!raw || typeof raw !== "object") return null;
  const { x, y } = raw;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
  };
}

/** Sanitize a raw erase summary; null when it carries nothing sane. */
export function validEraseInfo(raw: any): GalleryEraseInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const samRaw = Number(raw.sam);
  const sam = Number.isFinite(samRaw) ? Math.max(0, Math.min(99, Math.floor(samRaw))) : 0;
  const info: GalleryEraseInfo = { at: Math.floor(at), sam, brush: raw.brush === true };
  if (raw.lasso === true) info.lasso = true;
  if (raw.shape === true) info.shape = true;
  return info;
}

/** Normalize raw per-pose metadata to exactly `count` entries. Actions
 * are stored in slug form; a focal point equal to the centered default
 * is dropped (absent and centered mean the same thing everywhere). The
 * lifted triple (lifted + cutoutKey + liftedBox) is preserved only as a
 * complete set: a partial lifted state is meaningless and dropped. The
 * edited flag survives only with a sane eraseInfo beside it. */
export function normalizePoseMeta(raw: any, count: number): GalleryPoseMeta[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: GalleryPoseMeta[] = [];
  for (let i = 0; i < count; i++) {
    const m = list[i] && typeof list[i] === "object" ? list[i] : {};
    const meta: GalleryPoseMeta = {};
    const action = actionSlug(String(m.action ?? ""));
    if (action) meta.action = action;
    const f = validFocal(m.focal);
    if (f && (f.x !== DEFAULT_FOCAL.x || f.y !== DEFAULT_FOCAL.y)) meta.focal = f;
    if (m.lifted === true && typeof m.cutoutKey === "string" && m.cutoutKey) {
      const lb = validBoxes([m.liftedBox]);
      if (lb) {
        meta.lifted = true;
        meta.cutoutKey = m.cutoutKey;
        meta.liftedBox = lb[0];
      }
    }
    if (m.edited === true) {
      const info = validEraseInfo(m.eraseInfo);
      if (info) {
        meta.edited = true;
        meta.eraseInfo = info;
      }
    }
    out.push(meta);
  }
  return out;
}

/** Box equality at the editor's snapshot precision (1e-5), the same
 * rounding the crop editor's dirty check uses. */
export function boxesMatch(a?: GalleryBox | null, b?: GalleryBox | null): boolean {
  if (!a || !b) return false;
  const r = (v: number) => Math.round(v * 100000) / 100000;
  return r(a.x) === r(b.x) && r(a.y) === r(b.y) && r(a.w) === r(b.w) && r(a.h) === r(b.h);
}

export function focalFor(
  entry: { poseMeta?: GalleryPoseMeta[] },
  index: number
): GalleryFocal {
  return entry.poseMeta?.[index]?.focal ?? DEFAULT_FOCAL;
}

/** CSS object-position value for a focal point. Percentage semantics
 * line up exactly: the focal fraction of the image is placed at the
 * same fraction of the frame. */
export function objectPosition(f: GalleryFocal): string {
  const pct = (v: number) => `${Math.round(v * 10000) / 100}%`;
  return `${pct(f.x)} ${pct(f.y)}`;
}

// Reading order, a port of the extraction script's row grouping:
// group boxes into rows by top edge (tolerance = 0.38 * median box
// height), then left-to-right inside each row. Returns the boxes with
// their original indices so a portrait pick survives the sort.
export function sortBoxesReadingOrder<T extends GalleryBox>(
  boxes: T[]
): { box: T; from: number }[] {
  const heights = boxes.map((b) => b.h).sort((a, b) => a - b);
  const tol = 0.38 * heights[Math.floor(heights.length / 2)];
  const indexed = boxes.map((box, from) => ({ box, from }));
  indexed.sort((a, b) => a.box.y - b.box.y);
  const rows: { box: T; from: number }[][] = [];
  for (const item of indexed) {
    const last = rows[rows.length - 1];
    if (last && item.box.y - Math.min(...last.map((r) => r.box.y)) <= tol) {
      last.push(item);
    } else {
      rows.push([item]);
    }
  }
  const out: { box: T; from: number }[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.box.x - b.box.x);
    out.push(...row);
  }
  return out;
}

export function versioned(url: string, v?: number): string {
  if (!url || !v || v < 1) return url;
  return url + (url.includes("?") ? "&" : "?") + "v=" + v;
}

export function poseKey(slug: string, n: number): string {
  return `cast-gallery/${slug}/pose-${n}.png`;
}

/** Transparent cutout written by the Lift pipeline for pose n (1-based). */
export function cutoutKey(slug: string, n: number): string {
  return `cast-gallery/${slug}/cutout-${n}.png`;
}

export function portraitKey(slug: string): string {
  return `cast-gallery/${slug}/portrait.png`;
}

// Crop one box out of a decoded sheet. Pixel origin/size use round(),
// the convention the recorded boxes were derived with, so an untouched
// box re-crops to the same pixels the pipeline shipped.
export function cropDecodedBox(
  img: { data: Uint8Array; width: number; height: number },
  box: GalleryBox
): { png: Uint8Array; px: { x: number; y: number; w: number; h: number } } {
  const W = img.width;
  const H = img.height;
  const x0 = Math.max(0, Math.min(W - 1, Math.round(box.x * W)));
  const y0 = Math.max(0, Math.min(H - 1, Math.round(box.y * H)));
  const w = Math.max(1, Math.min(W - x0, Math.round(box.w * W)));
  const h = Math.max(1, Math.min(H - y0, Math.round(box.h * H)));
  if (w < 16 || h < 16) {
    throw new Error(`crop region too small (${w}x${h}px); a pose box needs a real drag`);
  }
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * W + x0) * 4;
    out.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  const png = new Uint8Array(UPNG.encode([out.buffer as ArrayBuffer], w, h, 0));
  return { png, px: { x: x0, y: y0, w, h } };
}

export function cropSheetBox(
  sheetBytes: Uint8Array,
  box: GalleryBox
): { png: Uint8Array; px: { x: number; y: number; w: number; h: number }; sheetSize: { w: number; h: number } } {
  const img = decodeImage(sheetBytes);
  const r = cropDecodedBox(img, box);
  return { ...r, sheetSize: { w: img.width, h: img.height } };
}

// ------------------------------------------------------------ backups

function backupPrefix(slug: string, ts: number): string {
  return `cast-gallery/${slug}/backup-${ts}/`;
}

/** Every backup timestamp for a character, newest first. Backups
 * are never pruned: each save, lift, and restore snapshots the
 * pre-change gallery under backup-{ts}/, so this list is the
 * character's full saved history. */
export async function listBackupTimestamps(BOOKS: any, slug: string): Promise<number[]> {
  try {
    const listed = await BOOKS.list({ prefix: `cast-gallery/${slug}/backup-`, limit: 1000 });
    const seen = new Set<number>();
    for (const o of listed?.objects || []) {
      const m = new RegExp(`^cast-gallery/${slug}/backup-(\\d+)/`).exec(String(o.key));
      if (m) seen.add(parseInt(m[1], 10));
    }
    return [...seen].sort((a, b) => b - a);
  } catch {
    return [];
  }
}

export async function latestBackup(BOOKS: any, slug: string): Promise<number | null> {
  const all = await listBackupTimestamps(BOOKS, slug);
  return all.length ? all[0] : null;
}

async function backupCurrent(
  BOOKS: any,
  slug: string,
  entry: GalleryEntry,
  ts: number
): Promise<void> {
  const prefix = backupPrefix(slug, ts);
  const copy = async (fromKey: string, toKey: string) => {
    const obj = await BOOKS.get(fromKey);
    if (obj) {
      await BOOKS.put(toKey, await obj.arrayBuffer(), {
        httpMetadata: { contentType: "image/png" },
      });
    }
  };
  await copy(portraitKey(slug), `${prefix}portrait.png`);
  for (let i = 1; i <= (entry.poseCount || 0); i++) {
    await copy(poseKey(slug, i), `${prefix}pose-${i}.png`);
  }
  await BOOKS.put(`${prefix}entry.json`, JSON.stringify(entry, null, 1), {
    httpMetadata: { contentType: "application/json" },
  });
}

// ------------------------------------------------------------ save / restore

export interface SaveResult {
  entry: GalleryEntry;
  backupTs: number;
}

export interface PoseEditPayload {
  /** Client-side pose index (aligned with boxesIn / opts.poseMeta). */
  index: number;
  /** The edited pose image: a PNG of exactly the pixel dimensions
   * the pose's box crops to (the editor edits the pose image itself,
   * never a rescaled copy). */
  png: Uint8Array;
  eraseInfo?: unknown;
  /** True when the payload is a sheet shape cut: the picture was
   * produced from the sheet inside an outline the editor traced,
   * and this save's box for the pose IS the trace's bounding box.
   * Shape payloads are exempt from the box-unchanged rule every
   * other edit obeys (their box is supposed to move), are still
   * dimension-validated against the new box, and clear the pose's
   * lifted state: the picture is sheet-derived, not the placed
   * cutout. */
  shape?: boolean;
}

export interface SaveGalleryOptions {
  /** Per-pose metadata aligned with boxesIn (same order). When
   * omitted, the stored poseMeta is carried through the save, remapped
   * through any reordering so a tag/focal stays with its pose. */
  poseMeta?: unknown;
  /** Keep the client's pose order exactly as given (the crop editor's
   * reorder controls). Default false preserves the original behavior:
   * boxes are renumbered in reading order. */
  keepOrder?: boolean;
  /** Erase edits to ship instead of crops, keyed by client pose
   * index. An edit only lands when its pose's box is unchanged in
   * this save: the edited pixels were painted on the image the old
   * box produced, so a moved box invalidates them exactly like a
   * lift, and the pose ships as a fresh crop instead. */
  poseEdits?: PoseEditPayload[];
}

/** Re-crop a character's whole gallery from new boxes. Backs up the
 * current gallery first; throws before touching anything live when the
 * sheet is missing or a box fails to crop. */
export async function saveCharacterGallery(
  BOOKS: any,
  slug: string,
  boxesIn: GalleryBox[],
  portraitIndexIn: number,
  opts: SaveGalleryOptions = {}
): Promise<SaveResult> {
  const manifest = await loadCastGallery(BOOKS);
  const entry = manifest.characters[slug];
  if (!entry) throw new Error(`no gallery entry for '${slug}'`);
  if (!entry.sheetKey) throw new Error(`gallery entry for '${slug}' has no sheetKey`);

  const sheetObj = await BOOKS.get(entry.sheetKey);
  if (!sheetObj) throw new Error(`sheet bytes missing in R2 (${entry.sheetKey})`);
  const sheetBytes = new Uint8Array(await sheetObj.arrayBuffer());
  const decoded = decodeImage(sheetBytes);

  // Order the boxes, remembering which box was the portrait. Legacy
  // saves sort into reading order; the editor's explicit order (its
  // reorder controls) is kept verbatim when keepOrder is set.
  const ordered = opts.keepOrder
    ? boxesIn.map((box, from) => ({ box, from }))
    : sortBoxesReadingOrder(boxesIn);
  const boxes = ordered.map((o) => o.box);
  const portraitIndex = Math.max(
    0,
    ordered.findIndex((o) => o.from === portraitIndexIn)
  );

  // Pose metadata follows its pose through the ordering.
  const rawMeta = Array.isArray(opts.poseMeta) ? opts.poseMeta : entry.poseMeta;
  const poseMeta = normalizePoseMeta(
    ordered.map((o) => (Array.isArray(rawMeta) ? rawMeta[o.from] : undefined)),
    boxes.length
  );
  // The edited flag is server-owned state, decided below from the
  // stored meta + this save's edit payloads; never inherit it from
  // the raw meta pass (a fresh crop with a stale flag would lie).
  for (const m of poseMeta) {
    delete m.edited;
    delete m.eraseInfo;
  }

  // Lifted poses: the lifted triple is server-owned state (the editor
  // never sends it), so it is read from the STORED entry, mapped
  // through the same ordering. A lifted pose whose box still matches
  // the box it was lifted from keeps its placed art (the save must not
  // stomp it with a fresh rectangular crop); a lifted pose whose box
  // moved loses the triple here and ships a normal crop below.
  const storedMeta = normalizePoseMeta(entry.poseMeta, entry.poseCount || 0);
  const storedBoxes = entry.boxes || [];
  const preservedFrom = new Map<number, number>(); // new index -> pre-save index
  ordered.forEach((o, i) => {
    const stored = storedMeta[o.from];
    if (stored?.lifted && stored.cutoutKey && stored.liftedBox && boxesMatch(boxes[i], stored.liftedBox)) {
      poseMeta[i].lifted = true;
      poseMeta[i].cutoutKey = stored.cutoutKey;
      poseMeta[i].liftedBox = stored.liftedBox;
      preservedFrom.set(i, o.from);
    }
  });

  // Erase edits, keyed by client (pre-ordering) index. An edit is
  // only valid while its pose's box is the box it was painted under:
  // unchanged against the STORED box, and, for a lifted pose, also
  // unchanged against liftedBox (the save's lifted check above). A
  // valid edit ships its bytes and stamps edited + eraseInfo; a
  // stored edit whose box did not move is preserved with its bytes,
  // like a lift; a moved box drops the whole edited state.
  const editsByFrom = new Map<number, PoseEditPayload>();
  for (const e of opts.poseEdits || []) {
    if (Number.isInteger(e?.index) && e.png instanceof Uint8Array) {
      editsByFrom.set(e.index, e);
    }
  }
  const editedFrom = new Map<number, number>(); // new index -> pre-save index (bytes preserved)
  ordered.forEach((o, i) => {
    const stored = storedMeta[o.from];
    const boxKept = boxesMatch(boxes[i], storedBoxes[o.from]);
    if (editsByFrom.has(o.from)) {
      if (editsByFrom.get(o.from)!.shape === true) {
        // Sheet shape cut: the box moving IS the edit (it becomes
        // the trace's bounding box), so the box-unchanged rule does
        // not apply; the crops loop still validates the bytes
        // against the new box's dimensions. The picture is
        // sheet-derived again, so any lifted state clears.
        const info = validEraseInfo(editsByFrom.get(o.from)!.eraseInfo) ||
          { at: Date.now(), sam: 0, brush: false };
        poseMeta[i].edited = true;
        poseMeta[i].eraseInfo = { ...info, shape: true };
        delete poseMeta[i].lifted;
        delete poseMeta[i].cutoutKey;
        delete poseMeta[i].liftedBox;
        preservedFrom.delete(i);
      } else if (!boxKept || (poseMeta[i].lifted === undefined && stored?.lifted)) {
        // The box moved (or the lift it rode on just cleared): the
        // painted pixels no longer line up with the pose. Drop the
        // edit rather than ship a misaligned image.
        editsByFrom.delete(o.from);
      } else {
        const info = validEraseInfo(editsByFrom.get(o.from)!.eraseInfo) ||
          stored?.eraseInfo || { at: Date.now(), sam: 0, brush: true };
        poseMeta[i].edited = true;
        poseMeta[i].eraseInfo = info;
      }
    } else if (stored?.edited && stored.eraseInfo && boxKept) {
      poseMeta[i].edited = true;
      poseMeta[i].eraseInfo = stored.eraseInfo;
      if (!preservedFrom.has(i)) editedFrom.set(i, o.from);
    }
  });

  // Crop everything up front: a bad box aborts before any live write.
  // Edit payloads are validated here too (real PNG, exactly the pixel
  // dimensions the box crops to) so a bad edit aborts the same way.
  // Preserved lifted poses reuse their current (placed) bytes instead
  // of a fresh crop; preserved edited poses reuse their edited bytes;
  // if those bytes are somehow gone, fall back to the crop and drop
  // the corresponding claim.
  const crops: Uint8Array[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const edit = editsByFrom.get(ordered[i].from);
    if (edit) {
      const expected = cropDecodedBox(decoded, boxes[i]);
      const got = decodeImage(edit.png);
      if (got.width !== expected.px.w || got.height !== expected.px.h) {
        throw new Error(
          `erase edit for pose ${i + 1} is ${got.width}x${got.height}px but the pose box crops to ${expected.px.w}x${expected.px.h}px; reload the character and erase again`
        );
      }
      crops.push(edit.png);
      continue;
    }
    const from = preservedFrom.get(i) ?? editedFrom.get(i);
    if (from !== undefined) {
      const existing = await BOOKS.get(poseKey(slug, from + 1)).catch(() => null);
      if (existing) {
        crops.push(new Uint8Array(await existing.arrayBuffer()));
        continue;
      }
      if (preservedFrom.has(i)) {
        delete poseMeta[i].lifted;
        delete poseMeta[i].cutoutKey;
        delete poseMeta[i].liftedBox;
      }
      if (editedFrom.has(i)) {
        delete poseMeta[i].edited;
        delete poseMeta[i].eraseInfo;
      }
    }
    crops.push(cropDecodedBox(decoded, boxes[i]).png);
  }

  const backupTs = Math.floor(Date.now() / 1000);
  await backupCurrent(BOOKS, slug, entry, backupTs);

  const oldCount = entry.poseCount || 0;
  for (let i = 0; i < crops.length; i++) {
    await BOOKS.put(poseKey(slug, i + 1), crops[i], {
      httpMetadata: { contentType: "image/png" },
    });
  }
  await BOOKS.put(portraitKey(slug), crops[portraitIndex], {
    httpMetadata: { contentType: "image/png" },
  });
  for (let i = crops.length + 1; i <= oldCount; i++) {
    await BOOKS.delete(poseKey(slug, i));
  }

  const updated: GalleryEntry = {
    ...entry,
    boxes,
    portraitIndex,
    poseMeta: poseMeta.some((m) => m.action || m.focal || m.lifted || m.edited) ? poseMeta : undefined,
    poseCount: crops.length,
    poses: crops.map((_, i) => `${MEDIA_PUBLIC}${poseKey(slug, i + 1)}`),
    portrait: `${MEDIA_PUBLIC}${portraitKey(slug)}`,
    v: (entry.v || 1) + 1,
  };
  manifest.characters[slug] = updated;
  await saveCastGallery(BOOKS, manifest);
  return { entry: updated, backupTs };
}

/** Restore the newest backup of a character's gallery wholesale.
 * The current gallery is snapshotted first (under a fresh
 * timestamp), so the restore is itself undoable: restoring again
 * brings back the state this restore replaced. */
export async function restoreCharacterGallery(
  BOOKS: any,
  slug: string
): Promise<{ entry: GalleryEntry; backupTs: number }> {
  const manifest = await loadCastGallery(BOOKS);
  const entry = manifest.characters[slug];
  if (!entry) throw new Error(`no gallery entry for '${slug}'`);
  const ts = await latestBackup(BOOKS, slug);
  if (ts === null) throw new Error(`no backup exists for '${slug}'`);
  const prefix = backupPrefix(slug, ts);

  // Snapshot-then-restore: the pre-restore state becomes the newest
  // backup, which is what makes a second restore a redo.
  const snapshotTs = Math.max(Math.floor(Date.now() / 1000), ts + 1);
  await backupCurrent(BOOKS, slug, entry, snapshotTs);

  const entryObj = await BOOKS.get(`${prefix}entry.json`);
  if (!entryObj) throw new Error(`backup ${ts} for '${slug}' is missing its entry.json`);
  const prior = JSON.parse(await entryObj.text()) as GalleryEntry;
  const count = prior.poseCount || 0;

  const copyBack = async (fromKey: string, toKey: string) => {
    const obj = await BOOKS.get(fromKey);
    if (obj) {
      await BOOKS.put(toKey, await obj.arrayBuffer(), {
        httpMetadata: { contentType: "image/png" },
      });
    }
  };
  await copyBack(`${prefix}portrait.png`, portraitKey(slug));
  for (let i = 1; i <= count; i++) {
    await copyBack(`${prefix}pose-${i}.png`, poseKey(slug, i));
  }
  for (let i = count + 1; i <= (entry.poseCount || 0); i++) {
    await BOOKS.delete(poseKey(slug, i));
  }

  const restored: GalleryEntry = { ...prior, v: (entry.v || 1) + 1 };
  manifest.characters[slug] = restored;
  await saveCastGallery(BOOKS, manifest);
  return { entry: restored, backupTs: ts };
}

// ------------------------------------------------------------ pose history

export interface PoseHistoryVersion {
  /** Backup timestamp (seconds) this version was snapshotted at. */
  ts: number;
  /** The pose slot's metadata in that version (null = plain crop). */
  meta: GalleryPoseMeta | null;
  /** Byte size of the pose picture in that version. */
  size: number;
  /** True when the version's bytes are byte-identical to the live
   * pose picture (restoring it would change nothing). */
  isCurrent: boolean;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function readBackupEntry(
  BOOKS: any,
  slug: string,
  ts: number
): Promise<GalleryEntry | null> {
  try {
    const obj = await BOOKS.get(`${backupPrefix(slug, ts)}entry.json`);
    if (!obj) return null;
    return JSON.parse(await obj.text()) as GalleryEntry;
  } catch {
    return null;
  }
}

/** The recent saved versions of ONE pose slot, newest first. Each
 * backup is a whole-character snapshot; a version is listed when
 * that slot existed in it and its picture is still in the backup.
 * Versions are per SLOT: if poses were reordered between saves, an
 * old version of this slot is whatever picture sat in it then. */
export async function listPoseHistory(
  BOOKS: any,
  slug: string,
  poseIndex: number,
  limit = 6
): Promise<PoseHistoryVersion[]> {
  const manifest = await loadCastGallery(BOOKS);
  const entry = manifest.characters[slug];
  if (!entry) throw new Error(`no gallery entry for '${slug}'`);
  if (!Number.isInteger(poseIndex) || poseIndex < 0 || poseIndex >= (entry.poseCount || 0)) {
    throw new Error(`pose ${poseIndex + 1} does not exist for '${slug}'`);
  }
  const liveObj = await BOOKS.get(poseKey(slug, poseIndex + 1)).catch(() => null);
  const liveBytes = liveObj ? new Uint8Array(await liveObj.arrayBuffer()) : null;

  const out: PoseHistoryVersion[] = [];
  for (const ts of await listBackupTimestamps(BOOKS, slug)) {
    if (out.length >= limit) break;
    const prior = await readBackupEntry(BOOKS, slug, ts);
    if (!prior || poseIndex >= (prior.poseCount || 0)) continue;
    const obj = await BOOKS.get(`${backupPrefix(slug, ts)}pose-${poseIndex + 1}.png`).catch(() => null);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const meta = normalizePoseMeta(prior.poseMeta, prior.poseCount || 0)[poseIndex] || null;
    out.push({
      ts,
      meta: meta && (meta.action || meta.focal || meta.lifted || meta.edited) ? meta : null,
      size: bytes.length,
      isCurrent: liveBytes !== null && bytesEqual(bytes, liveBytes),
    });
  }
  return out;
}

/** Roll ONE pose slot back to a chosen backup version: its picture,
 * its box, and its per-pose metadata all return to what that
 * version held, and the manifest version bumps so public pages pick
 * the restored art up. The CURRENT gallery is snapshotted first
 * (snapshotTs in the result), so the rollback is itself undoable:
 * restoring that snapshot is a redo. Restoring the version that is
 * already live is a clean no-op (no snapshot, no bump). */
export async function restorePoseVersion(
  BOOKS: any,
  slug: string,
  poseIndex: number,
  ts: number
): Promise<{ entry: GalleryEntry; restoredFrom: number; snapshotTs: number | null }> {
  const manifest = await loadCastGallery(BOOKS);
  const entry = manifest.characters[slug];
  if (!entry) throw new Error(`no gallery entry for '${slug}'`);
  if (!Number.isInteger(poseIndex) || poseIndex < 0 || poseIndex >= (entry.poseCount || 0)) {
    throw new Error(`pose ${poseIndex + 1} does not exist for '${slug}'`);
  }
  const prefix = backupPrefix(slug, ts);
  const prior = await readBackupEntry(BOOKS, slug, ts);
  if (!prior) throw new Error(`backup ${ts} for '${slug}' is missing its entry.json`);
  if (poseIndex >= (prior.poseCount || 0)) {
    throw new Error(`pose ${poseIndex + 1} did not exist in the ${new Date(ts * 1000).toLocaleString()} version`);
  }
  const picObj = await BOOKS.get(`${prefix}pose-${poseIndex + 1}.png`).catch(() => null);
  if (!picObj) throw new Error(`backup ${ts} for '${slug}' is missing pose ${poseIndex + 1}'s picture`);
  const picBytes = new Uint8Array(await picObj.arrayBuffer());

  const liveObj = await BOOKS.get(poseKey(slug, poseIndex + 1)).catch(() => null);
  const liveBytes = liveObj ? new Uint8Array(await liveObj.arrayBuffer()) : null;
  const priorMeta = normalizePoseMeta(prior.poseMeta, prior.poseCount || 0)[poseIndex] || {};
  const curMeta = normalizePoseMeta(entry.poseMeta, entry.poseCount || 0)[poseIndex] || {};
  const priorBox = (prior.boxes || [])[poseIndex] || null;
  const curBox = (entry.boxes || [])[poseIndex] || null;
  const sameState =
    liveBytes !== null &&
    bytesEqual(picBytes, liveBytes) &&
    JSON.stringify(priorMeta) === JSON.stringify(curMeta) &&
    JSON.stringify(priorBox) === JSON.stringify(curBox);
  if (sameState) return { entry, restoredFrom: ts, snapshotTs: null };

  const snapshotTs = Math.max(Math.floor(Date.now() / 1000), ts + 1);
  await backupCurrent(BOOKS, slug, entry, snapshotTs);

  await BOOKS.put(poseKey(slug, poseIndex + 1), picBytes, {
    httpMetadata: { contentType: "image/png" },
  });
  if ((entry.portraitIndex ?? 0) === poseIndex) {
    await BOOKS.put(portraitKey(slug), picBytes, {
      httpMetadata: { contentType: "image/png" },
    });
  }

  const poseMeta = normalizePoseMeta(entry.poseMeta, entry.poseCount || 0);
  poseMeta[poseIndex] = priorMeta;
  const boxes = (entry.boxes || []).slice();
  if (priorBox) boxes[poseIndex] = priorBox;
  const updated: GalleryEntry = {
    ...entry,
    boxes: boxes.length ? boxes : entry.boxes,
    poseMeta: poseMeta.some((m) => m.action || m.focal || m.lifted || m.edited) ? poseMeta : undefined,
    v: (entry.v || 1) + 1,
  };
  manifest.characters[slug] = updated;
  await saveCastGallery(BOOKS, manifest);
  return { entry: updated, restoredFrom: ts, snapshotTs };
}

// ------------------------------------------------------------ lift apply

/** Land a completed Lift job on the gallery: the cutout bytes go to
 * cast-gallery/{slug}/cutout-{n}.png and the placed composition
 * replaces pose-{n}.png (and portrait.png when the lifted pose is the
 * portrait), following the same backup-first convention as a save.
 * The pose's meta gains the lifted triple keyed to `box` (the saved
 * box the lift was computed from), so a later save can tell whether
 * the box still matches. Throws before any live write when the entry
 * or pose does not exist. */
export async function applyLiftedPose(
  BOOKS: any,
  slug: string,
  poseIndex: number, // 0-based
  placedBytes: Uint8Array,
  cutoutBytes: Uint8Array,
  box: GalleryBox
): Promise<SaveResult> {
  const manifest = await loadCastGallery(BOOKS);
  const entry = manifest.characters[slug];
  if (!entry) throw new Error(`no gallery entry for '${slug}'`);
  if (!Number.isInteger(poseIndex) || poseIndex < 0 || poseIndex >= (entry.poseCount || 0)) {
    throw new Error(`pose ${poseIndex + 1} does not exist for '${slug}'`);
  }
  const cKey = cutoutKey(slug, poseIndex + 1);
  await BOOKS.put(cKey, cutoutBytes, {
    httpMetadata: { contentType: "image/png" },
  });

  const backupTs = Math.floor(Date.now() / 1000);
  await backupCurrent(BOOKS, slug, entry, backupTs);

  await BOOKS.put(poseKey(slug, poseIndex + 1), placedBytes, {
    httpMetadata: { contentType: "image/png" },
  });
  if ((entry.portraitIndex ?? 0) === poseIndex) {
    await BOOKS.put(portraitKey(slug), placedBytes, {
      httpMetadata: { contentType: "image/png" },
    });
  }

  const poseMeta = normalizePoseMeta(entry.poseMeta, entry.poseCount || 0);
  // A lift replaces the pose's picture wholesale with the placed
  // composition, so any Erase edits painted on the old picture are
  // gone with it.
  const { edited: _gone, eraseInfo: _goneInfo, ...keptMeta } = poseMeta[poseIndex];
  poseMeta[poseIndex] = {
    ...keptMeta,
    lifted: true,
    cutoutKey: cKey,
    liftedBox: clampBox(box),
  };
  const updated: GalleryEntry = {
    ...entry,
    poseMeta,
    v: (entry.v || 1) + 1,
  };
  manifest.characters[slug] = updated;
  await saveCastGallery(BOOKS, manifest);
  return { entry: updated, backupTs };
}

// ------------------------------------------------------------ tag mirror

export interface MirrorResult {
  mirrored: string[];
  skipped: string[];
}

/** Mirror a character's tagged poses into the home book's factory crop
 * manifest (books/{bookSlug}/crops.json), in the factory's exact entry
 * shape, so Phase 2 conditioning can consume the gallery crops:
 *   { tag, character, action, source: "cast-gallery", bbox,
 *     createdAt, key: cast-gallery/{slug}/pose-{n}.png, sheetKey }
 * The tag's pose number is the gallery pose number. Entries previously
 * mirrored for this character (identified by their gallery key prefix)
 * are replaced wholesale on every run, so retags and reorders never
 * leave stale crops behind; Crop Mode entries (keys under
 * books/{slug}/crops/) are never touched. A tag that already exists in
 * the book manifest pointing at a DIFFERENT crop is skipped and
 * reported rather than overwritten. */
export async function mirrorGalleryTags(
  BOOKS: any,
  slug: string,
  entry: GalleryEntry
): Promise<MirrorResult> {
  const result: MirrorResult = { mirrored: [], skipped: [] };
  const bookSlug = entry.bookSlug;
  if (!bookSlug || !entry.boxes?.length) return result;
  const crops = await getCropsManifest(BOOKS, bookSlug);
  const prefix = `cast-gallery/${slug}/`;
  const mine = (c: CropEntry) =>
    typeof c.key === "string" &&
    c.key.startsWith(prefix) &&
    nameKey(c.character) === nameKey(entry.name);
  const kept = crops.filter((c) => !mine(c));
  const meta = normalizePoseMeta(entry.poseMeta, entry.poseCount || 0);
  const now = Date.now();
  meta.forEach((m, i) => {
    if (!m.action || !entry.boxes?.[i]) return;
    const tag = makeTag(entry.name, i + 1, m.action);
    if (kept.some((c) => c.tag === tag)) {
      result.skipped.push(tag);
      return;
    }
    kept.push({
      tag,
      character: entry.name,
      action: m.action,
      source: "cast-gallery",
      bbox: entry.boxes[i],
      createdAt: now,
      key: poseKey(slug, i + 1),
      sheetKey: entry.sheetKey,
    });
    result.mirrored.push(tag);
  });
  if (result.mirrored.length || kept.length !== crops.length) {
    await saveCropsManifest(BOOKS, bookSlug, kept);
  }
  return result;
}
