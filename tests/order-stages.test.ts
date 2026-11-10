// Order stage derivation tests (orders admin redo, prototype v3,
// 2026-11-10): per-line stages come from the rows of record, the
// headline is a roll-up, POD stage names are honest about Lulu's
// vocabulary, and home-flow orders are never dressed as Lulu stages.
import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  orderKindOf,
  digitalStage,
  homeStage,
  podStageForJob,
  stageForGroup,
  headlineStage,
  matchesSavedFilter,
  homePackLaneEnabled,
  getOrderPipeline,
  type StageJobInput,
} from '../src/lib/order-stages';

const NOW = Math.floor(Date.parse('2026-11-10T12:00:00Z') / 1000);
const complete = { status: 'complete', physicalStatus: 'preorder_received', createdAt: NOW - 3600, source: null as string | null };

function job(partial: Partial<StageJobInput>): StageJobInput {
  return {
    id: 'job-1', status: 'submitted', luluStatus: 'IN_PRODUCTION', hasPartial: false,
    createdAt: NOW - 7200,
    items: [{ slug: 'mira', kind: 'story', status: 'IN_PRODUCTION' }],
    ...partial,
  };
}

test('digital lines deliver at payment; pending waits', () => {
  expect(digitalStage(complete).key).toBe('delivered');
  expect(digitalStage({ ...complete, status: 'pending' }).key).toBe('awaiting_payment');
  expect(stageForGroup({ format: 'digital', slug: 'mira' }, complete, []).label).toBe('Delivered');
});

test('order kind: club period wins, then physical, else digital', () => {
  expect(orderKindOf([{ format: 'digital' }, { format: 'quarterly' }])).toBe('club');
  expect(orderKindOf([{ format: 'digital' }, { format: 'printed' }])).toBe('pod');
  expect(orderKindOf([{ format: 'giftset' }])).toBe('pod');
  expect(orderKindOf([{ format: 'digital' }, { format: 'audio' }])).toBe('digital');
});

test('POD cancel window: PRODUCTION_DELAYED reads "Sent to Lulu, cancel window open"', () => {
  const s = podStageForJob(job({ luluStatus: 'PRODUCTION_DELAYED' }));
  expect(s.label).toBe('Sent to Lulu, cancel window open');
  expect(s.key).toBe('sent_to_lulu');
  expect(s.stepIndex).toBe(2);
  expect(s.steps).toEqual(['Paid', 'Job created', 'Sent to Lulu', 'In production', 'Shipped', 'Delivered']);
});

test('rejected is a different stage from error, and both differ from a plain failure', () => {
  const rejected = podStageForJob(job({ status: 'failed', luluStatus: 'REJECTED' }));
  const errored = podStageForJob(job({ status: 'failed', luluStatus: 'ERROR' }));
  const plain = podStageForJob(job({ status: 'failed', luluStatus: null }));
  expect(rejected.key).toBe('rejected');
  expect(rejected.label).toBe('Rejected by Lulu');
  expect(errored.key).toBe('lulu_error');
  expect(errored.label).toBe('Lulu error');
  expect(plain.key).toBe('job_failed');
  expect(new Set([rejected.key, errored.key, plain.key]).size).toBe(3);
  expect(rejected.tone).toBe('exception');
});

test('missing print file is its own exception stage', () => {
  const s = podStageForJob(job({ status: 'blocked_no_printable', luluStatus: null }));
  expect(s.key).toBe('missing_print_file');
  expect(s.tone).toBe('exception');
});

test('partial shipment surfaces; a fully delivered group settles delivered', () => {
  const partial = podStageForJob(job({ luluStatus: 'SHIPPED', hasPartial: true }));
  expect(partial.key).toBe('part_shipped');
  const whole = podStageForJob(job({ luluStatus: 'SHIPPED', hasPartial: false }));
  expect(whole.key).toBe('shipped');
  // The job still travels for a sibling item, but this group's own
  // items all read DELIVERED, so the line is delivered.
  const settled = stageForGroup(
    { format: 'printed', slug: 'mira' }, complete,
    [job({ luluStatus: 'SHIPPED', hasPartial: true, items: [{ slug: 'mira', kind: 'story', status: 'DELIVERED' }, { slug: 'penny', kind: 'story', status: 'SHIPPED' }] })]
  );
  expect(settled.key).toBe('delivered');
});

test('a printed line with a job rides the job; without one it rides the home flow', () => {
  const withJob = stageForGroup({ format: 'printed', slug: 'mira' }, complete, [job({})]);
  expect(withJob.key).toBe('in_production');
  const home = stageForGroup({ format: 'printed', slug: 'mira' }, complete, []);
  expect(home.key).toBe('home_preorder_received');
  expect(home.label).toBe('Received, to print at home');
  expect(home.steps).toContain('Packed');
  const packed = homeStage({ ...complete, physicalStatus: 'packed' });
  expect(packed.label).toBe('Packed, ready to ship');
  expect(packed.bucket).toBe('home');
});

test('headline roll-up: exception speaks first, then the least-advanced open line, then delivered', () => {
  const delivered = digitalStage(complete);
  const inProd = podStageForJob(job({}));
  const rejected = podStageForJob(job({ status: 'failed', luluStatus: 'REJECTED' }));
  expect(headlineStage([delivered, inProd]).key).toBe('in_production');
  expect(headlineStage([delivered, inProd, rejected]).key).toBe('rejected');
  expect(headlineStage([delivered, delivered]).key).toBe('delivered');
  expect(headlineStage([]).key).toBe('empty');
});

test('saved filters: manual waiting, stuck queue, needs action', () => {
  const ctx = { nowSec: NOW, podActive: false, hasJob: false, oldestJobAgeSec: null as number | null };
  const manualOrder = { ...complete, source: 'manual', createdAt: NOW - 90000 };
  const homeOpen = homeStage(manualOrder);
  expect(matchesSavedFilter('manual_waiting', manualOrder, homeOpen, ctx)).toBe(true);
  expect(matchesSavedFilter('manual_waiting', complete, homeStage(complete), ctx)).toBe(false);
  // Stuck: a queued job older than a day.
  const queued = podStageForJob(job({ status: 'queued', luluStatus: null, createdAt: NOW - 2 * 86400 }));
  expect(matchesSavedFilter('stuck', complete, queued, { ...ctx, hasJob: true, oldestJobAgeSec: 2 * 86400 })).toBe(true);
  expect(matchesSavedFilter('stuck', complete, queued, { ...ctx, hasJob: true, oldestJobAgeSec: 3600 })).toBe(false);
  // Needs action: any exception headline.
  const rejected = podStageForJob(job({ status: 'failed', luluStatus: 'REJECTED' }));
  expect(matchesSavedFilter('needs_action', complete, rejected, ctx)).toBe(true);
  expect(matchesSavedFilter('needs_action', complete, homeStage(complete), ctx)).toBe(false);
  // POD lane on: a paid order with no job after a day needs action.
  const oldPaid = { ...complete, createdAt: NOW - 2 * 86400 };
  expect(matchesSavedFilter('needs_action', oldPaid, homeStage(oldPaid), { ...ctx, podActive: true })).toBe(true);
});

test('club box Lane B flag: default off, on only for 1/true', () => {
  expect(homePackLaneEnabled({})).toBe(false);
  expect(homePackLaneEnabled({ CLUB_HOME_PACK_LANE: '0' })).toBe(false);
  expect(homePackLaneEnabled({ CLUB_HOME_PACK_LANE: '1' })).toBe(true);
  expect(homePackLaneEnabled({ CLUB_HOME_PACK_LANE: 'true' })).toBe(true);
  expect(homePackLaneEnabled(null)).toBe(false);
});

test('pipeline counts by stage x kind from the tables of record', async () => {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE orders (id TEXT, status TEXT, physical_status TEXT);
    CREATE TABLE print_jobs (id TEXT, order_id TEXT, club_box_id TEXT, status TEXT, lulu_status TEXT);
    CREATE TABLE club_cycle_boxes (id TEXT, status TEXT, ship_date TEXT);
  `);
  raw.prepare('INSERT INTO orders VALUES (?, ?, ?)').run('o1', 'complete', null);
  raw.prepare('INSERT INTO orders VALUES (?, ?, ?)').run('o2', 'complete', 'preorder_received');
  raw.prepare('INSERT INTO orders VALUES (?, ?, ?)').run('o3', 'pending', null);
  raw.prepare('INSERT INTO print_jobs VALUES (?, ?, ?, ?, ?)').run('j1', 'o9', null, 'submitted', 'PRODUCTION_DELAYED');
  raw.prepare('INSERT INTO print_jobs VALUES (?, ?, ?, ?, ?)').run('j2', 'o9', null, 'failed', 'REJECTED');
  raw.prepare('INSERT INTO print_jobs VALUES (?, ?, ?, ?, ?)').run('j3', null, 'b1', 'queued', null);
  raw.prepare('INSERT INTO club_cycle_boxes VALUES (?, ?, ?)').run('b1', 'locked', '2999-01-01');
  raw.prepare('INSERT INTO club_cycle_boxes VALUES (?, ?, ?)').run('b2', 'preparing', '2000-01-01');
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
  const p = await getOrderPipeline(db);
  expect(p.digital.delivered).toBe(1);
  expect(p.digital.awaitingPayment).toBe(1);
  expect(p.home.find((r) => r.key === 'preorder_received')?.count).toBe(1);
  expect(p.pod.find((r) => r.key === 'sent_to_lulu')?.count).toBe(1);
  expect(p.pod.find((r) => r.key === 'job_queued')?.count).toBe(1);
  expect(p.exceptions).toBe(1);
  expect(p.club.find((r) => r.key === 'preparing')?.count).toBe(2);
  expect(p.club.find((r) => r.key === 'past_due')?.count).toBe(1);
});
