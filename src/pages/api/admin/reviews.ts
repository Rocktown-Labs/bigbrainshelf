import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { ensureReviewsTable, setReviewStatus } from "../../../lib/reviews";
import { markManySeen } from "../../../lib/seen";
import { clubMembershipActive, clubPlanOf } from "../../../lib/club";
import { loadBooksByAnySlug, orderItemLabels, parseItems } from "../../../lib/orders";

// Admin review moderation. Gated by the middleware's admin session
// cookie, with the locals.user check as defense in depth.
//
// GET  -> the moderation data table: server-side status filter
//         (?status=), sort (?sort=queue|date|rating&dir=), and
//         pagination (?page=, 25 per page). Default order is the
//         queue: pending first, then the most recent decisions.
// GET  ?detail=<reviewId> -> customer account, club membership, and
//         order history for the review detail drawer.
// POST { action: "approve" | "reject", review_id }

interface ReviewRow {
  id: string;
  user_id?: string | null;
  user_email?: string | null;
  book_slug?: string | null;
}

interface UserRow {
  id: string;
  name?: string | null;
  email?: string | null;
  username?: string | null;
  displayUsername?: string | null;
  role?: string | null;
  createdAt?: string | number | null;
}

interface ClubRow {
  id: string;
  club_plan?: string | null;
  plan?: string | null;
  status?: string | null;
  subscription_status?: string | null;
  comp_until?: number | null;
  created_at?: string | number | null;
}

interface OrderRow {
  id: string;
  status?: string | null;
  amount?: number | null;
  created_at?: string | number | null;
  book_slugs?: string | null;
  items?: string | null;
}

function guard(locals: unknown) {
  return !(locals as { user?: unknown })?.user;
}

// D1 binding is untyped on `cloudflare:workers` env; accept `any` here.
async function findUserForReview(db: any, userId: string, email: string): Promise<UserRow | null> {
  if (userId) {
    return db
      .prepare(`SELECT id, name, email, username, displayUsername, role, createdAt FROM "user" WHERE id = ? LIMIT 1`)
      .bind(userId)
      .first()
      .catch((err: unknown) => {
        console.error("[admin/reviews] user lookup by id failed:", err);
        return null;
      });
  }
  if (email) {
    return db
      .prepare(`SELECT id, name, email, username, displayUsername, role, createdAt FROM "user" WHERE LOWER(email) = ? LIMIT 1`)
      .bind(email)
      .first()
      .catch((err: unknown) => {
        console.error("[admin/reviews] user lookup by email failed:", err);
        return null;
      });
  }
  return null;
}

export const GET: APIRoute = async ({ locals, url }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  // Cloudflare Workers env bindings are dynamically attached at runtime.
  const e = env as any;
  await ensureReviewsTable(e.DB);

  const detailId = String(url.searchParams.get("detail") || "").trim();
  if (detailId) {
    const rev = (await e.DB.prepare(
      `SELECT id, user_id, user_email, book_slug FROM reviews WHERE id = ? LIMIT 1`
    )
      .bind(detailId)
      .first()) as ReviewRow | null;
    if (!rev) return Response.json({ error: "Review not found" }, { status: 404 });

    const email = String(rev.user_email || "").trim().toLowerCase();
    const userId = String(rev.user_id || "").trim();

    const [userRow, clubRow, reviewCountRow, ordersRes] = await Promise.all([
      findUserForReview(e.DB, userId, email),
      email
        ? e.DB.prepare(
            `SELECT id, club_plan, plan, status, subscription_status, comp_until, created_at
               FROM club_signups
              WHERE LOWER(email) = ?
              ORDER BY created_at DESC
              LIMIT 1`
          )
            .bind(email)
            .first()
            .catch((err: unknown) => {
              console.error("[admin/reviews] club lookup failed:", err);
              return null;
            })
        : Promise.resolve(null),
      userId || email
        ? e.DB.prepare(
            `SELECT COUNT(*) AS n
               FROM reviews
              WHERE (user_id = ? AND ? != '') OR (LOWER(user_email) = ? AND ? != '')`
          )
            .bind(userId, userId, email, email)
            .first()
            .catch((err: unknown) => {
              console.error("[admin/reviews] review count failed:", err);
              return null;
            })
        : Promise.resolve(null),
      userId || email
        ? e.DB.prepare(
            `SELECT id, status, amount, created_at, book_slugs, items
               FROM orders
              WHERE (user_id = ? AND ? != '') OR (LOWER(email) = ? AND ? != '')
              ORDER BY created_at DESC
              LIMIT 15`
          )
            .bind(userId, userId, email, email)
            .all()
            .catch((err: unknown) => {
              console.error("[admin/reviews] orders lookup failed:", err);
              return { results: [] };
            })
        : Promise.resolve({ results: [] }),
    ]);

    const orderRows = (ordersRes?.results || []) as OrderRow[];
    const revSlug = String(rev.book_slug || "");

    // Resolve item labels and canonical book slugs (including retired aliases like "mastery")
    // using the shared order helpers.
    const allSlugs: string[] = revSlug ? [revSlug] : [];
    const parsedByOrder = new Map<string, string[]>();
    for (const o of orderRows) {
      const slugs = parseItems(o).map((it) => it.slug).filter(Boolean);
      parsedByOrder.set(String(o.id), slugs);
      for (const s of slugs) allSlugs.push(s);
    }
    const [labelMap, bookMap] = await Promise.all([
      orderItemLabels(e.DB, orderRows).catch((err: unknown) => {
        console.error("[admin/reviews] orderItemLabels failed:", err);
        return new Map<string, string[]>();
      }),
      loadBooksByAnySlug(e.DB, allSlugs, "slug").catch((err: unknown) => {
        console.error("[admin/reviews] loadBooksByAnySlug failed:", err);
        return new Map<string, { slug: string }>();
      }),
    ]);

    const canonicalRevSlug = revSlug ? String(bookMap.get(revSlug)?.slug || revSlug) : "";
    const orders = orderRows.map((o) => {
      const id = String(o.id);
      const slugs = parsedByOrder.get(id) || [];
      const includesReviewedBook = Boolean(
        canonicalRevSlug &&
          slugs.some((s) => String(bookMap.get(s)?.slug || s) === canonicalRevSlug)
      );
      return {
        id,
        shortId: "#" + id.slice(0, 8).toUpperCase(),
        status: String(o.status || ""),
        amountCents: Number(o.amount || 0),
        createdAt: o.created_at ?? null,
        items: labelMap.get(id) || [],
        includesReviewedBook,
      };
    });

    const typedUser = userRow as UserRow | null;
    const typedClub = clubRow as ClubRow | null;
    const typedCount = reviewCountRow as { n?: number } | null;

    return Response.json({
      customer: typedUser
        ? {
            id: String(typedUser.id),
            name: String(typedUser.name || ""),
            email: String(typedUser.email || ""),
            username: typedUser.displayUsername || typedUser.username || null,
            role: String(typedUser.role || "user"),
            createdAt: typedUser.createdAt ?? null,
            reviewCount: Number(typedCount?.n || 1),
          }
        : null,
      club: typedClub
        ? {
            plan: clubPlanOf(typedClub),
            status: String(typedClub.status || ""),
            active: clubMembershipActive(typedClub),
          }
        : null,
      orders,
    });
  }
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
