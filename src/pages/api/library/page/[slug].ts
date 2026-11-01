import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getAuth, getEffectiveSession } from "../../../../lib/auth";
import { isAdminEmail } from "../../../../lib/admins";
import { ownsDigitalBook, readerPageKeyAllowed } from "../../../../lib/library";
import { serveR2Object } from "../../../../lib/media";

// Customer reader page images. GET|HEAD /api/library/page/{slug}?key=...
//
// The reader's page <img> srcs point here, never at a public object
// URL (the bucket's r2.dev domain is disabled). The route
// authenticates the customer itself (better-auth session, like
// /api/library/audio; the middleware lets this path through for that
// reason) and then checks DIGITAL ownership of the book: an
// audio-only owner gets no page images here, exactly like the
// listen-only reader page they see. Keys are confined to the book's
// own page-image locations by readerPageKeyAllowed, so one book's
// entitlement cannot be stretched into another book's pages.
// Streaming (range reads, 206/416) is serveR2Object in lib/media.ts,
// shared with the admin media route.

async function handle({ params, request, url, locals }: any) {
  const e = env as any;
  const auth = getAuth();
  const session =
    (await auth.api.getSession({ headers: request.headers })) ||
    (await getEffectiveSession(request, locals, e.DB));
  if (!session) {
    return Response.json({ error: "Sign in to read." }, { status: 401 });
  }
  const slug = String(params?.slug || "").trim().toLowerCase();
  const key = String(url.searchParams.get("key") || "");
  if (!/^[a-z0-9-]+$/.test(slug) || !readerPageKeyAllowed(slug, key)) {
    return Response.json({ error: "Unknown page." }, { status: 404 });
  }

  const email = String(session.user.email || "");
  // SECURITY (F1): the email fallback only applies to verified
  // sessions; an unverified session matches its own user_id only.
  const emailVerified = (session.user as any).emailVerified === true;
  const owned =
    (isAdminEmail(email) && emailVerified) ||
    (await ownsDigitalBook(
      e.DB,
      { id: session.user.id, email, emailVerified },
      slug
    ));
  if (!owned) {
    return Response.json({ error: "You don't own this book yet." }, { status: 403 });
  }

  return serveR2Object({
    books: e.BOOKS,
    key,
    method: request.method,
    rangeHeader: request.headers.get("Range"),
    cacheControl: "private, max-age=3600",
  });
}

export const GET: APIRoute = handle;
export const HEAD: APIRoute = handle;
