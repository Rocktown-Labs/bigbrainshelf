import { test, expect } from 'bun:test';
import { legacy } from './helpers/adoption-fixture';
import { planAdoption } from '../factory-ops/adoption';
import { fingerprintOf, isSnapshotArtifact } from '../factory/src/versioning';
import { bytesHash } from '../packages/core/src/assembly-identity';

/** CG approved a narrow text-only plan-edit exception for Penny
 * (2026-11-04): a plan-JSON-only edit may adjust the fingerprint
 * comparison for exactly the touched keys when its BEFORE bytes are
 * archived under the book and hash-verify. Everything else about the
 * strict fingerprint rule stays. */

const PLAN_KEY = 'books/test/plans/S1.json';
const ARCHIVE_KEY = 'books/test/archive/pre-edit/S1.json';

function editedBook(withException: boolean) {
  const f = legacy();
  const line = JSON.parse(f.evidence.line); for (const row of line.results) delete row.sha256;
  f.evidence.line = JSON.stringify(line); f.put('books/test/audit/cast-audit-line.json', f.evidence.line);
  f.bucket.list = async ({ prefix }: any) => ({ objects: [...f.values].filter(([key]) => key.startsWith(prefix)).map(([key, v]) => ({ key, size: v.bytes.length })), truncated: false });
  const beforeBytes = f.values.get(PLAN_KEY)!.bytes;
  f.put(ARCHIVE_KEY, new TextDecoder().decode(beforeBytes));
  const plan = JSON.parse(new TextDecoder().decode(beforeBytes));
  plan.pages[0].imagePrompt = `${plan.pages[0].imagePrompt ?? ''} Reviewed steering text appended by the operator.`;
  f.put(PLAN_KEY, plan);
  const items = [...f.values].filter(([key]) => isSnapshotArtifact('test', key)).map(([key, v]) => ({ key, size: v.bytes.length }));
  const baselineItems = items.map(i => i.key === PLAN_KEY ? { ...i, size: beforeBytes.length } : i);
  const version = { version: 1, at: 90, source: 'repair', fingerprint: fingerprintOf(baselineItems), files: items.length, bytes: baselineItems.reduce((a, v) => a + v.size, 0) };
  f.put('books/test/versions.json', { slug: 'test', versions: [version] });
  const log: any = { schema: 'adoption-continuity/v1', slug: 'test', auditAt: 100, coverageFrom: 100, coverageThrough: 200,
    counts: { production_events: 0, gen_attempts: 0 }, attestation: { by: 'RGM', complete: true, writeFreeze: true, freezeFrom: 200 },
    production_events: [], gen_attempts: [], classifications: [],
    exceptions: withException ? [{ kind: 'text-only-plan-edit', key: PLAN_KEY, beforeSha256: bytesHash(beforeBytes), beforeBytes: beforeBytes.length, archiveKey: ARCHIVE_KEY }] : [] };
  const evidence = () => ({ ...f.evidence, continuity: JSON.stringify(log) });
  return { ...f, log, evidence, beforeBytes };
}

test('a verified text-only plan edit exception satisfies the fingerprint rule for the touched key only', async () => {
  const f = editedBook(true);
  const report = await planAdoption(f.bucket, 'test', f.evidence());
  expect(report.continuity.ok).toBe(true);
  expect(report.continuity.textOnlyExceptions).toHaveLength(1);
  expect(report.pages.map(p => p.line.tier)).toEqual(['fingerprint-and-closed-log', 'fingerprint-and-closed-log']);
});

test('the same edit without the exception still fails the strict fingerprint rule', async () => {
  const f = editedBook(false);
  const report = await planAdoption(f.bucket, 'test', f.evidence());
  expect(report.continuity.ok).toBe(false);
  expect(report.pages.every(p => p.line.status === 'reported')).toBe(true);
});

test('an exception whose archived before bytes do not hash-match fails the whole proof', async () => {
  const f = editedBook(true);
  f.put(ARCHIVE_KEY, 'EDITED ARCHIVE');
  const report = await planAdoption(f.bucket, 'test', f.evidence());
  expect(report.continuity.ok).toBe(false);
  expect(report.continuity.reason).toContain('does not verify');
  expect(report.pages.every(p => p.line.status === 'reported')).toBe(true);
});

test('an exception naming a non-plan key fails the whole proof', async () => {
  const f = editedBook(true);
  f.log.exceptions[0].key = 'books/test/images/S1-page-0.jpg';
  const report = await planAdoption(f.bucket, 'test', f.evidence());
  expect(report.continuity.ok).toBe(false);
  expect(report.continuity.reason).toContain('does not verify');
});
