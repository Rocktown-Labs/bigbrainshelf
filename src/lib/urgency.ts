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

// Test orders never count as urgent (CG, 2026-11-04). Orders and
// club memberships under CG's own test addresses are placed by RGM
// and CG while testing checkout, labels, and admin flows; the first
// live digests cried wolf over a shelf of them ("they are test
// orders that you placed lol"). Rows whose account cannot be
// identified (a box with no signup row) still count: when in doubt,
// the digest speaks.
export const TEST_ORDER_EMAILS = [
  "camstewart7@gmail.com",
  "camgstewart@icloud.com",
  "babyfacecam@icloud.com",
  "cgstewart11@yahoo.com",
  // The retired fake buyer address from the Oct 31 tests (it
  // bounces; CG's rule since is real addresses only). It can never
  // be a real customer, and one legacy test order still sits under
  // it, so it stays on the list to keep that order quiet.
  "test.buyer@example.com",
] as const;

function notTestEmail(column: string): { sql: string; binds: string[] } {
  const marks = TEST_ORDER_EMAILS.map(() => "?").join(", ");
  return {
    sql: `LOWER(COALESCE(${column}, '')) NOT IN (${marks})`,
    binds: [...TEST_ORDER_EMAILS],
  };
}

export async function getUrgency(db: any, nowSec: number, todayIso: string): Promise<UrgencyData> {
  // Club boxes past their ship date and not on their way. The box
  // belongs to a club signup; test-account boxes are excluded.
  const boxTest = notTestEmail("s.email");
  const overdueBoxCount = await count(
    db,
    `SELECT COUNT(*) AS n FROM club_cycle_boxes b
     LEFT JOIN club_signups s ON s.id = b.signup_id
     WHERE b.ship_date < ? AND b.status NOT IN ('shipped', 'delivered', 'skipped', 'canceled')
       AND ${boxTest.sql}`,
    todayIso,
    ...boxTest.binds
  ).catch(() => 0);
  let overdueBoxes: UrgencyData["overdueBoxes"] = [];
  if (overdueBoxCount > 0) {
    const rows = await db
      .prepare(
        `SELECT b.ship_date AS ship_date, b.status AS status FROM club_cycle_boxes b
         LEFT JOIN club_signups s ON s.id = b.signup_id
         WHERE b.ship_date < ? AND b.status NOT IN ('shipped', 'delivered', 'skipped', 'canceled')
           AND ${boxTest.sql}
         ORDER BY b.ship_date ASC LIMIT 5`
      )
      .bind(todayIso, ...boxTest.binds)
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
    `SELECT COUNT(*) AS n FROM club_cycle_boxes b
     LEFT JOIN club_signups s ON s.id = b.signup_id
     WHERE b.ship_date >= ? AND b.ship_date <= ? AND b.status IN ('awaiting_selection', 'locked')
       AND ${boxTest.sql}`,
    todayIso,
    soonIso,
    ...boxTest.binds
  ).catch(() => 0);

  // Printed orders paid and waiting too long to ship.
  const orderTest = notTestEmail("email");
  const agedBefore = nowSec - AGED_ORDER_DAYS * DAY;
  const agedOrderCount = await count(
    db,
    `SELECT COUNT(*) AS n FROM orders
     WHERE status = 'complete' AND physical_status IN ('preorder_received', 'in_print', 'packed')
       AND created_at < ? AND ${orderTest.sql}`,
    agedBefore,
    ...orderTest.binds
  ).catch(() => 0);
  let agedOrders: UrgencyData["agedOrders"] = [];
  if (agedOrderCount > 0) {
    const rows = await db
      .prepare(
        `SELECT id, physical_status, created_at FROM orders
         WHERE status = 'complete' AND physical_status IN ('preorder_received', 'in_print', 'packed')
           AND created_at < ? AND ${orderTest.sql}
         ORDER BY created_at ASC LIMIT 5`
      )
      .bind(agedBefore, ...orderTest.binds)
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
