import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { resolveBookForPublicRoute } from "../../../../../lib/public-slugs";

// POST /api/admin/books/{publicSlug}/attempts-promote  { attemptId }
// Promote an archived generation attempt to the page's official image
// (merged factory-scale plan, 2026-11-01: Gemini's "Accept Archived
// Attempt"). A verified-clean archived roll becomes the page for
// $0.00 instead of paying for a redraw. Supports the two kinds with a
// single deterministic page key: line (books/{slug}/images/...) and
// colorize (books/{slug}/images-color/...). The promotion clears the
// page's held flag in the plan, mirrors the colorize workflow's
// imageColorKey bookkeeping, and appends a "promoted" row to
// gen_attempts so the archive records the decision. Admin-gated by
// the middleware; the locals.user check is defense in depth.
export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
  if (!(locals as any)?.user) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const e = env as any;
  const param = String(params.slug || "");
  const resolved = await resolveBookForPublicRoute(e.DB, param).catch(() => null);
  if (!resolved) return Response.json({ error: "book not found" }, { status: 404 });
  const slug = String((resolved.book as any).slug);

  let body: any = null;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON body required" }, { status: 400 });
  }
  const attemptId = Number(body?.attemptId);
  if (!Number.isInteger(attemptId) || attemptId <= 0) {
    return Response.json({ error: "attemptId required" }, { status: 400 });
  }

  const row: any = await e.DB.prepare("SELECT * FROM gen_attempts WHERE id = ?")
    .bind(attemptId)
    .first()
    .catch(() => null);
  if (!row || String(row.slug) !== slug) {
    return Response.json({ error: "attempt not found for this book" }, { status: 404 });
  }
  if (row.kind !== "line" && row.kind !== "colorize") {
    return Response.json(
      { error: `promote supports line and colorize pages, not kind "${row.kind}"` },
      { status: 400 }
    );
  }
  if (!row.image_key) {
    return Response.json({ error: "attempt has no saved image" }, { status: 400 });
  }
  const chapter = String(row.chapter || "");
  const page = row.page;
  if (!/^S\d+$/.test(chapter) || typeof page !== "number" || page < -1) {
    return Response.json({ error: "attempt has no chapter/page to promote to" }, { status: 400 });
  }

  const name = page === -1 ? `${chapter}-finale.jpg` : `${chapter}-page-${page}.jpg`;
  const targetKey =
    row.kind === "line" ? `books/${slug}/images/${name}` : `books/${slug}/images-color/${name}`;

  const obj = await e.BOOKS.get(String(row.image_key)).catch(() => null);
  if (!obj) {
    return Response.json({ error: "archived image is gone from storage" }, { status: 404 });
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const contentType =
    obj.httpMetadata?.contentType || (isPng ? "image/png" : "image/jpeg");
  await e.BOOKS.put(targetKey, bytes, { httpMetadata: { contentType } });

  // Plan bookkeeping: clear the held flag for this page (and mirror
  // imageColorKey on colorize), exactly as the workflows do when a
  // roll is accepted, so assembly stops blocking on this page.
  try {
    const planObj = await e.BOOKS.get(`books/${slug}/plans/${chapter}.json`).catch(() => null);
    if (planObj) {
      const plan = await planObj.json();
      const pg = page === -1 ? plan?.finale : plan?.pages?.[page];
      if (pg) {
        if (row.kind === "line") delete pg.held;
        else {
          delete pg.colorHeld;
          pg.imageColorKey = targetKey;
        }
        await e.BOOKS.put(
          `books/${slug}/plans/${chapter}.json`,
          JSON.stringify(plan, null, 1),
          { httpMetadata: { contentType: "application/json" } }
        );
      }
    }
  } catch {
    // The image is promoted; a stale plan flag is recoverable by a
    // colorize/build resume, so do not fail the promotion over it.
  }

  await e.DB.prepare(
    "INSERT INTO gen_attempts (slug, kind, chapter, page, attempt, outcome, reason, scores, cost, image_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  )
    .bind(
      slug,
      row.kind,
      chapter,
      page,
      0,
      "promoted",
      `promoted from attempt #${row.id} (${row.outcome}) by admin`,
      null,
      null,
      String(row.image_key),
      Math.floor(Date.now() / 1000)
    )
    .run()
    .catch(() => null);

  return Response.json({ ok: true, targetKey });
};
