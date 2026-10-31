import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

// GET /api/editor/approvals?book_slug=docker -> all approvals for the book
export const GET: APIRoute = async ({ url }) => {
  const db = (env as any).DB;
  const book_slug = url.searchParams.get('book_slug') || 'docker';
  const { results } = await db.prepare(
    'SELECT chapter_num, page_index, approved, approved_at FROM page_approvals WHERE book_slug = ?'
  ).bind(book_slug).all();
  return Response.json(results.map((r: any) => ({
    chapterNum: r.chapter_num,
    pageIndex: r.page_index,
    approved: r.approved === 1,
    approvedAt: r.approved_at,
  })));
};

// POST /api/editor/approvals { book_slug, chapterNum, pageIndex, approved }
export const POST: APIRoute = async ({ request }) => {
  const db = (env as any).DB;
  const b = await request.json();
  const book_slug = b.book_slug || 'docker';
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO page_approvals (book_slug, chapter_num, page_index, approved, approved_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (book_slug, chapter_num, page_index) DO UPDATE SET
       approved=excluded.approved, approved_at=excluded.approved_at`
  ).bind(book_slug, b.chapterNum, b.pageIndex, b.approved ? 1 : 0, b.approved ? now : null).run();
  return Response.json({ ok: true });
};
