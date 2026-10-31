import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import {
  resolveCharacterSheets,
  sheetFilename,
  contentTypeForKey,
  type SheetKind,
} from "../../../lib/character-sheets";

// GET /api/admin/character-sheet?id=<character id>&kind=color|line[&download=1]
// Streams one character sheet from R2 for the signed-in admin: inline
// for the detail page's full-size view, or as an attachment with a
// clean filename when download=1. The middleware already gates /api/*
// behind the admin session; the locals.user check is defense in depth.
// Sheets are never served from a public URL through this path.
export const GET: APIRoute = async ({ url, locals }) => {
  const e = env as any;
  if (!(locals as any)?.user) {
    return Response.json({ error: "Sign in as admin to view character sheets." }, { status: 401 });
  }
  const id = String(url.searchParams.get("id") || "").trim();
  const kind: SheetKind = url.searchParams.get("kind") === "line" ? "line" : "color";
  const download = url.searchParams.get("download") === "1";
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const row = await e.DB.prepare("SELECT * FROM characters WHERE id = ?").bind(id).first() as any;
  if (!row) return Response.json({ error: "Character not found." }, { status: 404 });

  const sheets = await resolveCharacterSheets(e, row);
  const info = sheets[kind];
  if (!info.exists) {
    return Response.json({ error: `No ${kind} sheet for this character yet.` }, { status: 404 });
  }

  const obj = await e.BOOKS.get(info.key);
  if (!obj) return Response.json({ error: "Sheet file not found." }, { status: 404 });

  const filename = sheetFilename(row.name, kind, info.key);
  return new Response(obj.body, {
    headers: {
      "Content-Type": contentTypeForKey(info.key, obj.httpMetadata?.contentType),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
};
