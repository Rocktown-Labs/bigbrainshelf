import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getAuth } from "../../../lib/auth";
import { isAdminEmail } from "../../../lib/admins";
import { inspectAudiobook } from "../../../lib/audiobooks";
import { getDigitalEntitlements, loadReaderBook } from "../../../lib/library";
import { publicSlugFor, resolveBookForPublicRoute } from "../../../lib/public-slugs";

export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const GET: APIRoute = async ({ request, url }) => {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return json({ error: "Sign in required" }, 401);
  }

  const e = env as any;
  const rawSlug = String(url.searchParams.get("slug") || "").trim();
  if (!rawSlug) {
    return json({ error: "slug is required" }, 400);
  }

  const resolved = await resolveBookForPublicRoute(e.DB, rawSlug).catch(() => null);
  const slug = resolved ? String(resolved.book.slug) : rawSlug;

  const book =
    (resolved?.book as any) ||
    ((await e.DB.prepare(
      "SELECT slug, public_slug, title, topic, cover_key, picture_book_key, coloring_book_key, epub_key, color_book_key, audiobook_key FROM books WHERE slug = ?"
    )
      .bind(slug)
      .first()) as any);

  if (!book) {
    return json({ error: "Book not found" }, 404);
  }

  const user = { id: String(session.user.id), email: String(session.user.email || "") };
  const entitlements = await getDigitalEntitlements(e.DB, user);
  const entitlement = entitlements.get(slug);
  const isAdmin = isAdminEmail(user.email);

  if (!entitlement && !isAdmin) {
    return json({ error: "You do not have access to this book in your digital library" }, 403);
  }

  const effectiveEntitlement = entitlement || {
    digital: true,
    audio: Boolean(book.audiobook_key),
    owned: true,
  };

  const audioOnly = !effectiveEntitlement.digital && effectiveEntitlement.audio;
  const reader = audioOnly
    ? { chapters: [], totalPages: 0, colorCount: 0, hasColor: false, error: null }
    : await loadReaderBook(e.BOOKS, slug);

  let audioInfo = null;
  if (book.audiobook_key && (effectiveEntitlement.audio || effectiveEntitlement.digital)) {
    audioInfo = await inspectAudiobook(e, book, `/api/library/audio/${slug}`);
  }

  const R2 = "https://media.bigbrainshelf.com/";

  return json({
    ok: true,
    book: {
      slug: book.slug,
      publicSlug: publicSlugFor(book),
      title: book.title,
      topic: book.topic || "",
      coverUrl: book.cover_key ? R2 + book.cover_key : null,
      owned: Boolean(effectiveEntitlement.owned),
      digital: Boolean(effectiveEntitlement.digital),
      audio: Boolean(effectiveEntitlement.audio),
      audioOnly,
      hasPicturePdf: Boolean(book.picture_book_key),
      hasColoringPdf: Boolean(book.coloring_book_key),
      hasColorPdf: Boolean(book.color_book_key),
      hasEpub: Boolean(book.epub_key),
      hasAudiobook: Boolean(book.audiobook_key),
    },
    reader: {
      chapters: reader.chapters,
      totalPages: reader.totalPages,
      colorCount: reader.colorCount,
      hasColor: reader.hasColor,
    },
    audio: audioInfo
      ? {
          slug: book.slug,
          full: audioInfo.full,
          chapters: audioInfo.chapters,
          tracks: audioInfo.tracks,
          totalDurationSec: audioInfo.tracks.reduce(
            (sum: number, t: any) => sum + (Number(t.duration) || 0),
            0
          ),
        }
      : null,
  });
};
