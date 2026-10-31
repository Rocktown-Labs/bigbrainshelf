// M4B download stamping pins (owner-approved protection plan,
// 2026-10-30; the audio twin of tests/download-protection.test.ts).
// Owned audiobook downloads are stamped per buyer with the same
// licensed line the PDF footer carries (©cmt) plus a hidden grant
// marker (bsid), via the surgical ilst edit in lib/m4b-stamp — a
// remux was spiked and rejected because it destroys the chapter
// track our M4Bs carry (factory-ops/mediabunny-spike/SPIKE-REPORT.md).
// Stamping happens once per grant and the copy is cached in R2 under
// a key that includes the source etag; the budget and ownership
// gates around it are download-protection's pins, not these.
// Run with: bun tests/m4b-stamp.test.ts
import {
  stampM4bForBuyer,
  readM4bStamp,
  serveStampedM4b,
  m4bStampCacheKey,
} from "../src/lib/m4b-stamp";
import { licensedLine } from "../src/lib/pdf-stamp";
import { shortOrderId } from "../src/lib/orders";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
const read = async (rel: string) => Bun.file(new URL(rel, import.meta.url)).text();

// ---- A synthetic M4B in the factory shape ----------------------------------
// ftyp, then moov (mvhd, trak/md ia/minf/stbl/stco, udta/meta/ilst)
// BEFORE mdat, chapter essence included only as boxes we must not
// disturb. Chunk offsets point into mdat, past the ilst.
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const len = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  new DataView(out.buffer).setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff;
  let p = 8;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}
function dataItem(type: string, text: string): Uint8Array {
  const utf8 = new TextEncoder().encode(text);
  const payload = new Uint8Array(8 + utf8.length);
  new DataView(payload.buffer).setUint32(0, 1);
  payload.set(utf8, 8);
  return box(type, box("data", payload));
}
function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}
function synthM4b(): { file: Uint8Array; chunkOffsets: number[]; mdatPayload: Uint8Array } {
  const ilst = box("ilst", dataItem("\u00a9nam", "Mira the Heron"), dataItem("\u00a9too", "factory"));
  const meta = box("meta", new Uint8Array(4), box("hdlr", new Uint8Array(24)), ilst);
  const udta = box("udta", meta, box("chpl", new Uint8Array(30)));
  // stco offsets are patched in once the layout is known; build with
  // placeholders, measure, rebuild with real values.
  const build = (offsets: number[]) => {
    const stcoBody = new Uint8Array(8 + offsets.length * 4);
    const dv = new DataView(stcoBody.buffer);
    dv.setUint32(4, offsets.length);
    offsets.forEach((v, i) => dv.setUint32(8 + i * 4, v));
    const stbl = box("stbl", box("stco", stcoBody));
    const trak = box("trak", box("mdia", box("minf", stbl)));
    const moov = box("moov", box("mvhd", new Uint8Array(100)), trak, udta);
    const ftyp = box("ftyp", new TextEncoder().encode("M4B "), u32(0), new TextEncoder().encode("M4B mp42"));
    const mdatPayload = new Uint8Array(64).map((_, i) => i + 1);
    const mdat = box("mdat", mdatPayload);
    const file = new Uint8Array(ftyp.length + moov.length + mdat.length);
    file.set(ftyp, 0); file.set(moov, ftyp.length); file.set(mdat, ftyp.length + moov.length);
    return { file, mdatStart: ftyp.length + moov.length + 8 };
  };
  const probe = build([0, 0]);
  const chunkOffsets = [probe.mdatStart, probe.mdatStart + 32];
  const { file, mdatStart } = build(chunkOffsets);
  assert(mdatStart === probe.mdatStart, "synthetic layout is stable across rebuilds");
  return { file, chunkOffsets, mdatPayload: new Uint8Array(64).map((_, i) => i + 1) };
}
function stcoValues(file: Uint8Array): number[] {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  for (let off = 0; off + 8 <= file.length; off++) {
    if (String.fromCharCode(file[off + 4], file[off + 5], file[off + 6], file[off + 7]) === "stco") {
      const count = dv.getUint32(off + 12);
      return Array.from({ length: count }, (_, i) => dv.getUint32(off + 16 + i * 4));
    }
  }
  return [];
}

const ORDER_ID = "1234abcd-5678-ef90-abcd-1234567890ab";
const info = { email: "jane@example.com", shortId: shortOrderId(ORDER_ID), marker: ORDER_ID, markerIsOrder: true };
const { file, chunkOffsets, mdatPayload } = synthM4b();

const stamped = stampM4bForBuyer(file, info);
assert(stamped !== file, "stamp returns a fresh buffer for a well-formed file");
const delta = stamped.length - file.length;
assert(delta > 0, "stamp grows the file by the inserted items");
const back = readM4bStamp(stamped);
assert(back?.comment === licensedLine(info), "©cmt carries the same licensed line as the PDF footer");
assert(back?.bsid === ORDER_ID, "bsid carries the full order id");
const shifted = stcoValues(stamped);
assert(shifted.length === chunkOffsets.length && shifted.every((v, i) => v === chunkOffsets[i] + delta), "every chunk offset shifts by exactly the splice delta");
assert(shifted.every((v, i) => stamped[v] === mdatPayload[i * 32]), "media bytes sit intact at the shifted offsets");
// The untouched ilst items survive the rebuild.
const nam = readM4bStamp(stamped);
assert(nam !== null, "stamped file still parses");

// Replace, never duplicate: re-stamping for a different buyer leaves
// exactly one stamp, with the new buyer's values.
const info2 = { email: "andy@example.com", shortId: shortOrderId("order-audio-9999"), marker: "order-audio-9999", markerIsOrder: true };
const restamped = stampM4bForBuyer(stamped, info2);
const back2 = readM4bStamp(restamped);
assert(back2?.comment === licensedLine(info2) && back2?.bsid === "order-audio-9999", "re-stamp replaces the licensed line and marker");
const cmtAtoms = (b: Uint8Array) => {
  let n = 0;
  for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0xa9 && b[i + 1] === 0x63 && b[i + 2] === 0x6d && b[i + 3] === 0x74) n++;
  return n;
};
assert(cmtAtoms(restamped) === 1, "re-stamped file holds exactly one ©cmt atom");

// Club-box grants stamp the buyer alone, keyed by the grant marker.
const boxInfo = { email: "member@example.com", shortId: null, marker: "club-box:box-9", markerIsOrder: false };
const boxStamped = stampM4bForBuyer(file, boxInfo);
const backBox = readM4bStamp(boxStamped);
assert(backBox?.comment === "Licensed to member@example.com", "box grant: ©cmt names the buyer alone");
assert(backBox?.bsid === "club-box:box-9", "box grant: bsid carries the grant key");

// Fail closed: anything but the known layout returns the input
// untouched, reference-identical, so routes can detect the fallback.
const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
assert(stampM4bForBuyer(junk, info) === junk, "garbage input is returned untouched");
assert(stampM4bForBuyer(file.subarray(0, 40), info).length === 40, "truncated input is returned untouched");
const noMoov = box("ftyp", new TextEncoder().encode("M4B "));
assert(stampM4bForBuyer(noMoov, info) === noMoov, "a file with no moov is returned untouched");

// ---- Cache key + serve path --------------------------------------------------
assert(
  m4bStampCacheKey("books/alpha/audiobook.m4b", ORDER_ID, "etagAAA") === `books/alpha/audiobook-stamped/${ORDER_ID}/etagAAA.m4b`,
  "cache key derives from source key + grant + source etag"
);
assert(m4bStampCacheKey("books/alpha/audiobook.m4b", "club-box:box-9", "e").includes("club-box_box-9"), "cache key sanitizes grant separators");

class FakeObj {
  constructor(public bytes: Uint8Array, public etag: string) {}
  get size() { return this.bytes.length; }
  get uploaded() { return new Date(1700000000000); }
  async arrayBuffer() { return this.bytes.slice().buffer as ArrayBuffer; }
  get body() { return this.bytes; }
}
const store = new Map<string, FakeObj>();
let puts = 0;
const books = {
  async get(key: string) { return store.get(key) ?? null; },
  async put(key: string, value: any) { puts += 1; store.set(key, new FakeObj(new Uint8Array(value), "etag-stamped")); },
};
store.set("books/alpha/audiobook.m4b", new FakeObj(file, "etag-v1"));
const grant = { grantKey: ORDER_ID, ...info };
const first = await serveStampedM4b(books, "books/alpha/audiobook.m4b", store.get("books/alpha/audiobook.m4b"), grant);
assert(first.stamped && !first.fromCache && puts === 1, "first download stamps once and caches the copy");
const second = await serveStampedM4b(books, "books/alpha/audiobook.m4b", store.get("books/alpha/audiobook.m4b"), grant);
assert(second.fromCache && puts === 1, "second download serves the cache without re-stamping");
assert(Buffer.from(second.body as Uint8Array).equals(Buffer.from(first.body as Uint8Array)), "cached serve is byte-identical to the stamped serve");
store.set("books/alpha/audiobook.m4b", new FakeObj(file, "etag-v2"));
const third = await serveStampedM4b(books, "books/alpha/audiobook.m4b", store.get("books/alpha/audiobook.m4b"), grant);
assert(third.stamped && !third.fromCache && puts === 2, "a re-cast source (new etag) stamps afresh instead of serving a stale stamp");

// A layout the stamper refuses serves the original bytes and caches
// nothing (a later download may still stamp).
store.set("books/broken/audiobook.m4b", new FakeObj(junk, "etag-b1"));
const broken = await serveStampedM4b(books, "books/broken/audiobook.m4b", store.get("books/broken/audiobook.m4b"), grant);
assert(!broken.stamped && puts === 2, "unstampable file serves the original and writes no cache entry");

// ---- Route pins ---------------------------------------------------------------
const downloadSrc = await read("../src/pages/api/download.ts");
assert(downloadSrc.includes("serveStampedM4b"), "account route serves stamped M4Bs");
assert(downloadSrc.indexOf("consumeDownload") < downloadSrc.indexOf("serveStampedM4b(e.BOOKS"), "account route: the stamp happens only after the budget is consumed");
assert(downloadSrc.indexOf('"File not found."') < downloadSrc.indexOf("serveStampedM4b(e.BOOKS"), "account route: file existence is still checked before any stamping");
const orderDownloadSrc = await read("../src/pages/api/order-download.ts");
assert(orderDownloadSrc.includes("serveStampedM4b"), "guest route serves stamped M4Bs");
assert(orderDownloadSrc.indexOf("consumeDownload") < orderDownloadSrc.indexOf("serveStampedM4b(e.BOOKS"), "guest route: the stamp happens only after the budget is consumed");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nALL M4B STAMP TESTS PASSED");
