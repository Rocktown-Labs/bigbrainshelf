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
