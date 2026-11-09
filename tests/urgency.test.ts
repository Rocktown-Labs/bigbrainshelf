// Urgency tests: the admin digest and dashboard count time-based
// urgency from live rows, and test orders never count (CG,
// 2026-11-04: the first digests cried wolf over RGM's own test
// orders). Orders and boxes under CG's test addresses are excluded;
// a box whose signup cannot be identified still counts.
import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { getUrgency, TEST_ORDER_EMAILS, AGED_ORDER_DAYS } from '../src/lib/urgency';

const NOW = Math.floor(Date.parse('2026-11-04T12:00:00Z') / 1000);
const TODAY = '2026-11-04';

function makeDb() {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE orders (id TEXT, email TEXT, status TEXT, physical_status TEXT, created_at INTEGER);
    CREATE TABLE club_signups (id TEXT, email TEXT);
    CREATE TABLE club_cycle_boxes (id TEXT, signup_id TEXT, ship_date TEXT, status TEXT);
    CREATE TABLE change_requests (id TEXT, status TEXT);
  `);
  const old = NOW - (AGED_ORDER_DAYS + 2) * 86400;
  const ins = (sql: string) => raw.prepare(sql);
  ins('INSERT INTO orders VALUES (?, ?, ?, ?, ?)').run('ord-test', 'CamStewart7@Gmail.com', 'complete', 'preorder_received', old);
  ins('INSERT INTO orders VALUES (?, ?, ?, ?, ?)').run('ord-real', 'reader@example.com', 'complete', 'in_print', old);
  ins('INSERT INTO club_signups VALUES (?, ?)').run('s-test', 'babyfacecam@icloud.com');
  ins('INSERT INTO club_signups VALUES (?, ?)').run('s-real', 'reader@example.com');
  ins('INSERT INTO club_cycle_boxes VALUES (?, ?, ?, ?)').run('box-test', 's-test', '2026-10-31', 'locked');
  ins('INSERT INTO club_cycle_boxes VALUES (?, ?, ?, ?)').run('box-real', 's-real', '2026-11-01', 'preparing');
  ins('INSERT INTO club_cycle_boxes VALUES (?, ?, ?, ?)').run('box-orphan', 'missing-signup', '2026-10-30', 'locked');
  ins('INSERT INTO club_cycle_boxes VALUES (?, ?, ?, ?)').run('box-test-soon', 's-test', '2026-11-05', 'awaiting_selection');
  ins('INSERT INTO club_cycle_boxes VALUES (?, ?, ?, ?)').run('box-real-soon', 's-real', '2026-11-06', 'locked');
  ins('INSERT INTO change_requests VALUES (?, ?)').run('cr-1', 'failed');
  const db: any = {
    prepare(sql: string) {
      let values: any[] = [];
      const statement = { bind(...v: any[]) { values = v; return statement; },
        async first() { return raw.query(sql).get(...values); },
        async all() { return { results: raw.query(sql).all(...values) }; },
        async run() { return raw.query(sql).run(...values); } };
      return statement;
    },
  };
  return db;
}

test('test orders and test boxes are not urgent; real and unidentified rows still are', async () => {
  const u = await getUrgency(makeDb(), NOW, TODAY);
  expect(u.agedOrderCount).toBe(1);
  expect(u.agedOrders.map(o => o.id)).toEqual(['ord-real']);
  expect(u.overdueBoxCount).toBe(2); // real signup + orphan box
  expect(u.overdueBoxes[0].shipDate).toBe('2026-10-30');
  expect(u.boxesDueSoon).toBe(1);
  expect(u.failedChanges).toBe(1); // page fixes have no account; unchanged
  expect(u.total).toBe(5);
});

test('the test list is CG\u2019s four addresses plus the retired fake buyer', () => {
  expect([...TEST_ORDER_EMAILS].sort()).toEqual([
    'babyfacecam@icloud.com',
    'camgstewart@icloud.com',
    'camstewart7@gmail.com',
    'cgstewart11@yahoo.com',
    'test.buyer@example.com',
  ]);
});

// POD mode (2026-11-09): with the print-on-demand lane on, urgency
// is exception-based. Orders and boxes the printer already holds
// stop aging on the home clocks; the failures of the autonomous
// flow (rejected jobs, jobs that never submitted, production
// running long) are what surface.
function makePodDb() {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE orders (id TEXT, email TEXT, status TEXT, physical_status TEXT, created_at INTEGER, source TEXT);
    CREATE TABLE club_signups (id TEXT, email TEXT);
    CREATE TABLE club_cycle_boxes (id TEXT, signup_id TEXT, ship_date TEXT, status TEXT);
    CREATE TABLE change_requests (id TEXT, status TEXT);
    CREATE TABLE print_jobs (id TEXT, order_id TEXT, club_box_id TEXT, status TEXT, lulu_status TEXT, last_error TEXT, created_at INTEGER, updated_at INTEGER);
  `);
  const ins = (sql: string) => raw.prepare(sql);
  const old = NOW - 6 * 86400;
  // A POD-covered aged order: old, but the printer has it.
  ins('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)').run('ord-pod', 'reader@example.com', 'complete', 'in_print', old, 'stripe');
  ins('INSERT INTO print_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('job-pod', 'ord-pod', null, 'submitted', 'IN_PRODUCTION', null, old, old);
  // A paid order a day old with no job at all: auto-placement missed it.
  ins('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)').run('ord-orphan', 'reader@example.com', 'complete', 'preorder_received', NOW - 2 * 86400, 'stripe');
  // A manual order: waiting on CG by design, informational only.
  ins('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)').run('ord-manual', 'reader@example.com', 'complete', 'preorder_received', old, 'manual');
  // A failed job, a stuck queued job, a long-production job.
  ins('INSERT INTO print_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('job-failed', 'ord-x', null, 'failed', 'REJECTED', 'REJECTED: interior rejected', NOW - 86400, NOW - 3600);
  ins('INSERT INTO print_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('job-stuck', 'ord-y', null, 'queued', null, 'cost lookup failed', NOW - 2 * 86400, NOW - 2 * 86400);
  ins('INSERT INTO print_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('job-long', 'ord-z', null, 'submitted', 'IN_PRODUCTION', null, NOW - 9 * 86400, NOW - 9 * 86400);
  // An overdue box the printer already holds, and one it does not.
  ins('INSERT INTO club_signups VALUES (?, ?)').run('s-real', 'reader@example.com');
  ins('INSERT INTO club_cycle_boxes VALUES (?, ?, ?, ?)').run('box-covered', 's-real', '2026-10-30', 'locked');
  ins('INSERT INTO print_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('job-box', null, 'box-covered', 'submitted', 'IN_PRODUCTION', null, old, old);
  ins('INSERT INTO club_cycle_boxes VALUES (?, ?, ?, ?)').run('box-bare', 's-real', '2026-10-29', 'locked');
  // Due soon: a locked box no longer counts under POD (it submits
  // itself); an unsettled one still does.
  ins('INSERT INTO club_cycle_boxes VALUES (?, ?, ?, ?)').run('box-soon-locked', 's-real', '2026-11-05', 'locked');
  ins('INSERT INTO club_cycle_boxes VALUES (?, ?, ?, ?)').run('box-soon-open', 's-real', '2026-11-05', 'awaiting_selection');
  const db: any = {
    prepare(sql: string) {
      let values: any[] = [];
      const statement = { bind(...v: any[]) { values = v; return statement; },
        async first() { return raw.query(sql).get(...values); },
        async all() { return { results: raw.query(sql).all(...values) }; },
        async run() { return raw.query(sql).run(...values); } };
      return statement;
    },
  };
  return db;
}

test('POD mode: covered work goes quiet, autonomous failures surface', async () => {
  const u = await getUrgency(makePodDb(), NOW, TODAY, { podActive: true });
  expect(u.podActive).toBe(true);
  expect(u.agedOrderCount).toBe(0); // ord-pod is covered; manual and orphan are younger than 3d at this clock
  expect(u.overdueBoxCount).toBe(1); // only box-bare
  expect(u.overdueBoxesInProduction).toBe(1); // box-covered, informational
  expect(u.boxesDueSoon).toBe(1); // only the unsettled box
  expect(u.failedPrintJobCount).toBe(1);
  expect(u.failedPrintJobs[0].lastError).toContain('REJECTED');
  expect(u.stuckPrintJobCount).toBe(1);
  expect(u.unsubmittedOrderCount).toBe(1); // ord-orphan
  expect(u.longProductionCount).toBe(1);
  expect(u.manualOrdersWaiting).toBe(1);
  expect(u.infoTotal).toBe(2);
  expect(u.total).toBe(6); // overdue 1 + dueSoon 1 + failed 1 + stuck 1 + unsubmitted 1 + longProduction 1
});

test('POD categories stay silent while the lane is off', async () => {
  const u = await getUrgency(makePodDb(), NOW, TODAY);
  expect(u.podActive).toBe(false);
  expect(u.stuckPrintJobCount).toBe(0);
  expect(u.unsubmittedOrderCount).toBe(0);
  expect(u.longProductionCount).toBe(0);
  expect(u.overdueBoxesInProduction).toBe(0);
  // Home semantics: the covered order and both overdue boxes age as before.
  expect(u.agedOrderCount).toBe(2); // ord-pod + ord-manual (source is not filtered at home)
  expect(u.overdueBoxCount).toBe(2);
  expect(u.boxesDueSoon).toBe(2); // locked counts again
});
