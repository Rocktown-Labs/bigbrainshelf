import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { getAuth } from "../../lib/auth";
import { getDigitalEntitlements, entitlementDownloads } from "../../lib/library";
import { downloadBaseName } from "../../lib/download-names";
import {
  resolveOrderGrant,
  resolveBoxGrant,
  consumeDownload,
  DOWNLOAD_LIMIT_MESSAGE,
  type DownloadGrant,
} from "../../lib/download-guard";
import { stampPdfForBuyer } from "../../lib/pdf-stamp";
import { listKidProfiles } from "../../lib/family";
import { serveStampedM4b } from "../../lib/m4b-stamp";

// GET /api/download?slug=&format=picture|coloring|epub|color|audiobook
// Streams the purchased book file from R2. Requires a customer session
// and an OWNED entitlement from lib/library (the lock model): book
// files need the owned digital grant, the audiobook file needs the
// owned audio grant (which every digital grant includes, and which an
// audiobook-only purchase has on its own). A book reached only through
// a club membership layer reads and streams in the library but never
// downloads, so it gets the same refusal as a book not owned at all.
export const GET: APIRoute = async ({ request, url }) => {
  const e = env as any;
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "Sign in to download." }, { status: 401 });
  }
  const slug = String(url.searchParams.get("slug") || "");
  const fmtParam = url.searchParams.get("format");
  const format = fmtParam === "coloring" ? "coloring" : fmtParam === "epub" ? "epub" : fmtParam === "color" ? "color" : fmtParam === "audiobook" ? "audiobook" : "picture";
  if (!slug) return Response.json({ error: "slug required" }, { status: 400 });

  const entitlements = await getDigitalEntitlements(e.DB, {
    id: session.user.id,
    email: String(session.user.email || ""),
  });
  const ent = entitlements.get(slug);
  const allowed = entitlementDownloads(ent, format === "audiobook" ? "audiobook" : "book");
  if (!allowed) {
    return Response.json({ error: "You don't own this book yet." }, { status: 403 });
  }

  const book = await e.DB.prepare(
    "SELECT title, public_slug, picture_book_key, coloring_book_key, epub_key, color_book_key, audiobook_key FROM books WHERE slug = ?"
  ).bind(slug).first() as any;
  const key = format === "coloring" ? book?.coloring_book_key : format === "epub" ? book?.epub_key : format === "color" ? book?.color_book_key : format === "audiobook" ? book?.audiobook_key : book?.picture_book_key;
  if (!key) return Response.json({ error: "File not available." }, { status: 404 });

  const obj = await e.BOOKS.get(key);
  if (!obj) return Response.json({ error: "File not found." }, { status: 404 });

  // The download belongs to a purchase: resolve the granting order
  // (or shipped club box) so the file can be stamped for this buyer
  // and counted against that purchase's budget. The guest token route
  // keys on the same order id, so both routes share one budget.
  const user = { id: String(session.user.id), email: String(session.user.email || "") };
  let grant: DownloadGrant | null = await resolveOrderGrant(e.DB, user, slug, format).catch(() => null);
  if (!grant) grant = await resolveBoxGrant(e.DB, user, slug).catch(() => null);
  if (!grant) {
    // Entitlement said owned but no grant resolved (should not
    // happen): count against the account so the download still works
    // and is still bounded, and stamp with the buyer's email alone.
    grant = {
      grantKey: `account:${user.id}`,
      orderId: null,
      shortId: null,
      marker: `account:${user.id}`,
      markerIsOrder: false,
      buyerEmail: user.email,
    };
  }
  const budget = await consumeDownload(e.DB, grant, slug, format);
  if (!budget.ok) {
    return Response.json({ error: DOWNLOAD_LIMIT_MESSAGE }, { status: 403 });
  }

  const isAudio = format === "audiobook";
  const ext = format === "epub" ? "epub" : isAudio ? (String(key).endsWith(".m4b") ? "m4b" : "mp3") : "pdf";
  // The saved filename wears the book's public (title-derived) name,
  // never the internal slug: the buyer keeps this file forever.
  const base = downloadBaseName(book || {});
  const filename = format === "epub" ? `${base}.epub` : format === "color" ? `${base}-color-book.pdf` : `${base}-${format}-book.${ext}`;
  const headers = {
    "Content-Type": format === "epub" ? "application/epub+zip" : isAudio ? (ext === "m4b" ? "audio/mp4" : "audio/mpeg") : "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
  };
  // PDFs are stamped for the buyer at serve time (visible licensed
  // line + hidden metadata marker). A stamping failure never blocks a
  // legitimate download: fall back to the original bytes.
  if (ext === "pdf") {
    const raw = new Uint8Array(await obj.arrayBuffer());
    let body: Uint8Array = raw;
    // The dedication page names the family's default reader (the
    // first child profile when none is marked default). No profile,
    // no page: the stamp proceeds exactly as before.
    let childName: string | null = null;
    try {
      const kids = await listKidProfiles(e.DB, user.id);
      const def = kids.find((k) => k.is_default) || kids[0];
      childName = def?.name ? String(def.name) : null;
    } catch { /* dedication is a delight, never a blocker */ }
    // Dedication extras (v2): the book's title, the logo, and the
    // production date, which is the purchase date of the granting
    // order (or the box's creation for club grants; today as the
    // last resort). All best effort: a miss just omits a line.
    let producedOn: string | null = null;
    let logoPng: Uint8Array | null = null;
    if (childName) {
      try {
        let ts: number | null = null;
        if (grant.orderId) {
          const row: any = await e.DB.prepare("SELECT created_at FROM orders WHERE id = ?")
            .bind(grant.orderId)
            .first();
          if (row?.created_at != null) ts = Number(row.created_at);
        } else if (grant.marker.startsWith("club-box:")) {
          const row: any = await e.DB.prepare("SELECT created_at FROM club_cycle_boxes WHERE id = ?")
            .bind(grant.marker.slice("club-box:".length))
            .first()
            .catch(() => null);
          const rawTs = row?.created_at;
          if (typeof rawTs === "number") ts = rawTs;
          else if (typeof rawTs === "string") {
            const parsed = Date.parse(rawTs);
            if (!Number.isNaN(parsed)) ts = Math.floor(parsed / 1000);
          }
        }
        const when = ts && ts > 0 ? new Date(ts * 1000) : new Date();
        producedOn = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Chicago",
          month: "long",
          day: "numeric",
          year: "numeric",
        }).format(when);
      } catch { /* the date line is optional */ }
      try {
        const res = await e.ASSETS.fetch(new URL("/logo-stacked.png", url.origin));
        if (res.ok) logoPng = new Uint8Array(await res.arrayBuffer());
      } catch { /* the stamp falls back to the text wordmark */ }
    }
    try {
      body = await stampPdfForBuyer(raw, {
        email: grant.buyerEmail,
        shortId: grant.shortId,
        marker: grant.marker,
        markerIsOrder: grant.markerIsOrder,
        childName,
        bookTitle: book?.title ? String(book.title) : null,
        producedOn,
        logoPng,
      });
    } catch (err) {
      console.error("pdf stamp failed, serving original", (err as any)?.message || err);
    }
    return new Response(body, { headers: { ...headers, "Content-Length": String(body.byteLength) } });
  }
  // M4B audiobooks are stamped for the buyer too (lib/m4b-stamp):
  // the first download of a grant stamps the file surgically and
  // caches the copy in R2; the rest of the grant's capped downloads
  // serve that same stamped object. An unrecognized layout serves
  // the original bytes, exactly like the PDF fallback.
  if (ext === "m4b") {
    try {
      const served = await serveStampedM4b(e.BOOKS, key, obj, {
        grantKey: grant.grantKey,
        email: grant.buyerEmail,
        shortId: grant.shortId,
        marker: grant.marker,
        markerIsOrder: grant.markerIsOrder,
      });
      const h = served.length != null ? { ...headers, "Content-Length": String(served.length) } : headers;
      return new Response(served.body as any, { headers: h });
    } catch (err) {
      console.error("m4b stamp failed, serving original", (err as any)?.message || err);
      const fresh = await e.BOOKS.get(key).catch(() => null);
      if (fresh) return new Response(fresh.body, { headers });
      return Response.json({ error: "File not found." }, { status: 404 });
    }
  }
  return new Response(obj.body, { headers });
};
