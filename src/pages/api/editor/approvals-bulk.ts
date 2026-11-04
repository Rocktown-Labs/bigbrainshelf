import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { listBookPages } from "../../../lib/book-plans";

// POST /api/editor/approvals-bulk { book_slug, approved }
// Marks every page of the book approved (or clears every
// approval) in one call. This is how QC gets marked good from
// the book's readiness page after a review pass (CG,
// 2026-10-31): review the pages, then approve the book. A redo
// of any page clears that page's approval again (see
// redo-text / redo-image), so an approval can never survive an
// edit it did not review.
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const b = await request.json().catch(() => ({}));
  const slug = String(b.book_slug || "");
  if (!slug) return Response.json({ ok: false, error: "book_slug required" }, { status: 400 });
  const approved = b.approved !== false;
  let pages;
  try { pages = await listBookPages(e.BOOKS, slug); }
  catch {
    return Response.json({ ok: false, code: 'INVENTORY_UNVERIFIED',
      error: 'Page inventory could not be verified. No approvals were changed. Check the book plans and retry.' }, { status: 409 });
  }
  if (!pages.length) {
    return Response.json({ ok: false, error: "no plans found for this book" }, { status: 404 });
  }
  const now = new Date().toISOString();
  try {
    const stmt = e.DB.prepare(
    `INSERT INTO page_approvals (book_slug, chapter_num, page_index, approved, approved_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (book_slug, chapter_num, page_index) DO UPDATE SET
       approved=excluded.approved, approved_at=excluded.approved_at`
  );
    await e.DB.batch(
      pages.map((p) => stmt.bind(slug, p.chapter, p.page, approved ? 1 : 0, approved ? now : null))
    );
  } catch {
    return Response.json({ ok: false, code: 'APPROVAL_SAVE_UNCONFIRMED',
      error: 'Approval changes could not be confirmed. Reload the book before retrying.' }, { status: 503 });
  }
  return Response.json({ ok: true, pages: pages.length, approved });
};
