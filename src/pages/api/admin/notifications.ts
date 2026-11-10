import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  buildAdminNotifications,
  getNotificationReadIds,
  markNotificationRead,
  markAllNotificationsRead,
} from "../../../lib/admin-notifications";
import { luluConfigured } from "../../../lib/lulu";
import { buildJobsForOrder, submitPrintJob, syncPrintJobs } from "../../../lib/print-fulfillment";
import { flushOutbox } from "../../../lib/email";

const SITE = "https://bigbrainshelf.com";

// GET /api/admin/notifications
// The dense inbox behind /admin/notifications: the PR #76 digest's
// urgent + awareness sets as row-level items with persisted read
// state (admin_notification_reads). Admin-gated by the middleware.
export const GET: APIRoute = async () => {
  const e = env as any;
  const nowSec = Math.floor(Date.now() / 1000);
  const todayIso = new Date(nowSec * 1000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const items = await buildAdminNotifications(e.DB, nowSec, todayIso, { podActive: luluConfigured(e) });
  const readIds = await getNotificationReadIds(e.DB);
  const withRead = items.map((n) => ({ ...n, read: readIds.has(n.id) }));
  const counts = {
    total: withRead.length,
    action: withRead.filter((n) => n.severity === "action").length,
    awareness: withRead.filter((n) => n.severity === "awareness").length,
    print_jobs: withRead.filter((n) => n.category === "print_jobs").length,
    club: withRead.filter((n) => n.category === "club").length,
    email_files: withRead.filter((n) => n.category === "email_files").length,
    unread: withRead.filter((n) => !n.read).length,
    atRiskCents: withRead
      .filter((n) => n.severity === "action")
      .reduce((a, n) => a + (Number(n.amountCents) || 0), 0),
  };
  return Response.json({ items: withRead, counts, podActive: luluConfigured(e) });
};

// POST { action: "mark_read", id } | { action: "mark_all_read" }
// POST { action: "run", id } runs the item's in-place action against
// the same per-order operations the order page uses (sync a job,
// create a job, retry the outbox). The item is rebuilt fresh so a
// stale id can never fire against the wrong row.
export const POST: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const body = await request.json().catch(() => ({} as any));
  const readBy = (locals as any)?.user?.email || null;
  const nowSec = Math.floor(Date.now() / 1000);
  const todayIso = new Date(nowSec * 1000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

  if (body.action === "mark_read" && body.id) {
    await markNotificationRead(e.DB, String(body.id), readBy);
    return Response.json({ ok: true });
  }
  if (body.action === "mark_all_read") {
    const items = await buildAdminNotifications(e.DB, nowSec, todayIso, { podActive: luluConfigured(e) });
    await markAllNotificationsRead(e.DB, items.map((n) => n.id), readBy);
    return Response.json({ ok: true, marked: items.length });
  }
  if (body.action === "run" && body.id) {
    const items = await buildAdminNotifications(e.DB, nowSec, todayIso, { podActive: luluConfigured(e) });
    const item = items.find((n) => n.id === String(body.id));
    if (!item || !item.action) return Response.json({ error: "That notification has no action to run." }, { status: 400 });
    try {
      if (item.action === "retry_emails") {
        const flush = await flushOutbox(e.DB, e, 25, SITE);
        return Response.json({ ok: true, message: `Outbox retry ran (${flush.sent} sent, ${flush.failed} failed).` });
      }
      if (!item.orderId) return Response.json({ error: "No order attached to that notification." }, { status: 400 });
      if (item.action === "sync_job") {
        const s = await syncPrintJobs(e.DB, e, { orderId: item.orderId, site: SITE });
        return Response.json({ ok: true, message: `Synced ${s.synced} job${s.synced === 1 ? "" : "s"} from Lulu.` });
      }
      if (item.action === "create_job") {
        if (!luluConfigured(e)) {
          return Response.json({ error: "The Lulu lane is off, so print jobs cannot be created yet." }, { status: 400 });
        }
        const order = await e.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(item.orderId).first();
        if (!order) return Response.json({ error: "Order not found." }, { status: 404 });
        const job = await buildJobsForOrder(e.DB, e, order);
        if (!job) return Response.json({ error: "This order has no printed lines to build a job from." }, { status: 400 });
        const outcome = await submitPrintJob(e.DB, e, job, SITE);
        return Response.json({ ok: true, message: outcome?.submitted ? "Print job created and sent to Lulu." : "Print job created." });
      }
    } catch (err: any) {
      return Response.json({ error: String(err?.message || err).slice(0, 200) }, { status: 500 });
    }
    return Response.json({ error: "Unknown action." }, { status: 400 });
  }
  return Response.json({ error: "Unknown action." }, { status: 400 });
};
