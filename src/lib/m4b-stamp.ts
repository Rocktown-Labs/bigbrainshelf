// Per-buyer M4B stamping for OWNED audiobook downloads (owner-
// approved protection plan, 2026-10-30; the audio twin of the PDF
// pass in lib/pdf-stamp). A MediaBunny remux was spiked and rejected:
// it stamps tags perfectly but drops the QuickTime chapter track and
// corrupts the Nero chpl atom our factory M4Bs carry (see
// ~/workspace/factory-ops/mediabunny-spike/SPIKE-REPORT.md). This
// module instead does the surgical edit the spike validated:
//
//   - rebuild the file's existing moov/udta/meta/ilst box with two
//     items set: ©cmt = the visible licensed line ("Licensed to
//     {buyer email} · Order {#SHORTID}", the same line the PDF footer
//     carries) and a custom bsid item = the grant marker (the full
//     order id, or the grant key for club-box grants), the hidden
//     tracing twin of the PDF's metadata keywords. Any ©cmt / bsid
//     already present is REPLACED, never duplicated: the new ilst is
//     rebuilt from the old one's untouched items plus fresh stamp
//     items, in a single splice.
//   - bump the ilst ancestors' sizes (meta, udta, moov) by the splice
//     delta, and shift every stco/co64 chunk offset that points at or
//     past the splice point by the same delta. Media samples, the
//     chapter text track, its tref, the chpl atom, and the cover stay
//     byte-identical, only relocated.
//
// FAIL CLOSED, mirroring pdf-stamp's contract: the layout is fully
// pre-validated (ftyp first, the moov/udta/meta/ilst chain present
// with plain 32-bit sizes, ilst children parsing exactly to the box
// end, at least one sane chunk-offset table). On ANY surprise the
// function returns the original bytes untouched (the identical
// reference, which callers use to detect the fallback). A stamped
// file is never half-written: the output is built as a fresh buffer
// and validated as it is assembled.
//
// Downloads stamp ONCE per granting purchase: the route resolves the
// stamped copy from R2 under a cache key derived from the source key,
// the grant, and the source object's etag, so all five capped
// downloads of a grant serve the same stamped object, and a re-cast
// source (new etag) can never serve a stale stamp. Streaming and
// in-browser listening never pass through here.
import { licensedLine, type PdfStampInfo } from "./pdf-stamp";

export type M4bStampInfo = PdfStampInfo;

const CMT_TYPE = "\u00a9cmt"; // ©cmt
const BSID_TYPE = "bsid";
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);

interface BoxInfo {
  type: string;
  off: number;
  size: number;
  hdr: number;
}

class StampRefused extends Error {}

function refuse(): never {
  throw new StampRefused("layout surprise");
}

/** Parse the boxes in buf[start:end]; every box must use a plain
 * 32-bit size and fit exactly inside the range. Throws StampRefused
 * on anything unusual (largesize boxes included: our ancestors and
 * metadata boxes never use them, and bumping a largesize field is a
 * different edit than this module makes). */
function parseBoxes(buf: Uint8Array, dv: DataView, start: number, end: number): BoxInfo[] {
  const out: BoxInfo[] = [];
  let off = start;
  while (off < end) {
    if (off + 8 > end) refuse();
    const size = dv.getUint32(off);
    if (size < 8 || off + size > end) refuse();
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    out.push({ type, off, size, hdr: 8 });
    off += size;
  }
  if (off !== end) refuse();
  return out;
}

function findChild(buf: Uint8Array, dv: DataView, start: number, end: number, want: string): BoxInfo {
  for (const b of parseBoxes(buf, dv, start, end)) {
    if (b.type === want) return b;
  }
  return refuse();
}

function makeBox(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff;
  out.set(payload, 8);
  return out;
}

/** An ilst item's standard data box: type indicator 1 (UTF-8), locale 0. */
function makeDataItem(type: string, text: string): Uint8Array {
  const utf8 = new TextEncoder().encode(text);
  const payload = new Uint8Array(8 + utf8.length);
  new DataView(payload.buffer).setUint32(0, 1);
  payload.set(utf8, 8);
  return makeBox(type, makeBox("data", payload));
}

function stampM4bInner(bytes: Uint8Array, info: M4bStampInfo): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;
  if (len < 16) refuse();

  // Top level: ftyp must be the first box; walk to moov. Boxes before
  // moov must parse, boxes after it (mdat & friends) are never read.
  let moov: BoxInfo | null = null;
  {
    let off = 0;
    let first = true;
    while (off + 8 <= len) {
      const size = dv.getUint32(off);
      if (size < 8 || off + size > len) refuse();
      const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
      if (first && type !== "ftyp") refuse();
      first = false;
      if (type === "moov") {
        moov = { type, off, size, hdr: 8 };
        break;
      }
      off += size;
    }
  }
  if (!moov) refuse();

  const udta = findChild(bytes, dv, moov.off + moov.hdr, moov.off + moov.size, "udta");
  const meta = findChild(bytes, dv, udta.off + udta.hdr, udta.off + udta.size, "meta");
  // meta carries 4 bytes of version/flags before its children.
  if (meta.size < meta.hdr + 4 + 8) refuse();
  const ilst = findChild(bytes, dv, meta.off + meta.hdr + 4, meta.off + meta.size, "ilst");
  const ilstEnd = ilst.off + ilst.size;

  // Rebuild ilst: keep every existing item byte-for-byte except any
  // prior ©cmt / bsid (replaced, never duplicated), then append the
  // fresh stamp items. One splice, one delta.
  const kept: Uint8Array[] = [];
  for (const item of parseBoxes(bytes, dv, ilst.off + ilst.hdr, ilstEnd)) {
    if (item.type === CMT_TYPE || item.type === BSID_TYPE) continue;
    kept.push(bytes.subarray(item.off, item.off + item.size));
  }
  const cmtItem = makeDataItem(CMT_TYPE, licensedLine(info));
  const bsidItem = makeDataItem(BSID_TYPE, String(info.marker || ""));
  const keptLen = kept.reduce((n, s) => n + s.length, 0);
  const newIlstSize = ilst.hdr + keptLen + cmtItem.length + bsidItem.length;
  const newIlst = new Uint8Array(newIlstSize);
  {
    const ndv = new DataView(newIlst.buffer);
    ndv.setUint32(0, newIlstSize);
    for (let i = 0; i < 4; i++) newIlst[4 + i] = "ilst".charCodeAt(i);
    let p = ilst.hdr;
    for (const s of kept) { newIlst.set(s, p); p += s.length; }
    newIlst.set(cmtItem, p); p += cmtItem.length;
    newIlst.set(bsidItem, p);
  }
  const delta = newIlstSize - ilst.size;
  const outLen = len + delta;
  if (outLen <= 0 || outLen >= 2 ** 31) refuse();

  const out = new Uint8Array(outLen);
  out.set(bytes.subarray(0, ilst.off), 0);
  out.set(newIlst, ilst.off);
  out.set(bytes.subarray(ilstEnd), ilst.off + newIlstSize);

  // Ancestor sizes (their offsets all precede the splice, so they are
  // unchanged in the output buffer).
  const odv = new DataView(out.buffer);
  for (const off of [meta.off, udta.off, moov.off]) {
    odv.setUint32(off, odv.getUint32(off) + delta);
  }

  // Chunk offsets: shift every stco/co64 entry pointing at or past
  // the splice point (original ilst end) by the delta; entries before
  // it (a file whose media precedes its moov) stay put. At least one
  // sane table must be found or the layout is not one we understand.
  let tables = 0;
  const walk = (start: number, end: number) => {
    let off = start;
    while (off < end) {
      if (off + 8 > end) refuse();
      const size = odv.getUint32(off);
      if (size < 8 || off + size > end) refuse();
      const type = String.fromCharCode(out[off + 4], out[off + 5], out[off + 6], out[off + 7]);
      if (type === "stco" || type === "co64") {
        const is64 = type === "co64";
        const entrySize = is64 ? 8 : 4;
        if (size < 8 + 8 + entrySize) refuse();
        const count = odv.getUint32(off + 8 + 4);
        if (8 + 8 + count * entrySize > size) refuse();
        tables += 1;
        for (let i = 0; i < count; i++) {
          const p = off + 8 + 8 + i * entrySize;
          if (is64) {
            const v = odv.getBigUint64(p);
            if (v >= BigInt(ilstEnd)) {
              const nv = v + BigInt(delta);
              if (nv >= BigInt(outLen)) refuse();
              odv.setBigUint64(p, nv);
            } else if (v >= BigInt(outLen)) refuse();
          } else {
            const v = odv.getUint32(p);
            if (v >= ilstEnd) {
              const nv = v + delta;
              if (nv >= outLen) refuse();
              odv.setUint32(p, nv);
            } else if (v >= outLen) refuse();
          }
        }
      } else if (CONTAINERS.has(type)) {
        walk(off + 8, off + size);
      }
      off += size;
    }
    if (off !== end) refuse();
  };
  walk(moov.off + moov.hdr, moov.off + moov.size + delta);
  if (tables === 0) refuse();

  return out;
}

/**
 * Stamp an M4B for its buyer. Pure over bytes: returns a fresh
 * stamped buffer, or the ORIGINAL array (identical reference) when
 * the layout is anything other than the shape this module knows.
 */
export function stampM4bForBuyer(bytes: Uint8Array, info: M4bStampInfo): Uint8Array {
  try {
    return stampM4bInner(bytes, info);
  } catch {
    return bytes;
  }
}

/** Read-back helper (tests + verification): the ©cmt and bsid values
 * currently in a file, or null when the ilst cannot be walked. */
export function readM4bStamp(bytes: Uint8Array): { comment: string | null; bsid: string | null } | null {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let moov: BoxInfo | null = null;
    let off = 0;
    while (off + 8 <= bytes.length) {
      const size = dv.getUint32(off);
      if (size < 8 || off + size > bytes.length) return null;
      const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
      if (type === "moov") { moov = { type, off, size, hdr: 8 }; break; }
      off += size;
    }
    if (!moov) return null;
    const udta = findChild(bytes, dv, moov.off + 8, moov.off + moov.size, "udta");
    const meta = findChild(bytes, dv, udta.off + 8, udta.off + udta.size, "meta");
    const ilst = findChild(bytes, dv, meta.off + 8 + 4, meta.off + meta.size, "ilst");
    let comment: string | null = null;
    let bsid: string | null = null;
    for (const item of parseBoxes(bytes, dv, ilst.off + 8, ilst.off + ilst.size)) {
      if (item.type !== CMT_TYPE && item.type !== BSID_TYPE) continue;
      for (const child of parseBoxes(bytes, dv, item.off + 8, item.off + item.size)) {
        if (child.type !== "data" || child.size < 8 + 8) continue;
        const text = new TextDecoder().decode(bytes.subarray(child.off + 8 + 8, child.off + child.size));
        if (item.type === CMT_TYPE) comment = text; else bsid = text;
      }
    }
    return { comment, bsid };
  } catch {
    return null;
  }
}

function sanitizeKeyPart(s: string): string {
  return String(s || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

/** The R2 key of a grant's stamped copy of a source audiobook. The
 * source version (its etag, or size+uploaded when no etag is read)
 * is part of the key: re-cast the source and the next download
 * stamps afresh instead of serving the old stamp. */
export function m4bStampCacheKey(sourceKey: string, grantKey: string, sourceVersion: string): string {
  const base = sourceKey.replace(/\.m4b$/i, "");
  return `${base}-stamped/${sanitizeKeyPart(grantKey)}/${sanitizeKeyPart(sourceVersion)}.m4b`;
}

export function r2SourceVersion(obj: any): string {
  const etag = String(obj?.etag || "").replace(/"/g, "");
  if (etag) return etag;
  const uploaded = obj?.uploaded ? new Date(obj.uploaded).getTime() : 0;
  return `${Number(obj?.size || 0)}-${uploaded}`;
}

export interface StampedM4bResult {
  body: BodyInit;
  /** Byte length when known (stamped/cached copies), else null. */
  length: number | null;
  /** True when the bytes carry this buyer's stamp. */
  stamped: boolean;
  /** True when served from the per-grant R2 cache (no re-stamp). */
  fromCache: boolean;
}

/**
 * The download route's audiobook serve: the grant's stamped copy if
 * R2 already holds one for the source's current version; otherwise
 * fetch the source bytes, stamp them, cache them for the grant's
 * remaining downloads, and serve them. A stamping fallback serves
 * the original bytes and caches nothing, so a later download can
 * still stamp once the layout is understood.
 */
export async function serveStampedM4b(
  books: any,
  sourceKey: string,
  sourceObj: any,
  grant: { grantKey: string } & M4bStampInfo
): Promise<StampedM4bResult> {
  const cacheKey = m4bStampCacheKey(sourceKey, grant.grantKey, r2SourceVersion(sourceObj));
  try {
    const cached = await books.get(cacheKey);
    if (cached) {
      return { body: cached.body, length: Number(cached.size ?? 0) || null, stamped: true, fromCache: true };
    }
  } catch { /* a cache read failure just falls through to stamping */ }

  const raw = new Uint8Array(await sourceObj.arrayBuffer());
  const stamped = stampM4bForBuyer(raw, grant);
  if (stamped === raw) {
    return { body: raw, length: raw.byteLength, stamped: false, fromCache: false };
  }
  try {
    await books.put(cacheKey, stamped, { httpMetadata: { contentType: "audio/mp4" } });
  } catch { /* caching is an optimization; the stamped bytes still serve */ }
  return { body: stamped, length: stamped.byteLength, stamped: true, fromCache: false };
}
