import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import {
  resolveCharacterSheets,
  contentTypeForKey,
  type SheetKind,
} from "../../lib/character-sheets";

// GET /api/character-art?id=<character id>&kind=color|line
//
// Admin-only sheet art (CG decision 2026-10-28: full-res sheets are
// never public). Serves ONLY the approved registry sheet (the
// characters table's jpg_key / the characters/line fallback) of a
// character whose book is in the store catalog. The middleware gates
// /api/* behind the admin session (this path has no public pass), and
// the locals.user check here is defense in depth, the same pattern as
// /api/admin/character-sheet. Meet the Cast public pages use the
// media-host display derivatives, never this route.
export const GET: APIRoute = async ({ url, locals }) => {
  const e = env as any;
  if (!(locals as any)?.user) {
    return Response.json({ error: "Sign in as admin to view character sheets." }, { status: 401 });
  }
  const id = String(url.searchParams.get("id") || "").trim();
  const kind: SheetKind = url.searchParams.get("kind") === "line" ? "line" : "color";
  if (!id) return new Response("Not found", { status: 404 });

  const row = await e.DB.prepare(
    `SELECT c.* FROM characters c
       JOIN books b ON b.slug = c.book_slug
      WHERE c.id = ? AND b.picture_book_key IS NOT NULL`
  ).bind(id).first() as any;
  if (!row) return new Response("Not found", { status: 404 });

  const sheets = await resolveCharacterSheets(e, row);
  const info = sheets[kind];
  if (!info.exists) return new Response("Not found", { status: 404 });

  const obj = await e.BOOKS.get(info.key);
  if (!obj) return new Response("Not found", { status: 404 });

  return new Response(obj.body, {
    headers: {
      "Content-Type": contentTypeForKey(info.key, obj.httpMetadata?.contentType),
      "Cache-Control": "private, no-store",
    },
  });
};
