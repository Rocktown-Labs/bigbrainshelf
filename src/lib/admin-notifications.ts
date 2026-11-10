// Admin notifications (orders admin redo, CG-approved prototype v3,
// 2026-11-10): the PR #76 digest, promoted from an email to a
// surface. Same urgency rules as src/lib/urgency.ts and the digest
// (rejected job, paid with no job after a day, queue over a day,
// production over a week, boxes past their ship date, printed orders
// waiting 3+ days), same awareness split (at the printer vs on us),
// but row-level, filterable, tappable, and clearable.
//
// A notification is DERIVED from live rows on every read, never
// stored; only its read state persists (admin_notification_reads,
// migration 0006), keyed by the stable identity computed here, e.g.
// "print_job_failed:<job id>". When the underlying problem resolves
// the notification disappears on its own. Test orders and boxes
// under CG's addresses never notify (TEST_ORDER_EMAILS).

import { TEST_ORDER_EMAILS } from "./urgency";

export type NotificationSeverity = "action" | "awareness";
export type NotificationCategory = "print_jobs" | "club" | "orders" | "email_files";
export type NotificationAction = "sync_job" | "create_job" | "retry_emails";

export interface AdminNotification {
  id: string;
  severity: NotificationSeverity;
  category: NotificationCategory;
  title: string;
  detail?: string;
  href: string;
  amountCents?: number | null;
  sinceSec?: number | null; // when the problem started (age display)
  entityKind: "order" | "box" | "job" | "system";
  entityId?: string | null;
  orderId?: string | null;
  action?: NotificationAction | null;
  actionLabel?: string | null;
}

const DAY = 86400;

export async function ensureNotificationReadsTable(db: any): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS admin_notification_reads (
         notification_id TEXT PRIMARY KEY NOT NULL,
         read_at INTEGER NOT NULL,
         read_by TEXT
       )`
    )
    .run();
}

export async function getNotificationReadIds(db: any): Promise<Set<string>> {
  try {
    await ensureNotificationReadsTable(db);
    const rows = await db.prepare("SELECT notification_id FROM admin_notification_reads").all();
    return new Set((rows.results || []).map((r: any) => String(r.notification_id)));
  } catch {
    return new Set();
  }
}

export async function markNotificationRead(db: any, id: string, readBy: string | null): Promise<void> {
  await ensureNotificationReadsTable(db);
  await db
    .prepare(
      "INSERT INTO admin_notification_reads (notification_id, read_at, read_by) VALUES (?, ?, ?) ON CONFLICT(notification_id) DO UPDATE SET read_at = excluded.read_at, read_by = excluded.read_by"
    )
    .bind(id, Math.floor(Date.now() / 1000), readBy)
    .run();
}

export async function markAllNotificationsRead(db: any, ids: string[], readBy: string | null): Promise<void> {
  for (const id of ids) await markNotificationRead(db, id, readBy);
}

const testList = [...TEST_ORDER_EMAILS];
const TEST_SET = new Set(testList.map((e) => e.toLowerCase()));
const notTest = (col: string) =>
  testList.length
    ? `LOWER(COALESCE(${col}, '')) NOT IN (${testList.map(() => "?").join(",")})`
    : "1=1";
const testBinds = () => testList.map((e) => e.toLowerCase());

export async function buildAdminNotifications(
  db: any,
  nowSec: number,
  todayIso: string,
  opts: { podActive: boolean }
): Promise<AdminNotification[]> {
  const items: AdminNotification[] = [];
  const all = async (sql: string, ...binds: any[]) => {
    try {
      const r = await db.prepare(sql).bind(...binds).all();
      return (r.results || []) as any[];
    } catch {
      return [];
    }
  };

  // ---- Print jobs -------------------------------------------------
  const failedJobs = await all(
    `SELECT j.id, j.order_id, j.club_box_id, j.lulu_status, j.last_error, j.created_at,
            o.amount AS order_amount, o.email AS order_email
       FROM print_jobs j LEFT JOIN orders o ON o.id = j.order_id
      WHERE j.status IN ('failed', 'blocked_no_printable')
      ORDER BY j.created_at ASC LIMIT 50`
  );
  for (const j of failedJobs) {
    if (j.order_email && TEST_SET.has(String(j.order_email).toLowerCase())) continue;
    const href = j.order_id ? `/admin/orders/${j.order_id}` : j.club_box_id ? `/admin/orders/box/${j.club_box_id}` : "/admin/orders";
    if (j.status === "blocked_no_printable") {
      items.push({
        id: `print_job_blocked:${j.id}`, severity: "action", category: "print_jobs",
        title: "Print job has no print-ready file",
        detail: "A line in this job has no print file yet. Build the print files, then create the job again.",
        href, amountCents: j.order_amount ?? null, sinceSec: Number(j.created_at) || null,
        entityKind: "job", entityId: String(j.id), orderId: j.order_id || null,
        action: j.order_id ? "create_job" : null, actionLabel: j.order_id ? "Create job" : null,
      });
      continue;
    }
    const lulu = String(j.lulu_status || "").toUpperCase();
    const title =
      lulu === "REJECTED" ? "Print job rejected by Lulu"
      : lulu === "ERROR" ? "Print job errored at Lulu"
      : "Print job failed";
    items.push({
      id: `print_job_failed:${j.id}`, severity: "action", category: "print_jobs",
      title,
      detail: j.last_error ? String(j.last_error).slice(0, 160) : undefined,
      href, amountCents: j.order_amount ?? null, sinceSec: Number(j.created_at) || null,
      entityKind: "job", entityId: String(j.id), orderId: j.order_id || null,
      action: j.order_id ? "sync_job" : null, actionLabel: j.order_id ? "Sync status" : null,
    });
  }

  if (opts.podActive) {
    const stuck = await all(
      `SELECT j.id, j.order_id, j.club_box_id, j.created_at, o.amount AS order_amount, o.email AS order_email
         FROM print_jobs j LEFT JOIN orders o ON o.id = j.order_id
        WHERE j.status = 'queued' AND j.created_at < ? ORDER BY j.created_at ASC LIMIT 50`,
      nowSec - DAY
    );
    for (const j of stuck) {
      if (j.order_email && TEST_SET.has(String(j.order_email).toLowerCase())) continue;
      items.push({
        id: `print_job_stuck:${j.id}`, severity: "action", category: "print_jobs",
        title: "Print job waiting over a day to reach the printer",
        href: j.order_id ? `/admin/orders/${j.order_id}` : j.club_box_id ? `/admin/orders/box/${j.club_box_id}` : "/admin/orders",
        amountCents: j.order_amount ?? null, sinceSec: Number(j.created_at) || null,
        entityKind: "job", entityId: String(j.id), orderId: j.order_id || null,
        action: j.order_id ? "sync_job" : null, actionLabel: j.order_id ? "Sync status" : null,
      });
    }
    const longProd = await all(
      `SELECT j.id, j.order_id, j.club_box_id, j.created_at, o.amount AS order_amount, o.email AS order_email
         FROM print_jobs j LEFT JOIN orders o ON o.id = j.order_id
        WHERE j.status = 'submitted' AND j.created_at < ?
          AND COALESCE(j.lulu_status, '') NOT IN ('SHIPPED', 'DELIVERED', 'CANCELED')
        ORDER BY j.created_at ASC LIMIT 50`,
      nowSec - 7 * DAY
    );
    for (const j of longProd) {
      if (j.order_email && TEST_SET.has(String(j.order_email).toLowerCase())) continue;
      items.push({
        id: `print_job_long:${j.id}`, severity: "action", category: "print_jobs",
        title: "Print job at the printer over a week without shipping",
        href: j.order_id ? `/admin/orders/${j.order_id}` : j.club_box_id ? `/admin/orders/box/${j.club_box_id}` : "/admin/orders",
        amountCents: j.order_amount ?? null, sinceSec: Number(j.created_at) || null,
        entityKind: "job", entityId: String(j.id), orderId: j.order_id || null,
        action: j.order_id ? "sync_job" : null, actionLabel: j.order_id ? "Sync status" : null,
      });
    }
    // Paid printed orders with no print job a day after payment.
    const noJob = await all(
      `SELECT o.id, o.amount, o.created_at FROM orders o
        WHERE o.status = 'complete' AND o.physical_status IS NOT NULL
          AND COALESCE(o.source, '') != 'manual' AND o.created_at < ?
          AND NOT EXISTS (SELECT 1 FROM print_jobs j WHERE j.order_id = o.id)
          AND ${notTest("o.email")}
        ORDER BY o.created_at ASC LIMIT 50`,
      nowSec - DAY, ...testBinds()
    );
    for (const o of noJob) {
      items.push({
        id: `order_no_job:${o.id}`, severity: "action", category: "print_jobs",
        title: "Paid printed order has no print job a day after payment",
        href: `/admin/orders/${o.id}`, amountCents: o.amount ?? null,
        sinceSec: Number(o.created_at) || null,
        entityKind: "order", entityId: String(o.id), orderId: String(o.id),
        action: "create_job", actionLabel: "Create print job",
      });
    }
  }

  // ---- Orders -----------------------------------------------------
  // Printed orders waiting 3+ days to ship (home lane). When the POD
  // lane is on and the order simply has no job, order_no_job above is
  // the sharper item, so skip those here to keep one problem = one row.
  const aged = await all(
    `SELECT o.id, o.amount, o.created_at, o.source FROM orders o
      WHERE o.status = 'complete'
        AND o.physical_status IN ('preorder_received', 'in_print', 'packed')
        AND o.created_at < ? AND ${notTest("o.email")}
        ${opts.podActive ? "AND (COALESCE(o.source, '') = 'manual' OR EXISTS (SELECT 1 FROM print_jobs j WHERE j.order_id = o.id))" : ""}
      ORDER BY o.created_at ASC LIMIT 50`,
    nowSec - 3 * DAY, ...testBinds()
  );
  for (const o of aged) {
    const days = Math.max(1, Math.floor((nowSec - Number(o.created_at)) / DAY));
    items.push({
      id: `order_aged:${o.id}`, severity: "action", category: "orders",
      title: `Printed order waiting ${days} ${days === 1 ? "day" : "days"} to ship`,
      href: `/admin/orders/${o.id}`, amountCents: o.amount ?? null,
      sinceSec: Number(o.created_at) || null,
      entityKind: "order", entityId: String(o.id), orderId: String(o.id),
    });
  }
  // Manual orders wait on the operator's button: awareness, not alarm.
  const manual = await all(
    `SELECT o.id, o.amount, o.created_at FROM orders o
      WHERE o.status = 'complete' AND o.source = 'manual'
        AND o.physical_status IN ('preorder_received', 'in_print', 'packed')
        AND NOT EXISTS (SELECT 1 FROM print_jobs j WHERE j.order_id = o.id)
        AND ${notTest("o.email")}
      ORDER BY o.created_at ASC LIMIT 50`,
    ...testBinds()
  );
  for (const o of manual) {
    items.push({
      id: `order_manual:${o.id}`, severity: "awareness", category: "orders",
      title: "Manual order waiting on the print button",
      detail: "Manual orders get a print job only when you create one.",
      href: `/admin/orders/${o.id}`, amountCents: o.amount ?? null,
      sinceSec: Number(o.created_at) || null,
      entityKind: "order", entityId: String(o.id), orderId: String(o.id),
      action: "create_job", actionLabel: "Create print job",
    });
  }

  // ---- Club boxes ---------------------------------------------------
  const overdueBoxes = await all(
    `SELECT b.id, b.ship_date, b.status,
            (SELECT j.status FROM print_jobs j WHERE j.club_box_id = b.id ORDER BY j.created_at DESC LIMIT 1) AS job_status,
            (SELECT j.lulu_status FROM print_jobs j WHERE j.club_box_id = b.id ORDER BY j.created_at DESC LIMIT 1) AS job_lulu
       FROM club_cycle_boxes b LEFT JOIN club_signups s ON s.id = b.signup_id
      WHERE b.ship_date < ? AND b.status NOT IN ('shipped', 'delivered', 'skipped', 'canceled')
        AND ${notTest("s.email")}
      ORDER BY b.ship_date ASC LIMIT 50`,
    todayIso, ...testBinds()
  );
  for (const b of overdueBoxes) {
    const atPrinter = b.job_status === "submitted" && !["SHIPPED", "DELIVERED", "CANCELED"].includes(String(b.job_lulu || "").toUpperCase());
    items.push({
      id: `box_overdue:${b.id}`, severity: atPrinter ? "awareness" : "action", category: "club",
      title: atPrinter ? "Club box past its ship date, at the printer" : "Club box past its ship date",
      detail: `Was due ${b.ship_date}.${atPrinter ? " The books are at Lulu; nothing here is waiting on us." : ""}`,
      href: `/admin/orders/box/${b.id}`,
      sinceSec: Math.floor(Date.parse(String(b.ship_date) + "T12:00:00Z") / 1000) || null,
      entityKind: "box", entityId: String(b.id),
    });
  }
  const soonLimit = new Date((nowSec + 2 * DAY) * 1000).toISOString().slice(0, 10);
  const dueSoon = await all(
    `SELECT b.id, b.ship_date FROM club_cycle_boxes b LEFT JOIN club_signups s ON s.id = b.signup_id
      WHERE b.status IN ('awaiting_selection', 'needs_attention')
        AND b.ship_date >= ? AND b.ship_date <= ? AND ${notTest("s.email")}
      ORDER BY b.ship_date ASC LIMIT 50`,
    todayIso, soonLimit, ...testBinds()
  );
  for (const b of dueSoon) {
    items.push({
      id: `box_due_soon:${b.id}`, severity: "action", category: "club",
      title: opts.podActive ? "Club box ships within 2 days, contents not settled yet" : "Club box ships within 2 days, not yet being prepared",
      detail: `Ship date ${b.ship_date}.`,
      href: `/admin/orders/box/${b.id}`,
      sinceSec: Math.floor(Date.parse(String(b.ship_date) + "T12:00:00Z") / 1000) || null,
      entityKind: "box", entityId: String(b.id),
    });
  }

  // ---- Email & files ------------------------------------------------
  const failedChanges = await all("SELECT COUNT(*) AS n FROM change_requests WHERE status = 'failed'").catch(() => []);
  const fc = Number((failedChanges[0] as any)?.n ?? 0);
  if (fc > 0) {
    items.push({
      id: "changes_failed", severity: "action", category: "email_files",
      title: `${fc} page ${fc === 1 ? "fix" : "fixes"} failed`,
      detail: "Those pages kept their old art.",
      href: "/admin/books", entityKind: "system",
    });
  }
  const outboxFailed = await all("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM email_outbox WHERE status = 'failed'").catch(() => []);
  const ofRow: any = outboxFailed[0] || {};
  if (Number(ofRow?.n ?? 0) > 0) {
    items.push({
      id: "outbox_failed", severity: "action", category: "email_files",
      title: `${Number(ofRow.n)} ${Number(ofRow.n) === 1 ? "email" : "emails"} failed to send`,
      href: "/admin/orders", sinceSec: ofRow.oldest ? Number(ofRow.oldest) : null,
      entityKind: "system", action: "retry_emails", actionLabel: "Retry outbox",
    });
  }
  const outboxPending = await all("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM email_outbox WHERE status = 'pending' AND created_at < ?", nowSec - 600).catch(() => []);
  const opRow: any = outboxPending[0] || {};
  if (Number(opRow?.n ?? 0) > 0) {
    items.push({
      id: "outbox_pending", severity: "awareness", category: "email_files",
      title: `${Number(opRow.n)} ${Number(opRow.n) === 1 ? "email" : "emails"} waiting in the outbox`,
      href: "/admin/orders", sinceSec: opRow.oldest ? Number(opRow.oldest) : null,
      entityKind: "system", action: "retry_emails", actionLabel: "Retry outbox",
    });
  }

  const sevRank = (s: NotificationSeverity) => (s === "action" ? 0 : 1);
  items.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || (a.sinceSec ?? Infinity) - (b.sinceSec ?? Infinity));
  return items;
}
