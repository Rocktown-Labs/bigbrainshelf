// Time-based urgency for the admin dashboard and the daily digest
// (CG, 2026-11-02): the dashboard counted states but never noticed
// TIME. A club box whose ship date passed unshipped, or a printed
// order that has waited days to go out, is urgent even when nothing
// has flagged it by hand. These queries compute urgency from the
// live rows themselves, so the panel and the digest can never drift
// out of sync with the store's actual state.

export interface UrgencyData {
  overdueBoxes: { shipDate: string; status: string; daysOverdue: number }[];
  overdueBoxCount: number;
  boxesDueSoon: number;
  agedOrders: { id: string; ageDays: number; physicalStatus: string }[];
  agedOrderCount: number;
  failedChanges: number;
  total: number;
}

const DAY = 86400;

function isoDay(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / (DAY * 1000));
}

async function count(db: any, sql: string, ...args: any[]): Promise<number> {
  const row = await db.prepare(sql).bind(...args).first();
  return Number((row as any)?.n || 0);
}

// A printed order counts as aged once it has waited this long in a
// pre-shipping stage. Club boxes ship within a few days of joining;
// standalone printed orders should move on the same clock.
export const AGED_ORDER_DAYS = 3;

export async function getUrgency(db: any, nowSec: number, todayIso: string): Promise<UrgencyData> {
  // Club boxes past their ship date and not on their way.
  const overdueBoxCount = await count(
    db,
    `SELECT COUNT(*) AS n FROM club_cycle_boxes
     WHERE ship_date < ? AND status NOT IN ('shipped', 'delivered', 'skipped', 'canceled')`,
    todayIso
  ).catch(() => 0);
  let overdueBoxes: UrgencyData["overdueBoxes"] = [];
  if (overdueBoxCount > 0) {
    const rows = await db
      .prepare(
        `SELECT ship_date, status FROM club_cycle_boxes
         WHERE ship_date < ? AND status NOT IN ('shipped', 'delivered', 'skipped', 'canceled')
         ORDER BY ship_date ASC LIMIT 5`
      )
      .bind(todayIso)
      .all()
      .catch(() => ({ results: [] }));
    overdueBoxes = (((rows as any).results || []) as any[]).map((r) => ({
      shipDate: String(r.ship_date),
      status: String(r.status),
      daysOverdue: daysBetween(String(r.ship_date), todayIso),
    }));
  }

  // Boxes shipping within two days that are not even being prepared.
  const soonIso = isoDay(nowSec + 2 * DAY);
  const boxesDueSoon = await count(
    db,
    `SELECT COUNT(*) AS n FROM club_cycle_boxes
     WHERE ship_date >= ? AND ship_date <= ? AND status IN ('awaiting_selection', 'locked')`,
    todayIso,
    soonIso
  ).catch(() => 0);

  // Printed orders paid and waiting too long to ship.
  const agedBefore = nowSec - AGED_ORDER_DAYS * DAY;
  const agedOrderCount = await count(
    db,
    `SELECT COUNT(*) AS n FROM orders
     WHERE status = 'complete' AND physical_status IN ('preorder_received', 'in_print', 'packed')
       AND created_at < ?`,
    agedBefore
  ).catch(() => 0);
  let agedOrders: UrgencyData["agedOrders"] = [];
  if (agedOrderCount > 0) {
    const rows = await db
      .prepare(
        `SELECT id, physical_status, created_at FROM orders
         WHERE status = 'complete' AND physical_status IN ('preorder_received', 'in_print', 'packed')
           AND created_at < ?
         ORDER BY created_at ASC LIMIT 5`
      )
      .bind(agedBefore)
      .all()
      .catch(() => ({ results: [] }));
    agedOrders = (((rows as any).results || []) as any[]).map((r) => ({
      id: String(r.id),
      physicalStatus: String(r.physical_status),
      ageDays: Math.floor((nowSec - Number(r.created_at || nowSec)) / DAY),
    }));
  }

  // Page fixes that failed (the page kept its old art; someone
  // should know it is waiting on a decision).
  const failedChanges = await count(
    db,
    "SELECT COUNT(*) AS n FROM change_requests WHERE status = 'failed'"
  ).catch(() => 0);

  const total = overdueBoxCount + boxesDueSoon + agedOrderCount + failedChanges;
  return { overdueBoxes, overdueBoxCount, boxesDueSoon, agedOrders, agedOrderCount, failedChanges, total };
}
