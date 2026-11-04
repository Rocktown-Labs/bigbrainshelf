import { test, expect } from 'bun:test';
import { legacy } from './helpers/adoption-fixture';
import { planAdoption, applyAdoption } from '../factory-ops/adoption';

/** The preserved judgment-run color audits carry no lineSha256. The
 * pairing supplement (adoption-color-pairing/v1) may fill that field
 * only as a hash-verified index over the captured artifacts. */

function unhashedColor() {
  const f = legacy();
  const color = JSON.parse(f.evidence.color);
  const supplement = {
    schema: 'adoption-color-pairing/v1', slug: 'test',
    rows: color.results.map((r: any) => ({
      page: r.page, key: r.key, colorSha256: r.sha256,
      lineKey: r.key.replace('/images-color/', '/images/'), lineSha256: r.lineSha256,
    })),
  };
  for (const row of color.results) delete row.lineSha256;
  f.evidence.color = JSON.stringify(color);
  f.put('books/test/audit/cast-audit-color.json', f.evidence.color);
  return { f, supplement };
}

test('color rows without a recorded pairing cannot stamp on audit evidence alone', async () => {
  const { f } = unhashedColor();
  const report = await planAdoption(f.bucket, 'test', f.evidence);
  expect(report.pages.every(p => p.line.status === 'eligible')).toBe(true);
  expect(report.pages.every(p => p.color.status === 'reported')).toBe(true);
});

test('a hash-verified pairing supplement completes the color binding', async () => {
  const { f, supplement } = unhashedColor();
  const report = await planAdoption(f.bucket, 'test', { ...f.evidence, colorPairing: JSON.stringify(supplement) });
  expect(report.pages.every(p => p.color.status === 'eligible')).toBe(true);
  expect((report.pages[0].color.evidence as any)?.colorPairing?.lineKey).toBe('books/test/images/S1-page-0.jpg');
});

test('a supplement entry that does not hash-match the captured twin cannot pair it', async () => {
  const { f, supplement } = unhashedColor();
  supplement.rows[0].colorSha256 = '0'.repeat(64);
  const report = await planAdoption(f.bucket, 'test', { ...f.evidence, colorPairing: JSON.stringify(supplement) });
  expect(report.pages[0].color.status).toBe('reported');
  expect(report.pages[1].color.status).toBe('eligible');
});

test('the supplement never overrides a pairing the audit itself recorded', async () => {
  const f = legacy();
  const color = JSON.parse(f.evidence.color);
  const supplement = {
    schema: 'adoption-color-pairing/v1', slug: 'test',
    rows: color.results.map((r: any) => ({
      page: r.page, key: r.key, colorSha256: r.sha256,
      lineKey: r.key.replace('/images-color/', '/images/'), lineSha256: r.lineSha256,
    })),
  };
  for (const row of color.results) row.lineSha256 = '0'.repeat(64);
  f.evidence.color = JSON.stringify(color);
  f.put('books/test/audit/cast-audit-color.json', f.evidence.color);
  const report = await planAdoption(f.bucket, 'test', { ...f.evidence, colorPairing: JSON.stringify(supplement) });
  expect(report.pages.every(p => p.color.status === 'reported')).toBe(true);
});

test('apply carries the pairing supplement into its fresh replan', async () => {
  // Regression (2026-11-04, Mira's live apply): applyAdoption rebuilt
  // its freshness-check evidence from the report sources but dropped
  // colorPairing, so the replan reported every supplement-paired page
  // and the fingerprint never matched. The apply must replay the
  // exact evidence the reviewed dry-run used.
  const { f, supplement } = unhashedColor();
  const report = await planAdoption(f.bucket, 'test', { ...f.evidence, colorPairing: JSON.stringify(supplement) });
  expect(report.canApply).toBe(true);
  await applyAdoption(f.bucket, report, report.fingerprint, f.log);
  expect(f.writes).toEqual(['books/test/plans/S1.json']);
  const plan = JSON.parse(new TextDecoder().decode(f.values.get('books/test/plans/S1.json')!.bytes));
  expect(plan.pages[0].colorIdentity).toBeDefined();
});

test('a malformed supplement is an evidence error, not a silent pass', async () => {
  const { f } = unhashedColor();
  const report = await planAdoption(f.bucket, 'test', { ...f.evidence, colorPairing: '{"schema":"nope","slug":"test","rows":[]}' });
  expect(report.errors).toContain('Invalid color pairing supplement');
  expect(report.canApply).toBe(false);
});
