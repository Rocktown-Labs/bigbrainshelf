// PNG -> JPEG transcoding for PDF assembly.
//
// Why this exists: the gateway's color art is PNG, about 2.1 MB a page
// at 2K. A 12-chapter book is 61 pages = 130 MB, and pdf-lib holds every
// embedded image in memory at once, so assembly died against the
// Worker's 128 MB limit (Fern, 2026-10-23) and the PDF itself would
// have shipped at 130 MB. Transcoding each page to a quality-85 JPEG as
// it is loaded drops a book to ~15 MB end to end while the 2K PNG
// masters stay untouched in R2. JPEG's weakness is hard edges and text;
// storybook art is text-free by rule and the story text is typeset by
// pdf-lib, so nothing readable is ever transcoded. Line art is already
// JPEG and passes through unchanged.
//
// Fail loudly: a page that cannot be converted throws, so the build
// stops on that page instead of quietly shipping a bad book.

import UPNG from "upng-js";
import jpeg from "jpeg-js";

// Only bother converting files big enough to matter.
const TRANSCODE_ABOVE = 700_000;
const JPEG_QUALITY = 85;

export function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length > 3 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

export async function toPdfJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isPng(bytes) || bytes.length < TRANSCODE_ABOVE) return bytes;
  const buf =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.slice().buffer as ArrayBuffer);
  const img: any = UPNG.decode(buf);
  if (!img || !img.width || !img.height) {
    throw new Error("transcode: PNG decode produced no image");
  }
  const frames = UPNG.toRGBA8(img);
  if (!frames || !frames.length) {
    throw new Error("transcode: PNG decode produced no frames");
  }
  const rgba = new Uint8Array(frames[0]);
  const encoded: any = jpeg.encode(
    { data: rgba, width: img.width, height: img.height },
    JPEG_QUALITY
  );
  if (!encoded || !encoded.data || !encoded.data.length) {
    throw new Error("transcode: JPEG encode produced no data");
  }
  const out = new Uint8Array(encoded.data);
  console.log(
    `transcode: ${(bytes.length / 1e6).toFixed(2)} MB PNG -> ${(out.length / 1e6).toFixed(2)} MB JPEG (${img.width}x${img.height}, q${JPEG_QUALITY})`
  );
  return out;
}
