import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import {
  ensureReviewNotesTable,
  listReviewNotes,
  addReviewNote,
  setReviewNoteResolved,
  isReviewKind,
} from "../../../lib/review-notes";

// Story Review notes API. Gated by the middleware's admin session
// cookie, with the locals.user check as defense in depth (same shape
// as /api/admin/reviews).
//
// GET  ?slug=                       -> { notes } for the book
// POST { slug, page_key, kind, note, tags }        -> create a note
// POST { action: "resolve"|"reopen", id }          -> flip resolved

function guard(locals: any) {
  return !(locals as any)?.user;
}

export const GET: APIRoute = async ({ url, locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  const slug = (url.searchParams.get("slug") || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) {
    return Response.json({ error: "bad slug" }, { status: 400 });
  }
  await ensureReviewNotesTable(e.DB);
  const notes = await listReviewNotes(e.DB, slug);
  return Response.json({ notes });
};

export const POST: APIRoute = async ({ request, locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  await ensureReviewNotesTable(e.DB);
  const body = await request.json().catch(() => ({}));

  const action = String(body?.action || "");
  if (action === "resolve" || action === "reopen") {
    const result = await setReviewNoteResolved(e.DB, String(body?.id || ""), action === "resolve");
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ ok: true });
  }

  const kind = body?.kind;
  if (!isReviewKind(kind)) {
    return Response.json({ error: "bad kind" }, { status: 400 });
  }
  const result = await addReviewNote(e.DB, {
    slug: String(body?.slug || ""),
    pageKey: String(body?.page_key || ""),
    kind,
    note: String(body?.note || ""),
    tags: body?.tags,
  });
  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ ok: true, note: result.note }, { status: 201 });
};
