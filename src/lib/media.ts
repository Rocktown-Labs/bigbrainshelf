// Media URL discipline after the second-door closure (2026-10-28).
//
// The kidsbook-factory bucket's public r2.dev domain is DISABLED.
// Nothing may link to it. The only public door for display art is the
// hotlink-guarded media host (media.bigbrainshelf.com, the bbs-media
// worker: cast-gallery/*, books/*/cover*, derivatives, deterrent
// card). Everything else is served by the hub itself through gated
// routes that read the BOOKS binding server-side:
//
//   customer reader pages -> /api/library/page/{slug}?key=...
//   admin surfaces        -> /api/admin/media?key=...
//
// This module owns the constants and the shared object streamer so
// every surface builds URLs the same way.

import { parseRangeHeader } from "./audiobooks";
import { contentTypeForKey } from "./character-sheets";

const EXTRA_TYPES: Record<string, string> = {
  json: "application/json",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4b: "audio/mp4",
  pdf: "application/pdf",
  epub: "application/epub+zip",
  txt: "text/plain; charset=utf-8",
};

export function mediaContentType(key: string, stored?: string): string {
  if (stored) return stored;
  const m = /\.([a-z0-9]+)$/i.exec(key);
  const ext = m ? m[1].toLowerCase() : "";
  return EXTRA_TYPES[ext] || contentTypeForKey(key);
}

/** The retired public bucket domain. Kept ONLY so stored data that
 * still contains these URLs (factory-written editor_chapters.json,
 * older cast-gallery manifests, the baked docker chapters) can be
 * translated back to bare keys. Never emit it. */
export const R2_PUBLIC = "https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev/";

/** The only public media host. */
export const MEDIA_PUBLIC = "https://media.bigbrainshelf.com/";

/** Bare R2 key from a stored value: strips the retired r2.dev prefix
 * or the media-host prefix; returns null for anything that is not a
 * plain key or one of those two URL forms. */
export function keyFromMediaValue(value: string | null | undefined): string | null {
  const v = String(value || "").trim();
  if (!v) return null;
  if (v.startsWith(R2_PUBLIC)) return v.slice(R2_PUBLIC.length);
  if (v.startsWith(MEDIA_PUBLIC)) return v.slice(MEDIA_PUBLIC.length);
  if (v.includes("://")) return null;
  return v.replace(/^\/+/, "");
}

/** Public display URL (media host) for a cover/gallery key or a
 * stored URL in either historical form. */
export function mediaUrl(value: string | null | undefined): string | null {
  const key = keyFromMediaValue(value);
  return key ? MEDIA_PUBLIC + key : null;
}

/** Admin-gated hub URL for any bucket key. */
export function adminMediaUrl(key: string | null | undefined): string | null {
  const k = keyFromMediaValue(key);
  return k ? `/api/admin/media?key=${encodeURIComponent(k)}` : null;
}

/** Customer-gated reader page URL for one page-image key of a book. */
export function libraryPageUrl(slug: string, key: string | null | undefined): string | null {
  const k = keyFromMediaValue(key);
  return k ? `/api/library/page/${encodeURIComponent(slug)}?key=${encodeURIComponent(k)}` : null;
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9\/._-]*$/;

/** Traversal-proof key check shared by the gated media routes. */
export function isSafeMediaKey(key: string): boolean {
  return (
    !!key &&
    key.length <= 512 &&
    SAFE_KEY.test(key) &&
    !key.split("/").some((seg) => seg === ".." || seg === ".")
  );
}

/** Stream one R2 object with the same Range semantics as
 * serveAudiobookTrack (206 / 416 / full 200, HEAD supported), for
 * callers that have already done their own authorization. */
export async function serveR2Object(args: {
  books: any;
  key: string;
  method: string;
  rangeHeader: string | null;
  cacheControl?: string;
}): Promise<Response> {
  const { books, key } = args;
  const head = await books.head(key).catch(() => null);
  if (!head) return new Response("Not found", { status: 404 });
  const size = head.size;

  const headers = new Headers({
    "Content-Type": mediaContentType(key, head.httpMetadata?.contentType),
    "Accept-Ranges": "bytes",
    "Cache-Control": args.cacheControl || "private, no-store",
  });

  if (args.method === "HEAD") {
    headers.set("Content-Length", String(size));
    return new Response(null, { status: 200, headers });
  }

  const range = parseRangeHeader(args.rangeHeader, size);
  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range.kind === "range") {
    const length = range.end - range.start + 1;
    const obj = await books
      .get(key, { range: { offset: range.start, length } })
      .catch(() => null);
    if (!obj) return new Response("Not found", { status: 404 });
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }

  const obj = await books.get(key).catch(() => null);
  if (!obj) return new Response("Not found", { status: 404 });
  headers.set("Content-Length", String(size));
  return new Response(obj.body, { status: 200, headers });
}
