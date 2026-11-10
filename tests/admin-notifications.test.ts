// Admin notifications tests (orders admin redo, 2026-11-10): the
// inbox is the PR #76 digest's urgency sets at row level. Same
// rules, row identities, and the awareness split (at the printer
// vs on us); read state persists keyed by notification identity.
import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  buildAdminNotifications,
  getNotificationReadIds,
  markNotificationRead,
  markAllNotificationsRead,
} from '../src/lib/admin-notifications';

const NOW = Math.floor(Date.parse('2026-11-10T12:00:00Z') / 1000);
const TODAY = '2026-11-10';
const DAY = 86400;

function makeDb() {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE orders (id TEXT, email TEXT, status TEXT, physical_status TEXT, amount INTEGER, created_at INTEGER, source TEXT);
    CREATE TABLE print_jobs (id TEXT, order_id TEXT, club_box_id TEXT, status TEXT, lulu_status TEXT, last_error TEXT, created_at INTEGER);
    CREATE TABLE club_signups (id TEXT, email TEXT);
    CREATE TABLE club_cycle_boxes (id TEXT, signup_id TEXT, ship_date TEXT, status TEXT);
    CREATE TABLE change_requests (id TEXT, status TEXT);
    CREATE TABLE email_outbox (id TEXT, status TEXT, created_at INTEGER);
  `);
  const ins = (sql: string) => raw.prepare(sql);
  // A rejected job and an errored job on two real orders.
  ins('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?)').run('ord-rej', 'reader@example.com', 'complete', 'preorder_received', 2499, NOW - 2 * DAY, null);
  ins('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?)').run('ord-err', 'reader@example.com', 'complete', 'preorder_received', 1299, NOW - 2 * DAY, null);
  ins('INSERT INTO print_jobs VALUES (?, ?, ?, ?, ?, ?, ?)').run('job-rej', 'ord-rej', null, 'failed', 'REJECTED', 'bad pdf', NOW - 2 * DAY);
  ins('INSERT INTO print_jobs VALUES (?, ?, ?, ?, ?, ?, ?)').run('job-err', 'ord-err', null, 'failed', 'ERROR', 'boom', NOW - 2 * DAY);
  // A paid order with no job (POD sets only) and a manual order.
  ins('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?)').run('ord-nojob', 'reader@example.com', 'complete', 'preorder_received', 2499, NOW - 2 * DAY, null);
  ins('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?)').run('ord-manual', 'reader@example.com', 'complete', 'preorder_received', 3500, NOW - DAY, 'manual');
  // A test order that must never notify.
  ins('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?)').run('ord-test', 'camstewart7@gmail.com', 'complete', 'preorder_received', 100, NOW - 9 * DAY, null);
  // Boxes: one overdue at the printer, one overdue on us.
  ins('INSERT INTO club_signups VALUES (?, ?)').run('s1', 'member@example.com');
  ins('INSERT INTO club_cycle_boxes VALUES (?, ?, ?, ?)').run('box-printer', 's1', '2026-11-05', 'preparing');
  ins('INSERT INTO club_cycle_boxes VALUES (?, ?, ?, ?)').run('box-home', 's1', '2026-11-04', 'locked');
  ins('INSERT INTO print_jobs VALUES (?, ?, ?, ?, ?, ?, ?)').run('job-box', null, 'box-printer', 'submitted', 'IN_PRODUCTION', null, NOW - 6 * DAY);
  ins('INSERT INTO change_requests VALUES (?, ?)').run('cr-1', 'failed');
  ins('INSERT INTO email_outbox VALUES (?, ?, ?)').run('em-1', 'failed', NOW - DAY);
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

test('rejected and errored jobs are distinct action items in Print jobs', async () => {
  const items = await buildAdminNotifications(makeDb(), NOW, TODAY, { podActive: false });
  const rej = items.find((n) => n.id === 'print_job_failed:job-rej');
  const err = items.find((n) => n.id === 'print_job_failed:job-err');
  expect(rej?.title).toBe('Print job rejected by Lulu');
  expect(err?.title).toBe('Print job errored at Lulu');
  expect(rej?.category).toBe('print_jobs');
  expect(rej?.severity).toBe('action');
  expect(rej?.amountCents).toBe(2499);
  expect(rej?.href).toBe('/admin/orders/ord-rej');
});

test('POD-only sets stay silent while the lane is off, and fire when it is on', async () => {
  const off = await buildAdminNotifications(makeDb(), NOW, TODAY, { podActive: false });
  expect(off.some((n) => n.id === 'order_no_job:ord-nojob')).toBe(false);
  const on = await buildAdminNotifications(makeDb(), NOW, TODAY, { podActive: true });
  const noJob = on.find((n) => n.id === 'order_no_job:ord-nojob');
  expect(noJob?.severity).toBe('action');
  expect(noJob?.action).toBe('create_job');
});

test('awareness split: overdue box at the printer is awareness, on us is action; manual orders are awareness', async () => {
  const items = await buildAdminNotifications(makeDb(), NOW, TODAY, { podActive: false });
  expect(items.find((n) => n.id === 'box_overdue:box-printer')?.severity).toBe('awareness');
  expect(items.find((n) => n.id === 'box_overdue:box-home')?.severity).toBe('action');
  const manual = items.find((n) => n.id === 'order_manual:ord-manual');
  expect(manual?.severity).toBe('awareness');
  expect(manual?.category).toBe('orders');
});

test('test orders never notify; email & files items ride along', async () => {
  const items = await buildAdminNotifications(makeDb(), NOW, TODAY, { podActive: true });
  expect(items.some((n) => n.entityId === 'ord-test')).toBe(false);
  expect(items.some((n) => n.id === 'order_no_job:ord-test')).toBe(false);
  expect(items.find((n) => n.id === 'changes_failed')?.category).toBe('email_files');
  expect(items.find((n) => n.id === 'outbox_failed')?.action).toBe('retry_emails');
  // Action items sort before awareness items.
  const firstAwareness = items.findIndex((n) => n.severity === 'awareness');
  expect(items.slice(0, firstAwareness).every((n) => n.severity === 'action')).toBe(true);
});

test('read state persists by notification identity', async () => {
  const db = makeDb();
  expect((await getNotificationReadIds(db)).size).toBe(0);
  await markNotificationRead(db, 'print_job_failed:job-rej', 'cg@example.com');
  await markAllNotificationsRead(db, ['outbox_failed'], 'cg@example.com');
  const ids = await getNotificationReadIds(db);
  expect(ids.has('print_job_failed:job-rej')).toBe(true);
  expect(ids.has('outbox_failed')).toBe(true);
  expect(ids.has('box_overdue:box-home')).toBe(false);
});
