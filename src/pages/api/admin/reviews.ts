import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { ensureReviewsTable, setReviewStatus } from "../../../lib/reviews";
import { markManySeen } from "../../../lib/seen";

// Admin review moderation. Gated by the middleware's admin session
// cookie, with the locals.user check as defense in depth.
//
// GET  -> the moderation data table: server-side status filter
//         (?status=), sort (?sort=queue|date|rating&dir=), and
//         pagination (?page=, 25 per page). Default order is the
//         queue: pending first, then the most recent decisions.
// POST { action: "approve" | "reject", review_id }

function guard(locals: any) {
  return !(locals as any)?.user;
}

export const GET: APIRoute = async ({ locals, url }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  await ensureReviewsTable(e.DB);
  // Data-table query (owner, 2026-10-29): server-side status filter,
  // sort, and pagination (25 per page) so the moderation table stays
  // fast at volume. The default sort is the moderation queue: pending
  // first, then newest. Explicit date/rating sorts replace it.
  const STATUSES = ["pending", "approved", "rejected"];
  const statusParam = String(url.searchParams.get("status") || "all");
  const status = STATUSES.includes(statusParam) ? statusParam : "all";
  const sortParam = String(url.searchParams.get("sort") || "queue");
  const sort = sortParam === "date" || sortParam === "rating" ? sortParam : "queue";
  const dir = String(url.searchParams.get("dir") || "desc") === "asc" ? "ASC" : "DESC";
  const orderBy =
    sort === "date"
      ? `r.created_at ${dir}, r.id ${dir}`
      : sort === "rating"
        ? `r.rating ${dir}, r.created_at DESC`
        : "CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC";
  const where = status === "all" ? "" : "WHERE r.status = ?";
  const countRow = await e.DB.prepare(
    `SELECT COUNT(*) AS n FROM reviews r ${where}`
  ).bind(...(status === "all" ? [] : [status])).first() as any;
  const total = Number(countRow?.n || 0);
  const PAGE_SIZE = 25;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(url.searchParams.get("page") || 1) || 1), pages);
  const rows = await e.DB.prepare(
    `SELECT r.*, b.title AS book_title, b.public_slug AS book_public_slug FROM reviews r
       LEFT JOIN books b ON b.slug = r.book_slug
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`
  ).bind(...(status === "all" ? [] : [status])).all();
  const reviews = (rows.results || []) as any[];
  // Showing a review in the queue is what clears it from the
  // sidebar badge (pending ones keep counting on the state rule
  // until they are moderated).
  await markManySeen(e.DB, "reviews", reviews.map((r) => String(r.id)));
  // Stat cards, computed over the whole table (the list itself stays
  // bounded): the moderation backlog, the public average from
  // APPROVED reviews only, the all-time total, and per-status counts
  // for the filter pills.
  const statRow = await e.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
            COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
            AVG(CASE WHEN status = 'approved' THEN rating END) AS avg_approved
       FROM reviews`
  ).first() as any;
  const stats = {
    pending: Number(statRow?.pending || 0),
    approved: Number(statRow?.approved || 0),
    rejected: Number(statRow?.rejected || 0),
    total: Number(statRow?.total || 0),
    avgApproved: statRow?.avg_approved == null ? null : Number(statRow.avg_approved),
  };
  return Response.json({ reviews, pending: stats.pending, stats, total, page, pageSize: PAGE_SIZE, pages, status, sort, dir: dir.toLowerCase() });
};

export const POST: APIRoute = async ({ request, locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  await ensureReviewsTable(e.DB);
  const body = await request.json().catch(() => ({}));
  const action = String(body?.action || "");
  const reviewId = String(body?.review_id || "");
  if (action !== "approve" && action !== "reject") {
    return Response.json({ error: "unknown action" }, { status: 400 });
  }
  const result = await setReviewStatus(e.DB, reviewId, action === "approve" ? "approved" : "rejected");
  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ ok: true });
};
