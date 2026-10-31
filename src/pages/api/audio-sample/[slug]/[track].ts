import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { parseTrackParam, serveAudiobookTrack } from "../../../../lib/audiobooks";
import { resolveInternalSlug } from "../../../../lib/public-slugs";

// GET /api/audio-sample/{slug}/{track}
//
// The free listening sample for the public audio pages: streams ONLY
// the introduction and chapter 1 of the audiobook of any book that
// has a cover and an audiobook (the same set the listening shelf
// lists, whatever its publish status), with no entitlement,
// mirroring the book page's free 5-page sample (/api/sample). The
// files are resolved per request from the book's live audiobook_key,
// so a re-cast book's new recording is what the sample serves, with
// no page edits.
//
// Locked tracks (chapter 2+, the outro, the full file, the M4B) of
// an audio-published book no longer answer a bare 404: they serve
// the shared decoy clip (public/just-buy-it.mp3, a five-second
// Aura-2 "just buy it" spot), so a poked URL plays the pitch instead
// of silence. The decoy is the ONLY thing a locked track can return
// here; real chapter audio stays behind the library's entitlement
// check. Books without a cover or an audiobook, unknown slugs, and
// unparseable track names still 404, exactly as before.
//
// The {slug} segment is the book's PUBLIC slug (audio pages address
// samples by it); it is resolved to the internal slug here. The
// internal form also resolves, for any older saved link.
export const GET: APIRoute = async ({ params, request }) => {
  const e = env as any;
  const track = parseTrackParam(params.track);
  if (!track) {
    return new Response("Not found", { status: 404 });
  }
  const isSampleTrack =
    track.kind === "intro" || (track.kind === "chapter" && track.n === 1);
  const rawSlug = String(params.slug || "").trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(rawSlug)) {
    return new Response("Not found", { status: 404 });
  }
  const slug = await resolveInternalSlug(e.DB, rawSlug).catch(() => null);
  if (!slug) return new Response("Not found", { status: 404 });
  // The cover+audio set, keyed off the live catalog row: any status
  // qualifies, a book with no cover or no audiobook never does.
  const book = await e.DB
    .prepare("SELECT slug, audiobook_key FROM books WHERE slug = ? AND cover_key IS NOT NULL AND audiobook_key IS NOT NULL")
    .bind(slug)
    .first();
  if (!book?.audiobook_key) return new Response("Not found", { status: 404 });

  if (!isSampleTrack) {
    // Locked track on an audio-published book: serve the decoy clip
    // from the static assets. If the asset cannot be read, fail
    // closed to the old 404; never fall through to real audio.
    const asset = await e.ASSETS.fetch(
      new Request(new URL("/just-buy-it.mp3", request.url))
    ).catch(() => null);
    if (!asset || !asset.ok) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    headers.set("Content-Type", "audio/mpeg");
    const len = asset.headers.get("Content-Length");
    if (len) headers.set("Content-Length", len);
    headers.set("Cache-Control", "public, max-age=86400");
    headers.set("X-BBS-Decoy", "just-buy-it");
    return new Response(asset.body, { status: 200, headers });
  }

  const res = await serveAudiobookTrack({
    books: e.BOOKS,
    audiobookKey: String(book.audiobook_key),
    slug,
    track,
    method: request.method,
    rangeHeader: request.headers.get("range"),
    allowDownload: false,
  });
  if (res.status !== 200 && res.status !== 206) return res;
  // The sample is public by design, so let the CDN cache it like the
  // book sample pages instead of the private no-store header the
  // entitled streamer sets.
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "public, max-age=86400");
  return new Response(res.body, { status: res.status, headers });
};
