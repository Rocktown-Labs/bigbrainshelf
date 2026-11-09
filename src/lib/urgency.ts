// Time-based urgency for the admin dashboard and the daily digest
// (CG, 2026-11-02): the dashboard counted states but never noticed
// TIME. A club box whose ship date passed unshipped, or a printed
// order that has waited days to go out, is urgent even when nothing
// has flagged it by hand. These queries compute urgency from the
// live rows themselves, so the panel and the digest can never drift
// out of sync with the store's actual state.
//
// POD rework (CG, 2026-11-09): with print-on-demand fulfillment
// (the Lulu lane) an order sitting in production is the system
// working, not a problem, and a locked club box needs no preparing.
// When the lane is on (podActive), urgency becomes exception-based:
// it fires on the ways the autonomous flow can fail (a print job
// Lulu rejected, a paid order whose job never got submitted, a job
// stuck in its queue or in production far past the normal window),
// while orders and boxes the printer is already handling move to
// quiet informational counts. With the lane off, the home
// fulfillment semantics below apply unchanged.

export interface UrgencyData {
  overdueBoxes: { shipDate: string; status: string; daysOverdue: number }[];
  overdueBoxCount: number;
  boxesDueSoon: number;
  agedOrders: { id: string; ageDays: number; physicalStatus: string }[];
  agedOrderCount: number;
  failedChanges: number;
  // POD exception categories (zero unless podActive, except the
  // failed print jobs, which are worth surfacing in either world).
  failedPrintJobs: { id: string; orderId: string | null; clubBoxId: string | null; lastError: string }[];
  failedPrintJobCount: number;
  stuckPrintJobCount: number;
  unsubmittedOrderCount: number;
  longProductionCount: number;
  // Informational only: real states, no action needed or action
  // that is CG's by design. Never counted in total.
  overdueBoxesInProduction: number;
  manualOrdersWaiting: number;
  infoTotal: number;
  podActive: boolean;
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

// A print job still queued this long after creation is not waiting
// its turn; auto-placement submits within minutes and its retries
// run on the quarter-hour cron. A day in the queue means the
// submission keeps failing.
export const STUCK_PRINT_JOB_DAYS = 1;

// A submitted job with no shipment after this long is past Lulu's
// normal production window and worth a human look.
export const LONG_PRODUCTION_DAYS = 7;

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

const PRE_SHIP = "('preorder_received', 'in_print', 'packed')";

export async function getUrgency(
  db: any,
  nowSec: number,
  todayIso: string,
  opts: { podActive?: boolean } = {}
): Promise<UrgencyData> {
  const pod = !!opts.podActive;
  // Club boxes past their ship date and not on their way. The box
  // belongs to a club signup; test-account boxes are excluded. With
  // POD on, a box whose print job is submitted is the printer's
  // clock, not ours: it leaves the urgent set and is counted as
  // informational below.
  const boxTest = notTestEmail("s.email");
  const boxJobCover = pod
    ? "AND NOT EXISTS (SELECT 1 FROM print_jobs j WHERE j.club_box_id = b.id AND j.status = 'submitted')"
    : "";
  const overdueBoxCount = await count(
    db,
    `SELECT COUNT(*) AS n FROM club_cycle_boxes b
     LEFT JOIN club_signups s ON s.id = b.signup_id
     WHERE b.ship_date < ? AND b.status NOT IN ('shipped', 'delivered', 'skipped', 'canceled')
       AND ${boxTest.sql} ${boxJobCover}`,
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
           AND ${boxTest.sql} ${boxJobCover}
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
  const overdueBoxesInProduction = pod
    ? await count(
        db,
        `SELECT COUNT(*) AS n FROM club_cycle_boxes b
         LEFT JOIN club_signups s ON s.id = b.signup_id
         WHERE b.ship_date < ? AND b.status NOT IN ('shipped', 'delivered', 'skipped', 'canceled')
           AND EXISTS (SELECT 1 FROM print_jobs j WHERE j.club_box_id = b.id AND j.status = 'submitted')
           AND ${boxTest.sql}`,
        todayIso,
        ...boxTest.binds
      ).catch(() => 0)
    : 0;

  // Boxes shipping within two days whose contents are not settled.
  // At home this also caught locked boxes (packed by hand, so a
  // locked box near its date needed preparing). Under POD a locked
  // box submits its print job on its own; only an unsettled box
  // (the member has not picked and no mystery assignment has run)
  // is still a human concern.
  const soonIso = isoDay(nowSec + 2 * DAY);
  const boxesDueSoon = await count(
    db,
    `SELECT COUNT(*) AS n FROM club_cycle_boxes b
     LEFT JOIN club_signups s ON s.id = b.signup_id
     WHERE b.ship_date >= ? AND b.ship_date <= ? AND b.status IN (${pod ? "'awaiting_selection'" : "'awaiting_selection', 'locked'"})
       AND ${boxTest.sql}`,
    todayIso,
    soonIso,
    ...boxTest.binds
  ).catch(() => 0);

  // Printed orders paid and waiting too long to ship. Under POD an
  // order with a print job lives on the job rules below, so it
  // leaves this set; what remains is home-fulfilled work.
  const orderTest = notTestEmail("email");
  const orderJobCover = pod
    ? "AND NOT EXISTS (SELECT 1 FROM print_jobs j WHERE j.order_id = orders.id) AND COALESCE(source, '') != 'manual'"
    : "";
  const agedBefore = nowSec - AGED_ORDER_DAYS * DAY;
  const agedOrderCount = await count(
    db,
    `SELECT COUNT(*) AS n FROM orders
     WHERE status = 'complete' AND physical_status IN ${PRE_SHIP}
       AND created_at < ? AND ${orderTest.sql} ${orderJobCover}`,
    agedBefore,
    ...orderTest.binds
  ).catch(() => 0);
  let agedOrders: UrgencyData["agedOrders"] = [];
  if (agedOrderCount > 0) {
    const rows = await db
      .prepare(
        `SELECT id, physical_status, created_at FROM orders
         WHERE status = 'complete' AND physical_status IN ${PRE_SHIP}
           AND created_at < ? AND ${orderTest.sql} ${orderJobCover}
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

  // Print jobs Lulu rejected or errored on. Terminal and silent
  // without this: the order looks normal everywhere else.
  const failedPrintJobCount = await count(
    db,
    "SELECT COUNT(*) AS n FROM print_jobs WHERE status = 'failed'"
  ).catch(() => 0);
  let failedPrintJobs: UrgencyData["failedPrintJobs"] = [];
  if (failedPrintJobCount > 0) {
    const rows = await db
      .prepare(
        "SELECT id, order_id, club_box_id, last_error FROM print_jobs WHERE status = 'failed' ORDER BY updated_at ASC LIMIT 5"
      )
      .bind()
      .all()
      .catch(() => ({ results: [] }));
    failedPrintJobs = (((rows as any).results || []) as any[]).map((r) => ({
      id: String(r.id),
      orderId: r.order_id ? String(r.order_id) : null,
      clubBoxId: r.club_box_id ? String(r.club_box_id) : null,
      lastError: String(r.last_error || ""),
    }));
  }

  // POD-only exceptions. Before cutover these queries stay silent:
  // queued rows and unsubmitted orders are the home flow's normal
  // state, not failures.
  let stuckPrintJobCount = 0;
  let unsubmittedOrderCount = 0;
  let longProductionCount = 0;
  if (pod) {
    stuckPrintJobCount = await count(
      db,
      "SELECT COUNT(*) AS n FROM print_jobs WHERE status = 'queued' AND created_at < ?",
      nowSec - STUCK_PRINT_JOB_DAYS * DAY
    ).catch(() => 0);
    // Paid printed orders a day old with no print job at all:
    // auto-placement runs at completion, so a missing job means the
    // placement never happened (or the book could not be placed).
    // Manual orders are excluded here; they wait on CG by design
    // and are counted as informational below.
    unsubmittedOrderCount = await count(
      db,
      `SELECT COUNT(*) AS n FROM orders
       WHERE status = 'complete' AND physical_status IN ${PRE_SHIP}
         AND created_at < ? AND COALESCE(source, '') != 'manual'
         AND NOT EXISTS (SELECT 1 FROM print_jobs j WHERE j.order_id = orders.id)
         AND ${orderTest.sql}`,
      nowSec - DAY,
      ...orderTest.binds
    ).catch(() => 0);
    longProductionCount = await count(
      db,
      `SELECT COUNT(*) AS n FROM print_jobs
       WHERE status = 'submitted' AND created_at < ?
         AND (lulu_status IS NULL OR lulu_status NOT IN ('SHIPPED', 'DELIVERED', 'CANCELED'))`,
      nowSec - LONG_PRODUCTION_DAYS * DAY
    ).catch(() => 0);
  }

  // Manual orders wait for CG to submit their print job from the
  // admin. That is the design, so they never inflate the urgent
  // total; the digest reports them as awareness.
  const manualOrdersWaiting = await count(
    db,
    `SELECT COUNT(*) AS n FROM orders
     WHERE source = 'manual' AND status = 'complete' AND physical_status IN ${PRE_SHIP}
       AND ${orderTest.sql}`,
    ...orderTest.binds
  ).catch(() => 0);

  // Page fixes that failed (the page kept its old art; someone
  // should know it is waiting on a decision).
  const failedChanges = await count(
    db,
    "SELECT COUNT(*) AS n FROM change_requests WHERE status = 'failed'"
  ).catch(() => 0);

  const total =
    overdueBoxCount +
    boxesDueSoon +
    agedOrderCount +
    failedChanges +
    failedPrintJobCount +
    stuckPrintJobCount +
    unsubmittedOrderCount +
    longProductionCount;
  const infoTotal = overdueBoxesInProduction + manualOrdersWaiting;
  return {
    overdueBoxes,
    overdueBoxCount,
    boxesDueSoon,
    agedOrders,
    agedOrderCount,
    failedChanges,
    failedPrintJobs,
    failedPrintJobCount,
    stuckPrintJobCount,
    unsubmittedOrderCount,
    longProductionCount,
    overdueBoxesInProduction,
    manualOrdersWaiting,
    infoTotal,
    podActive: pod,
    total,
  };
}
