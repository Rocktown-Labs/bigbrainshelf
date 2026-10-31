import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  parseTrackParam,
  serveAudiobookTrack,
} from "../../../../../lib/audiobooks";
import { downloadBaseName } from "../../../../../lib/download-names";

// Admin audiobook streaming. GET|HEAD /api/admin/audiobook/{slug}/{track}
//   track = "full"  -> {audiobook dir}/audiobook.mp3 (full-book MP3)
//   track = "m4b"   -> the book's audiobook_key file (download)
//   track = "intro" -> {audiobook dir}/audio/intro.mp3 (the opening)
//   track = "ch{n}" -> {audiobook dir}/audio/ch{n}.mp3, n = 1..12
//   track = "outro" -> {audiobook dir}/audio/outro.mp3 (the closing)
//
// The middleware gates /api/* behind the admin session (401 JSON when
// signed out) and the locals.user check below is defense in depth, the
// same pattern as the other admin APIs. Files are read from the BOOKS
// R2 bucket per request; nothing here is reachable without admin auth.
//
// The streaming itself (range reads, 206/416 handling) lives in
// serveAudiobookTrack in lib/audiobooks.ts, shared with the customer
// library route so the two players can never drift apart.

async function handle({ params, request, locals }: any) {
  if (!(locals as any)?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const e = env as any;
  const slug = String(params?.slug || "");
  const track = parseTrackParam(params?.track);
  if (!slug || !track) {
    return Response.json({ error: "Unknown audiobook track." }, { status: 404 });
  }

  const book = (await e.DB
    .prepare("SELECT slug, title, public_slug, audiobook_key FROM books WHERE slug = ?")
    .bind(slug)
    .first()) as any;
  if (!book?.audiobook_key) {
    return Response.json({ error: "That book has no audiobook yet." }, { status: 404 });
  }

  return serveAudiobookTrack({
    books: e.BOOKS,
    audiobookKey: book.audiobook_key,
    slug,
    filenameBase: downloadBaseName(book),
    track,
    method: request.method,
    rangeHeader: request.headers.get("Range"),
    allowDownload: true,
  });
}

export const GET: APIRoute = handle;
export const HEAD: APIRoute = handle;
