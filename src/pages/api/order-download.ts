import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { downloadBaseName } from "../../lib/download-names";
import {
  grantForOrder,
  consumeDownload,
  DOWNLOAD_LIMIT_MESSAGE,
  type DownloadFileKind,
} from "../../lib/download-guard";
import { stampPdfForBuyer } from "../../lib/pdf-stamp";
import { serveStampedM4b } from "../../lib/m4b-stamp";

// GET /api/order-download?token=&slug=&format=picture|coloring|epub|color|audiobook
// The durable download links sent in order emails. The token is a random
// per-order secret (orders.delivery_token) created at checkout; it does
// not expire, so links in a buyer's inbox keep working. Anyone holding
// the token can fetch that order's files, which is the same trust model
// as every emailed download link; the account library (/api/download)
// remains the signed-in path. Reachable without a session (see
// middleware) because the token is the credential.
export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const token = String(url.searchParams.get("token") || "");
  const slug = String(url.searchParams.get("slug") || "");
  const fmtParam = url.searchParams.get("format");
  const format =
    fmtParam === "coloring" ? "coloring"
    : fmtParam === "epub" ? "epub"
    : fmtParam === "color" ? "color"
    : fmtParam === "audiobook" ? "audiobook"
    : "picture";
  if (!token || !slug) {
    return Response.json({ error: "token and slug required" }, { status: 400 });
  }

  const order = await e.DB.prepare(
    "SELECT id, email, book_slugs, items FROM orders WHERE delivery_token = ? AND status = 'complete'"
  ).bind(token).first() as any;
  if (!order) return Response.json({ error: "Download link not recognized." }, { status: 404 });

  let owned: string[] = [];
  try { owned = JSON.parse(order.book_slugs || "[]").map(String); } catch { /* ignore */ }
  if (!owned.includes(slug)) {
    return Response.json({ error: "That book is not part of this order." }, { status: 403 });
  }

  // The token carries the ORDER's rights, not the account's: when the
  // order's items are recorded, an audiobook-only line unlocks the
  // audiobook file alone through this link, even if the buyer later
  // unlocks more. Legacy orders with no items for the slug keep the
  // historical all-files behavior.
  let itemFormats: string[] = [];
  try {
    const parsed = JSON.parse(order.items || "[]");
    if (Array.isArray(parsed)) {
      itemFormats = parsed.filter((x: any) => String(x?.slug || "") === slug).map((x: any) => String(x?.format || "digital"));
    }
  } catch { /* ignore */ }
  if (itemFormats.length) {
    const grantsDigital = itemFormats.some((f) => f === "digital" || f === "printed" || f === "giftset");
    if (!grantsDigital && format !== "audiobook") {
      return Response.json({ error: "That file is not part of this order." }, { status: 403 });
    }
    if (!grantsDigital && !itemFormats.includes("audio") && format === "audiobook") {
      return Response.json({ error: "That file is not part of this order." }, { status: 403 });
    }
  }

  const book = await e.DB.prepare(
    "SELECT title, public_slug, picture_book_key, coloring_book_key, epub_key, color_book_key, audiobook_key FROM books WHERE slug = ?"
  ).bind(slug).first() as any;
  const key =
    format === "coloring" ? book?.coloring_book_key
    : format === "epub" ? book?.epub_key
    : format === "color" ? book?.color_book_key
    : format === "audiobook" ? book?.audiobook_key
    : book?.picture_book_key;
  if (!key) return Response.json({ error: "File not available." }, { status: 404 });

  const obj = await e.BOOKS.get(key);
  if (!obj) return Response.json({ error: "File not found." }, { status: 404 });

  // The token's order is the purchase this download belongs to: it is
  // stamped for that buyer and counted against the same per-order
  // budget the signed-in library route uses (one budget, both doors).
  const grant = grantForOrder(order);
  const budget = await consumeDownload(e.DB, grant, slug, format as DownloadFileKind);
  if (!budget.ok) {
    return Response.json({ error: DOWNLOAD_LIMIT_MESSAGE }, { status: 403 });
  }

  const isAudio = format === "audiobook";
  const isEpub = format === "epub";
  const ext = isEpub ? "epub" : isAudio ? (String(key).endsWith(".m4b") ? "m4b" : "mp3") : "pdf";
  // The saved filename wears the book's public (title-derived) name,
  // never the internal slug: the buyer keeps this file forever.
  const base = downloadBaseName(book || {});
  const filename =
    format === "picture" ? `${base}-book.${ext}`
    : format === "color" ? `${base}-color-book.${ext}`
    : `${base}-${format}.${ext}`;
  const headers = {
    "Content-Type": isEpub ? "application/epub+zip" : isAudio ? (ext === "m4b" ? "audio/mp4" : "audio/mpeg") : "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
  };
  // PDFs are stamped for the buyer at serve time (visible licensed
  // line + hidden metadata marker); a stamping failure falls back to
  // the original bytes rather than blocking a legitimate download.
  if (ext === "pdf") {
    const raw = new Uint8Array(await obj.arrayBuffer());
    let body: Uint8Array = raw;
    try {
      body = await stampPdfForBuyer(raw, {
        email: grant.buyerEmail,
        shortId: grant.shortId,
        marker: grant.marker,
        markerIsOrder: grant.markerIsOrder,
      });
    } catch (err) {
      console.error("pdf stamp failed, serving original", (err as any)?.message || err);
    }
    return new Response(body, { headers: { ...headers, "Content-Length": String(body.byteLength) } });
  }
  // M4B audiobooks carry the same per-buyer stamp as the signed-in
  // route (lib/m4b-stamp), keyed on this token's order, so both
  // doors serve the one cached stamped copy for the grant.
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
