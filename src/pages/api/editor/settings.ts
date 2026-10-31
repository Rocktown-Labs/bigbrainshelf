import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

const DEFAULTS = {
  trimPreset: 'letter', trimWidthIn: 8.5, trimHeightIn: 11,
  safeMarginIn: 0.5, showGuides: true, showBleed: false,
};

// GET /api/editor/settings?book_slug=docker
export const GET: APIRoute = async ({ url }) => {
  const db = (env as any).DB;
  const book_slug = url.searchParams.get('book_slug') || 'docker';
  const row = await db.prepare(
    'SELECT * FROM book_settings WHERE book_slug = ?'
  ).bind(book_slug).first();
  if (!row) return Response.json({ ...DEFAULTS });
  return Response.json({
    trimPreset: row.trim_preset,
    trimWidthIn: row.trim_width,
    trimHeightIn: row.trim_height,
    safeMarginIn: row.safe_margin,
    showGuides: row.show_guides === 1,
    showBleed: row.show_bleed === 1,
  });
};

// POST /api/editor/settings { book_slug, trimPreset, trimWidthIn, trimHeightIn, safeMarginIn, showGuides, showBleed }
export const POST: APIRoute = async ({ request }) => {
  const db = (env as any).DB;
  const b = await request.json();
  const book_slug = b.book_slug || 'docker';
  await db.prepare(
    `INSERT INTO book_settings (book_slug, trim_preset, trim_width, trim_height, safe_margin, show_guides, show_bleed)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (book_slug) DO UPDATE SET
       trim_preset=excluded.trim_preset, trim_width=excluded.trim_width, trim_height=excluded.trim_height,
       safe_margin=excluded.safe_margin, show_guides=excluded.show_guides, show_bleed=excluded.show_bleed`
  ).bind(
    book_slug, b.trimPreset ?? 'letter',
    Math.min(20, Math.max(3, Number(b.trimWidthIn) || 8.5)),
    Math.min(20, Math.max(3, Number(b.trimHeightIn) || 11)),
    Math.min(2, Math.max(0, Number(b.safeMarginIn) || 0)),
    b.showGuides ? 1 : 0, b.showBleed ? 1 : 0
  ).run();
  return Response.json({ ok: true });
};
