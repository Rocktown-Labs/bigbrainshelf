import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { ensureAllSeenColumns } from "../../../lib/seen";
import { buildAdminNotifications, getNotificationReadIds } from "../../../lib/admin-notifications";
import { luluConfigured } from "../../../lib/lulu";

// GET /api/admin/orders-badge
// The sidebar's attention counts (CG, 2026-10-31): badges count
// work, not history, and they are state based, not time based.
//   Orders: an order still waiting on fulfillment counts until
//     it ships; a finished order (shipped/delivered, or digital)
//     counts until the admin opens it, then clears.
//   Club: a paid member counts until opened; a member with a
//     failed payment counts until the failure clears.
//   Reviews: a pending review counts until moderated; a
//     moderated one counts until the queue page shows it.
// revenueCents stays a plain last-24-hours sum for the
// dashboard's subline. Admin-gated by the middleware.
export const GET: APIRoute = async () => {
  const e = env as any;
  const out = { count: 0, club: 0, reviews: 0, revenueCents: 0, notifications: 0 };
  try {
    await ensureAllSeenColumns(e.DB);
    const since = Math.floor(Date.now() / 1000) - 86400;
    const orders = await e.DB.prepare(
      `SELECT COUNT(*) AS n FROM orders
        WHERE status = 'complete'
          AND (
            (physical_status IS NOT NULL AND physical_status NOT IN ('shipped', 'delivered'))
            OR seen_at IS NULL
          )`
    ).first();
    out.count = Number(orders?.n ?? 0);
    const rev = await e.DB.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS cents FROM orders
        WHERE status = 'complete' AND created_at >= ?`
    ).bind(since).first();
    out.revenueCents = Number(rev?.cents ?? 0);
  } catch { /* counts stay 0 */ }
  try {
    const club = await e.DB.prepare(
      `SELECT COUNT(*) AS n FROM club_signups
        WHERE status = 'paid'
          AND (payment_failed_at IS NOT NULL OR seen_at IS NULL)`
    ).first();
    out.club = Number(club?.n ?? 0);
  } catch { /* no club table yet */ }
  try {
    const reviews = await e.DB.prepare(
      `SELECT COUNT(*) AS n FROM reviews
        WHERE status = 'pending' OR seen_at IS NULL`
    ).first();
    out.reviews = Number(reviews?.n ?? 0);
  } catch { /* no reviews table yet */ }
  try {
    // Unread notification count for the sidebar (orders admin redo):
    // derived fresh from the same builder the Notifications page
    // uses, minus the persisted read marks.
    const nowSec = Math.floor(Date.now() / 1000);
    const todayIso = new Date(nowSec * 1000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const items = await buildAdminNotifications(e.DB, nowSec, todayIso, { podActive: luluConfigured(e) });
    const readIds = await getNotificationReadIds(e.DB);
    out.notifications = items.filter((n) => !readIds.has(n.id)).length;
  } catch { /* notifications are a bonus */ }
  return Response.json(out);
};
