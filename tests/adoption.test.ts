import { test, expect } from 'bun:test';
import { fixture } from './helpers/identity-fixture';
import { bytesHash } from '../packages/core/src/assembly-identity';
import { planAdoption, applyAdoption } from '../factory-ops/adoption';

import { legacy } from './helpers/adoption-fixture';

test('dry-run derives identity from current bytes only when historical hashes match, and writes nothing', async () => {
  const f = legacy(); const report = await planAdoption(f.bucket, 'test', f.evidence);
  expect(report.pages.every(p => p.line.status === 'eligible' && p.color.status === 'eligible')).toBe(true);
  expect(report.patches).toHaveLength(1); expect(f.writes).toHaveLength(0);
  expect(f.plan.pages[0].lineIdentity).toBeUndefined();
});

test.each(['unhashed', 'changed', 'wrong-pair', 'remote-mismatch'])('%s evidence cannot stamp artifacts', async fault => {
  const f = legacy();
  if (fault === 'unhashed') { const x = JSON.parse(f.evidence.line); for (const row of x.results) delete row.sha256; f.evidence.line = JSON.stringify(x); f.put('books/test/audit/cast-audit-line.json', f.evidence.line); }
  if (fault === 'changed') f.put('books/test/images/S1-page-0.jpg', 'EDIT');
  if (fault === 'wrong-pair') { const x = JSON.parse(f.evidence.color); for (const row of x.results) row.lineSha256 = '0'.repeat(64); f.evidence.color = JSON.stringify(x); f.put('books/test/audit/cast-audit-color.json', f.evidence.color); }
  if (fault === 'remote-mismatch') f.put('books/test/audit/cast-audit-line.json', '{}');
  const report = await planAdoption(f.bucket, 'test', f.evidence);
  expect(report.pages.some(p => p.line.status !== 'eligible' || p.color.status !== 'eligible')).toBe(true);
  expect(f.writes).toHaveLength(0);
});

test('apply requires the reviewed dry-run fingerprint, preserves held flags and touches only plan identities', async () => {
  const f = legacy(); f.plan.finale.colorHeld = true; f.plan.finale.colorHeldReason = 'Known defect'; f.save();
  const before = new Map([...f.values].map(([k, v]) => [k, bytesHash(v.bytes)]));
  const report = await planAdoption(f.bucket, 'test', f.evidence);
  await expect(applyAdoption(f.bucket, report, 'wrong', f.log)).rejects.toThrow();
  await applyAdoption(f.bucket, report, report.fingerprint, f.log);
  const plan = JSON.parse(new TextDecoder().decode(f.values.get('books/test/plans/S1.json')!.bytes));
  expect(plan.finale.colorHeld).toBe(true); expect(plan.finale.colorHeldReason).toBe('Known defect');
  expect(f.writes).toEqual(['books/test/plans/S1.json']);
  for (const [key, digest] of before) if (!key.includes('/plans/')) expect(bytesHash(f.values.get(key)!.bytes)).toBe(digest);
  expect(f.journal.some(r => r.event === 'intent' && r.originalPlans)).toBe(true);
});

test('a changed image or plan after review prevents application', async () => {
  for (const key of ['books/test/images/S1-page-0.jpg', 'books/test/plans/S1.json']) {
    const f = legacy(); const report = await planAdoption(f.bucket, 'test', f.evidence);
    f.put(key, key.endsWith('.json') ? { ...f.plan, storyTitle: 'changed' } : 'EDIT');
    await expect(applyAdoption(f.bucket, report, report.fingerprint, f.log)).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
  }
});

test('failed journal durability or a conditional write rejection cannot report completion', async () => {
  const f = legacy(); const report = await planAdoption(f.bucket, 'test', f.evidence);
  await expect(applyAdoption(f.bucket, report, report.fingerprint, async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
  expect(f.writes).toHaveLength(0);
  f.bucket.put = async () => null;
  await expect(applyAdoption(f.bucket, report, report.fingerprint, f.log)).rejects.toThrow('conditional');
  expect(f.journal.some(row => row.event === 'failed-or-unconfirmed')).toBe(true);
  expect(f.journal.some(row => row.event === 'completed')).toBe(false);
});

test('Tilda is always report-only and cannot be adopted through the library', async () => {
  const f = legacy();
  await expect(planAdoption(f.bucket, 'iwillteach', f.evidence)).rejects.toThrow('Tilda');
});

test('partial color evidence adopts supported line pages without blessing an unbound twin', async () => {
  const f = legacy(); const color = JSON.parse(f.evidence.color); color.results[1].lineSha256 = '0'.repeat(64);
  f.evidence.color = JSON.stringify(color); f.put('books/test/audit/cast-audit-color.json', f.evidence.color);
  const report = await planAdoption(f.bucket, 'test', f.evidence);
  expect(report.pages.every(p => p.line.status === 'eligible')).toBe(true);
  expect(report.pages.filter(p => p.color.status === 'eligible')).toHaveLength(1);
  await applyAdoption(f.bucket, report, report.fingerprint, f.log);
  const { prepareAssembly } = await import('../packages/core/src/assembly-identity');
  expect((await prepareAssembly(f.bucket, 'test', 'line')).entries).toHaveLength(2);
  await expect(prepareAssembly(f.bucket, 'test', 'color')).rejects.toThrow('color');
});

test('a saved JSON dry-run report remains reviewable and applicable after round trip', async () => {
  const f = legacy(); const report = JSON.parse(JSON.stringify(await planAdoption(f.bucket, 'test', f.evidence)));
  await applyAdoption(f.bucket, report, report.fingerprint, f.log);
  expect(f.journal.at(-1).event).toBe('completed');
  expect(f.journal[0].originalPlans[0].base64).toBe(Buffer.from(f.journal[0].originalPlans[0].body).toString('base64'));
});
