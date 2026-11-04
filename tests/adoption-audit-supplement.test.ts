import { test, expect } from 'bun:test';
import { legacy } from './helpers/adoption-fixture';
import { bytesHash } from '../packages/core/src/assembly-identity';
import { planAdoption, applyAdoption } from '../factory-ops/adoption';

/** The audit supplement (adoption-audit-supplement/v1) covers books
 * whose judgment inventory was built from a partial key set (Wells:
 * keyed on plan imageKey). It may restate the four inventory count
 * fields and supply audit rows for pages the audit never recorded,
 * but only as a byte-verified resident of the book's audit prefix:
 * counts must equal the plan-derived counts exactly, and a row
 * naming a page the audit DID record is an error, never an
 * override. */

const COUNTS = { planned_pages: 2, planned_story_pages: 1, chapters_found: ['S1'], line_images: 2 };

function withSupplement(f: any, sup: object) {
  const raw = JSON.stringify(sup);
  f.put('books/test/audit/audit-supplement.json', raw);
  return { ...f.evidence, auditSupplement: raw };
}

function corruptCounts(f: any) {
  const inv = JSON.parse(f.evidence.inventory);
  inv.planned_pages = 99;
  inv.line_images = 99;
  f.evidence.inventory = JSON.stringify(inv);
  f.put('books/test/audit/inventory.json', f.evidence.inventory);
}

test('a partial-key inventory blocks adoption without a supplement', async () => {
  const f = legacy();
  corruptCounts(f);
  const report = await planAdoption(f.bucket, 'test', f.evidence);
  expect(report.errors).toContain('Current inventory/counts do not match judgment-run evidence');
  expect(report.canApply).toBe(false);
});

test('a supplement restating the derived counts exactly unblocks the plan', async () => {
  const f = legacy();
  corruptCounts(f);
  const evidence = withSupplement(f, { schema: 'adoption-audit-supplement/v1', slug: 'test', counts: COUNTS });
  const report = await planAdoption(f.bucket, 'test', evidence);
  expect(report.errors).toEqual([]);
  expect(report.canApply).toBe(true);
  expect((report as any).auditSupplement?.countsCorrected).toBe(true);
  expect(report.pages.every(p => p.line.status === 'eligible')).toBe(true);
});

test('supplement counts that do not equal the derived counts change nothing', async () => {
  const f = legacy();
  corruptCounts(f);
  const evidence = withSupplement(f, { schema: 'adoption-audit-supplement/v1', slug: 'test', counts: { ...COUNTS, planned_pages: 3 } });
  const report = await planAdoption(f.bucket, 'test', evidence);
  expect(report.errors).toContain('Current inventory/counts do not match judgment-run evidence');
  expect(report.canApply).toBe(false);
});

test('a supplement row fills a page the audit never recorded', async () => {
  const f = legacy();
  const line = JSON.parse(f.evidence.line);
  line.results = line.results.filter((r: any) => r.page !== 'S1 finale');
  f.evidence.line = JSON.stringify(line);
  f.put('books/test/audit/cast-audit-line.json', f.evidence.line);
  const missing = await planAdoption(f.bucket, 'test', f.evidence);
  expect(missing.pages[1].line.status).toBe('reported');
  const row = { page: 'S1 finale', key: 'books/test/images/S1-finale.jpg', sha256: bytesHash(new TextEncoder().encode('LINE')), bytes: 4 };
  const evidence = withSupplement(f, { schema: 'adoption-audit-supplement/v1', slug: 'test', lineRows: [row] });
  const report = await planAdoption(f.bucket, 'test', evidence);
  expect(report.pages[1].line.status).toBe('eligible');
  expect((report.pages[1].line.evidence as any)?.auditSupplement).toBe('adoption-audit-supplement/v1');
});

test('a supplement row naming a recorded page is an evidence error', async () => {
  const f = legacy();
  const row = { page: 'S1p0', key: 'books/test/images/S1-page-0.jpg', sha256: bytesHash(new TextEncoder().encode('LINE')), bytes: 4 };
  const evidence = withSupplement(f, { schema: 'adoption-audit-supplement/v1', slug: 'test', lineRows: [row] });
  const report = await planAdoption(f.bucket, 'test', evidence);
  expect(report.errors.some(e => e.startsWith('Audit supplement overrides recorded evidence'))).toBe(true);
  expect(report.canApply).toBe(false);
});

test('a supplement that does not byte-match its R2 object is invalid', async () => {
  const f = legacy();
  corruptCounts(f);
  const raw = JSON.stringify({ schema: 'adoption-audit-supplement/v1', slug: 'test', counts: COUNTS });
  f.put('books/test/audit/audit-supplement.json', '{"tampered":true}');
  const report = await planAdoption(f.bucket, 'test', { ...f.evidence, auditSupplement: raw });
  expect(report.errors).toContain('Invalid audit supplement');
  expect(report.canApply).toBe(false);
});

test('a malformed supplement is an evidence error, not a silent pass', async () => {
  const f = legacy();
  const evidence = withSupplement(f, { schema: 'nope', slug: 'test', counts: COUNTS });
  const report = await planAdoption(f.bucket, 'test', evidence);
  expect(report.errors).toContain('Invalid audit supplement');
  expect(report.canApply).toBe(false);
});

test('apply carries the audit supplement into its fresh replan', async () => {
  const f = legacy();
  corruptCounts(f);
  const evidence = withSupplement(f, { schema: 'adoption-audit-supplement/v1', slug: 'test', counts: COUNTS });
  const report = await planAdoption(f.bucket, 'test', evidence);
  expect(report.canApply).toBe(true);
  await applyAdoption(f.bucket, report, report.fingerprint, f.log);
  expect(f.writes).toEqual(['books/test/plans/S1.json']);
});
