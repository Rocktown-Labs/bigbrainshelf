import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getAuth } from "../../../../../lib/auth";
import {
  parseTrackParam,
  serveAudiobookTrack,
} from "../../../../../lib/audiobooks";
import { ownsAudioBook } from "../../../../../lib/library";

// Customer audiobook streaming. GET|HEAD
// /api/library/audio/{slug}/{track}
//   track = "full"  -> {audiobook dir}/audiobook.mp3 (full-book MP3)
//   track = "intro" -> {audiobook dir}/audio/intro.mp3 (the opening)
//   track = "ch{n}" -> {audiobook dir}/audio/ch{n}.mp3, n = 1..12
//   track = "outro" -> {audiobook dir}/audio/outro.mp3 (the closing)
// Intro and outro sit behind the exact same ownership check as the
// chapters: an audio entitlement covers the whole book, edges included.
//
// The M4B is not streamable here: it stays a download through the
// existing /api/download flow. Playback is MP3, exactly like the
// admin player.
//
// The route authenticates the customer itself (better-auth session,
// like /api/download and /api/checkout; the middleware lets this path
// through for that reason) and then checks digital ownership of the
// book through the library entitlement layer. Streaming behavior
// (range reads, 206/416) is serveAudiobookTrack in lib/audiobooks.ts,
// shared with the admin route.

async function handle({ params, request }: any) {
  const e = env as any;
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "Sign in to listen." }, { status: 401 });
  }
  const slug = String(params?.slug || "");
  const track = parseTrackParam(params?.track);
  if (!slug || !track || track.kind === "m4b") {
    return Response.json({ error: "Unknown audiobook track." }, { status: 404 });
  }

  const book = (await e.DB
    .prepare("SELECT slug, title, audiobook_key FROM books WHERE slug = ?")
    .bind(slug)
    .first()) as any;
  if (!book?.audiobook_key) {
    return Response.json({ error: "That book has no audiobook yet." }, { status: 404 });
  }

  const owned = await ownsAudioBook(
    e.DB,
    { id: session.user.id, email: String(session.user.email || "") },
    slug
  );
  if (!owned) {
    return Response.json({ error: "You don't own this book yet." }, { status: 403 });
  }

  return serveAudiobookTrack({
    books: e.BOOKS,
    audiobookKey: book.audiobook_key,
    slug,
    track,
    method: request.method,
    rangeHeader: request.headers.get("Range"),
    allowDownload: false,
  });
}

export const GET: APIRoute = handle;
export const HEAD: APIRoute = handle;
