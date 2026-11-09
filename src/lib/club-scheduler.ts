// The worker's scheduled entry point (Book Club V2).
//
// The cron trigger (every 15 minutes, registered by deploy.py on the
// live worker) runs this pass:
//   1. flush outbox rows that are due (the request-path flush hooks in
//      the webhook and admin/subscribe/club routes stay as a backup,
//      not the mechanism),
//   2. the club cycle pass (generate upcoming boxes, enqueue selection
//      reminders, lock and resolve boxes at their lock date, enqueue
//      locked / action-needed emails),
//   3. the Shippo tracking poll (shipped orders: store the carrier's
//      latest status text; DELIVERED advances the order to delivered
//      and enqueues its one delivered email),
//   4. flush again so mail enqueued by steps 2 and 3 starts moving in
//      the same pass instead of waiting for the next tick.
//
// Every step is idempotent and bounded (club pass at 100 rows per
// phase, outbox at 100 rows per flush), so a backlog drains over ticks
// instead of one huge pass, and a crashed or retried tick can never
// double-send or double-create.

import type { DBLike } from "./orders";
import { setPhysicalStatus } from "./orders";
import { flushOutbox } from "./email";
import { runClubCycleScheduler, type ClubSchedulerSummary } from "./club-cycles";
import { ensureOrderTrackingColumns, getShippoTracking, shippoConfigured } from "./shippo";
import { runBirthdayGiftScheduler } from "./revops";

export type OutboxFlushSummary = Awaited<ReturnType<typeof flushOutbox>>;

const emptyFlush = (): OutboxFlushSummary => ({ attempted: 0, sent: 0, failed: 0, skipped: 0 });

export interface TrackingPollSummary {
  checked: number;
  delivered: number;
  errors: number;
}

const emptyTracking = (): TrackingPollSummary => ({ checked: 0, delivered: 0, errors: 0 });

// Shippo tracking poll (owner, 2026-10-29): for paid orders sitting
// at physical_status = shipped with a tracking number, ask Shippo
// for the carrier status. The carrier's latest detail text is stored
// on the order (tracking_status) for the admin detail page. When
// Shippo reports DELIVERED, the order advances through
// setPhysicalStatus, which enqueues the one delivered email (the
// outbox (order_id, kind) dedupe keeps it exactly once across
// re-polls). Other statuses never move our stage. Defensive by
// design: a bounded batch, a per-order try/catch, and an unconfigured
// Shippo (or a missing carrier) is a quiet no-op, so this step can
// never break the club scheduler that shares the cron tick.
export async function pollShippedOrderTracking(
  db: DBLike,
  env: any,
  site: string,
  batch = 25
): Promise<TrackingPollSummary> {
  const summary = emptyTracking();
  if (!shippoConfigured(env)) return summary;
  await ensureOrderTrackingColumns(db);
  const { results } = await db
    .prepare(
      `SELECT id, carrier, tracking_number FROM orders
       WHERE status = 'complete' AND physical_status = 'shipped'
         AND tracking_number IS NOT NULL AND tracking_number != ''
       ORDER BY created_at ASC LIMIT ?`
    )
    .bind(batch)
    .all();
  for (const order of (results || []) as any[]) {
    summary.checked++;
    try {
      const t = await getShippoTracking(env, String(order.carrier || ""), String(order.tracking_number || ""));
      const text = t.statusDetails || humanizeTrackingStatus(t.status);
      if (text) {
        await db
          .prepare("UPDATE orders SET tracking_status = ? WHERE id = ?")
          .bind(text, String(order.id))
          .run();
      }
      if (t.status === "DELIVERED") {
        const res = await setPhysicalStatus(db, site, String(order.id), "delivered");
        if (res.ok) summary.delivered++;
      }
    } catch (err: any) {
      summary.errors++;
      console.error("tracking poll failed for order", String(order.id), err?.message || err);
    }
  }
  return summary;
}

export function humanizeTrackingStatus(status: string): string {
  switch (String(status || "").toUpperCase()) {
    case "PRE_TRANSIT": return "Label created";
    case "TRANSIT": return "In transit";
    case "DELIVERED": return "Delivered";
    case "RETURNED": return "Returned to sender";
    case "FAILURE": return "Delivery problem";
    default: return "";
  }
}

export interface ScheduledWorkSummary {
  flushedBefore: OutboxFlushSummary;
  club: ClubSchedulerSummary;
  birthdayGifts?: { checkedKids: number; queuedBirthdayEmails: number };
  adminDigest?: { queued: number; urgentTotal: number };
  delayEmails?: { ordersQueued: number; boxesQueued: number };
  printFulfillment?: {
    submitted: number;
    failed: number;
    dispatchErrors: number;
    synced: number;
    shipped: number;
    delivered: number;
    syncErrors: number;
  };
  tracking: TrackingPollSummary;
  flushedAfter: OutboxFlushSummary;
}

export async function runScheduledWork(
  db: DBLike,
  env: any,
  opts: { now?: Date; site?: string; batch?: number } = {}
): Promise<ScheduledWorkSummary> {
  const site = opts.site || env?.BETTER_AUTH_URL || "https://bigbrainshelf.com";
  const batch = opts.batch ?? 100;
  let flushedBefore = emptyFlush();
  try {
    flushedBefore = await flushOutbox(db, env, batch, site);
  } catch (err: any) {
    console.error("scheduled outbox flush (before) failed", err?.message || err);
  }
  const club = await runClubCycleScheduler(db, { site, now: opts.now, batch, env });
  // Comp memberships (granted free years) whose window has closed
  // flip to canceled here, so status-only readers (member counts,
  // the admin list) agree with the time-boxed access guards.
  try {
    const { expireCompMemberships } = await import("./club");
    await expireCompMemberships(db);
  } catch (err: any) {
    console.error("scheduled comp expiry failed", err?.message || err);
  }
  let birthdayGifts = { checkedKids: 0, queuedBirthdayEmails: 0 };
  try {
    birthdayGifts = await runBirthdayGiftScheduler(db as any, site, opts.now || new Date());
  } catch (err: any) {
    console.error("scheduled birthday gift pass failed", err?.message || err);
  }
  let adminDigest = { queued: 0, urgentTotal: 0 };
  try {
    const { runAdminDigest } = await import("./admin-digest");
    const { luluConfigured } = await import("./lulu");
    adminDigest = await runAdminDigest(db as any, opts.now || new Date(), {
      podActive: luluConfigured(env),
    });
  } catch (err: any) {
    console.error("scheduled admin digest failed", err?.message || err);
  }
  // Running-late apologies (S5): printed orders and settled club
  // boxes past their promised ship-by date get their one delay
  // email. Dedupe-guarded, so repeat ticks never re-send.
  let delayEmails = { ordersQueued: 0, boxesQueued: 0 };
  try {
    const { runDelayEmailScheduler } = await import("./delay-emails");
    delayEmails = await runDelayEmailScheduler(db, site, opts.now || new Date());
  } catch (err: any) {
    console.error("scheduled delay email pass failed", err?.message || err);
  }
  let tracking = emptyTracking();
  try {
    tracking = await pollShippedOrderTracking(db, env, site, 25);
  } catch (err: any) {
    console.error("scheduled tracking poll failed", err?.message || err);
  }
  // Lulu print fulfillment (dispatcher + status poll). A quiet
  // no-op unless FULFILLMENT_PROVIDER=lulu and the credential pair
  // for the selected Lulu environment is present: submit queued
  // print jobs, then mirror Lulu's progress (per-item shipments,
  // derived order physical_status) back onto our rows.
  let printFulfillment = {
    submitted: 0, failed: 0, dispatchErrors: 0,
    synced: 0, shipped: 0, delivered: 0, syncErrors: 0,
  };
  try {
    const { runPrintFulfillmentPass } = await import("./print-fulfillment");
    const pass = await runPrintFulfillmentPass(db, env, { site, batch: 25 });
    printFulfillment = {
      submitted: pass.dispatched.submitted,
      failed: pass.dispatched.failed,
      dispatchErrors: pass.dispatched.errors,
      synced: pass.synced.synced,
      shipped: pass.synced.shipped,
      delivered: pass.synced.delivered,
      syncErrors: pass.synced.errors,
    };
  } catch (err: any) {
    console.error("scheduled print fulfillment pass failed", err?.message || err);
  }
  let flushedAfter = emptyFlush();
  try {
    flushedAfter = await flushOutbox(db, env, batch, site);
  } catch (err: any) {
    console.error("scheduled outbox flush (after) failed", err?.message || err);
  }
  return { flushedBefore, club, birthdayGifts, adminDigest, delayEmails, tracking, printFulfillment, flushedAfter };
}
