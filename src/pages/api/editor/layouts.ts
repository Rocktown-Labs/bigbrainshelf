import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

// GET /api/editor/layouts?book_slug=docker -> all saved layouts for the book
export const GET: APIRoute = async ({ url }) => {
  const db = (env as any).DB;
  const book_slug = url.searchParams.get('book_slug') || 'docker';
  const { results } = await db.prepare(
    'SELECT * FROM page_layouts WHERE book_slug = ?'
  ).bind(book_slug).all();
  return Response.json(results.map((r: any) => ({
    chapterNum: r.chapter_num,
    pageIndex: r.page_index,
    image: { x: r.img_x, y: r.img_y, w: r.img_w, h: r.img_h, z: r.img_z ?? 1 },
    text: { x: r.text_x, y: r.text_y, w: r.text_w, fontSize: r.text_font_size, content: r.text_content },
  })));
};

// POST /api/editor/layouts { book_slug, chapterNum, pageIndex, image:{x,y,w,h,z}, text:{x,y,w,fontSize,content} }
export const POST: APIRoute = async ({ request }) => {
  const db = (env as any).DB;
  const b = await request.json();
  const book_slug = b.book_slug || 'docker';
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO page_layouts
     (book_slug, chapter_num, page_index, img_x, img_y, img_w, img_h, img_z, text_x, text_y, text_w, text_font_size, text_content, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (book_slug, chapter_num, page_index) DO UPDATE SET
       img_x=excluded.img_x, img_y=excluded.img_y, img_w=excluded.img_w, img_h=excluded.img_h, img_z=excluded.img_z,
       text_x=excluded.text_x, text_y=excluded.text_y, text_w=excluded.text_w, text_font_size=excluded.text_font_size,
       text_content=excluded.text_content, updated_at=excluded.updated_at`
  ).bind(
    book_slug, b.chapterNum, b.pageIndex,
    b.image.x, b.image.y, b.image.w, b.image.h, b.image.z ?? 1,
    b.text.x, b.text.y, b.text.w, b.text.fontSize, b.text.content ?? null, now
  ).run();
  return Response.json({ ok: true });
};

// DELETE /api/editor/layouts?book_slug=docker&chapterNum=1&pageIndex=0 -> reset one page
export const DELETE: APIRoute = async ({ url }) => {
  const db = (env as any).DB;
  const book_slug = url.searchParams.get('book_slug') || 'docker';
  const chapterNum = Number(url.searchParams.get('chapterNum'));
  const pageIndex = Number(url.searchParams.get('pageIndex'));
  await db.prepare(
    'DELETE FROM page_layouts WHERE book_slug = ? AND chapter_num = ? AND page_index = ?'
  ).bind(book_slug, chapterNum, pageIndex).run();
  return Response.json({ ok: true });
};
