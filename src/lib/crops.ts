// Pose crops (hub side): Crop Mode's data + image plumbing.
//
// The factory's pose-crop system (kidsbook-factory/src/crops.ts) reads
// what this module writes:
//   books/{slug}/crops.json            the manifest
//   books/{slug}/crops/{tag}.png       one PNG per crop
// Manifest entry: {tag, character, action, source: "sheet",
//   bbox: {x, y, w, h} (fractions of the source sheet), createdAt,
//   key, sheetKey}. Tag grammar: {character}-p{n}-{action}, lowercase;
//   props ride the action token (skipper-p2-megaphone).
//
// Cropping happens SERVER-side from the sheet bytes (UPNG + jpeg-js,
// the same pure-JS codecs the factory runs in Workers): the admin's
// browser only ever sends fractions, never pixels.

import UPNG from "upng-js";
import jpeg from "jpeg-js";
import { nameKey } from "./character-sheets";

export interface CropEntry {
  tag: string;
  character: string;
  action: string;
  source: string;
  bbox: { x: number; y: number; w: number; h: number };
  createdAt: number;
  key: string;
  sheetKey?: string;
}

export const ACTION_SUGGESTIONS = [
  "standing", "flying", "swimming", "running", "sitting", "carrying",
  "pointing", "megaphone", "sleeping", "eating", "building", "reading",
  "waving", "jumping", "digging", "singing", "pulling", "pushing",
];

export function cropsManifestKey(slug: string): string {
  return `books/${slug}/crops.json`;
}

export function actionSlug(action: string): string {
  return String(action ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function makeTag(character: string, poseNum: number, action: string): string {
  return `${nameKey(character)}-p${poseNum}-${actionSlug(action)}`;
}

export function nextPoseNumber(crops: CropEntry[], character: string): number {
  const nk = nameKey(character);
  let max = 0;
  for (const c of crops) {
    if (nameKey(c.character) !== nk) continue;
    const m = /-p(\d+)-/.exec(c.tag);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

export async function getCropsManifest(BOOKS: any, slug: string): Promise<CropEntry[]> {
  try {
    const obj = await BOOKS.get(cropsManifestKey(slug));
    if (!obj) return [];
    const doc = JSON.parse(await obj.text());
    const list = Array.isArray(doc) ? doc : Array.isArray(doc?.crops) ? doc.crops : [];
    return list.filter((e: any) => e && typeof e.tag === "string");
  } catch {
    return [];
  }
}

export async function saveCropsManifest(BOOKS: any, slug: string, crops: CropEntry[]): Promise<void> {
  await BOOKS.put(cropsManifestKey(slug), JSON.stringify(crops, null, 1), {
    httpMetadata: { contentType: "application/json" },
  });
}

// ------------------------------------------------------------ batch create

export interface BatchCropItem {
  character: string;
  action: string;
  bbox: { x: number; y: number; w: number; h: number };
}

export interface BatchSheet {
  /** Canonical (bible) character name. */
  name: string;
  sheetKey: string | null;
  bytes: Uint8Array | null;
}

export interface BatchCropResult {
  created: CropEntry[];
  errors: { index: number; character: string; error: string }[];
}

/** Create many crops in one pass: the cropper's staged save. Each
 * item is cropped server-side from its character's sheet (bytes
 * supplied by the caller, keyed by lowercase character name), its
 * PNG is stored, and ALL created entries land in the manifest with
 * ONE manifest write at the end, so a batch never leaves the
 * manifest half-updated the way a sequence of single saves could.
 * Pose numbers are allocated against the growing manifest, so the
 * same character + action twice in one batch yields p1, p2, ...
 * A bad item (unknown character, missing sheet, missing action,
 * duplicate tag, failed crop) is reported per item and never
 * blocks the rest of the batch. */
export async function createCropsBatch(
  BOOKS: any,
  slug: string,
  items: BatchCropItem[],
  sheetsByName: Map<string, BatchSheet>
): Promise<BatchCropResult> {
  const crops = await getCropsManifest(BOOKS, slug);
  const created: CropEntry[] = [];
  const errors: BatchCropResult["errors"] = [];
  const now = Math.floor(Date.now() / 1000);

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const character = String(item?.character ?? "").trim();
    const action = actionSlug(String(item?.action ?? ""));
    const bbox = item?.bbox;
    const fail = (error: string) => errors.push({ index, character, error });
    if (!character) { fail("character required"); continue; }
    if (!action) { fail("an action tag is required (e.g. standing, flying, megaphone)"); continue; }
    if (
      !bbox || ![bbox.x, bbox.y, bbox.w, bbox.h].every((v: any) => typeof v === "number" && Number.isFinite(v)) ||
      bbox.w <= 0 || bbox.h <= 0
    ) { fail("bbox {x, y, w, h} as fractions is required"); continue; }
    const sheet = sheetsByName.get(character.toLowerCase());
    if (!sheet) { fail(`no character '${character}' in this book's bible`); continue; }
    if (!sheet.sheetKey || !sheet.bytes) { fail(`no sheet on file for ${sheet.name}; approve a sheet first`); continue; }

    let cropped;
    try {
      cropped = cropImagePng(sheet.bytes, bbox);
    } catch (err: any) {
      fail(`crop failed: ${String(err?.message || err)}`);
      continue;
    }
    const poseNum = nextPoseNumber(crops, sheet.name);
    const tag = makeTag(sheet.name, poseNum, action);
    if (crops.some((c) => c.tag === tag)) {
      fail(`tag ${tag} already exists; delete it first or use another action`);
      continue;
    }
    const key = `books/${slug}/crops/${tag}.png`;
    await BOOKS.put(key, cropped.png, { httpMetadata: { contentType: "image/png" } });
    const entry: CropEntry = {
      tag,
      character: sheet.name,
      action,
      source: "sheet",
      bbox: { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h },
      createdAt: now,
      key,
      sheetKey: sheet.sheetKey,
    };
    crops.push(entry);
    created.push(entry);
  }

  if (created.length) {
    await saveCropsManifest(BOOKS, slug, crops);
  }
  return { created, errors };
}

// ------------------------------------------------------------ image codecs

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

interface Decoded {
  data: Uint8Array; // RGBA
  width: number;
  height: number;
}

export function decodeImage(bytes: Uint8Array): Decoded {
  if (isPng(bytes)) {
    const buf =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.slice().buffer as ArrayBuffer);
    const img: any = UPNG.decode(buf);
    if (!img || !img.width || !img.height) throw new Error("PNG decode produced no image");
    const frames = UPNG.toRGBA8(img);
    if (!frames?.length) throw new Error("PNG decode produced no frames");
    return { data: new Uint8Array(frames[0]), width: img.width, height: img.height };
  }
  const out: any = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  if (!out || !out.width || !out.height || !out.data) throw new Error("JPEG decode produced no image");
  return { data: new Uint8Array(out.data), width: out.width, height: out.height };
}

// Crop a fractional region out of an image and re-encode as PNG.
// Fractions are clamped; the region must be at least 16x16 px — a
// sliver crop is a mis-drag, not a pose.
export function cropImagePng(
  bytes: Uint8Array,
  bbox: { x: number; y: number; w: number; h: number }
): { png: Uint8Array; px: { x: number; y: number; w: number; h: number }; sheetSize: { w: number; h: number } } {
  const img = decodeImage(bytes);
  const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(bbox.x * img.width)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(bbox.y * img.height)));
  const x1 = Math.max(x0 + 1, Math.min(img.width, Math.ceil((bbox.x + bbox.w) * img.width)));
  const y1 = Math.max(y0 + 1, Math.min(img.height, Math.ceil((bbox.y + bbox.h) * img.height)));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 16 || h < 16) throw new Error(`crop region too small (${w}x${h}px); drag a larger box`);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  const png = new Uint8Array(UPNG.encode([out.buffer as ArrayBuffer], w, h, 0));
  return { png, px: { x: x0, y: y0, w, h }, sheetSize: { w: img.width, h: img.height } };
}
