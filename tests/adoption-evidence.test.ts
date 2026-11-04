import { test, expect } from 'bun:test';
import { legacy } from './helpers/adoption-fixture';
import { planAdoption } from '../factory-ops/adoption';
import { editionBindings } from '../factory-ops/adoption-evidence';
import { fingerprintOf } from '../src/lib/takes';
import { isSnapshotArtifact } from '../factory/src/versioning';
import { bytesHash } from '../packages/core/src/assembly-identity';
import { revisionHash } from '../packages/core/src/book-revision';

function continuity() {
  const f = legacy();
  const line = JSON.parse(f.evidence.line); for (const row of line.results) delete row.sha256;
  f.evidence.line = JSON.stringify(line); f.put('books/test/audit/cast-audit-line.json', f.evidence.line);
  f.bucket.list = async ({ prefix }: any) => ({ objects: [...f.values].filter(([key]) => key.startsWith(prefix)).map(([key, v]) => ({ key, size: v.bytes.length })), truncated: false });
  const items = [...f.values].filter(([key]) => isSnapshotArtifact('test', key)).map(([key, v]) => ({ key, size: v.bytes.length }));
  const version = { version: 1, at: 90, source: 'repair', fingerprint: fingerprintOf(items), files: items.length, bytes: items.reduce((a, v) => a + v.size, 0) };
  f.put('books/test/versions.json', { slug: 'test', versions: [version] });
  const log: any = { schema: 'adoption-continuity/v1', slug: 'test', auditAt: 100, coverageFrom: 100, coverageThrough: 200,
    counts: { production_events: 0, gen_attempts: 0 }, attestation: { by: 'RGM', complete: true, writeFreeze: true, freezeFrom: 200 },
    production_events: [], gen_attempts: [], classifications: [] };
  const evidence = () => ({ ...f.evidence, continuity: JSON.stringify(log) });
  return { ...f, log, evidence };
}

test('unhashed historical ledgers can bind through the approved fingerprint/closed-log tier', async () => {
  const f = continuity(); const report = await planAdoption(f.bucket, 'test', f.evidence());
  expect(report.pages.map(p => p.line.tier)).toEqual(['fingerprint-and-closed-log', 'fingerprint-and-closed-log']);
  expect(report.continuity.baseline.version).toBe(1); expect(report.patches).toHaveLength(1);
});

test.each(['fingerprint', 'coverage', 'unclassified', 'unknown-write', 'truncated-export'])('%s cannot satisfy continuity', async fault => {
  const f = continuity();
  if (fault === 'fingerprint') f.put('books/test/images/S1-page-0.jpg', 'LONGER');
  if (fault === 'coverage') f.log.coverageFrom = 101;
  if (['unclassified', 'unknown-write', 'truncated-export'].includes(fault)) {
    const row = { id: 1, slug: 'test', kind: 'pagefix', created_at: 110 };
    f.log.production_events.push(row); f.log.counts.production_events = 1;
    if (fault === 'unknown-write') f.log.classifications.push({ ref: 'production_events:1', rowHash: revisionHash(row), kind: 'image-write', keys: ['books/test/images/S1-page-0.jpg'] });
    if (fault === 'truncated-export') { f.log.production_events = []; f.log.classifications = []; }
  }
  const report = await planAdoption(f.bucket, 'test', f.evidence());
  expect(report.pages.every(p => p.line.status === 'reported')).toBe(true);
});

test('edition proof validates raw manifest hashes and the full parent chain against D1 rows', async () => {
  const f = legacy();
  const manifest = { slug: 'test', edition: 'line', created_at: 1, parent_hash: null,
    artifacts: [{ key: 'books/test/images/S1-page-0.jpg', bytes: 4, sha256: bytesHash(new TextEncoder().encode('LINE')) }] };
  const raw = JSON.stringify(manifest); const key = 'books/test/editions/line-1.json'; f.put(key, raw);
  const evidence = { schema: 'adoption-editions/v1', slug: 'test', auditAt: 2, rows: [{ id: 1, slug: 'test', edition: 'line', created_at: 1, parent_hash: null, manifest_key: key, hash: bytesHash(new TextEncoder().encode(raw)) }] };
  expect((await editionBindings(f.bucket, 'test', JSON.stringify(evidence))).bindings.size).toBe(1);
  f.put(key, raw + ' ');
  expect((await editionBindings(f.bucket, 'test', JSON.stringify(evidence))).error).toContain('chain/hash');
});

test('the named Mira exception needs archived accepted bytes and a post-fix QC replay', async () => {
  const f = legacy(); const key = 'books/mastery/images/S1-page-0.jpg';
  const archiveKey = 'books/mastery/attempts/pagefix/fix.png'; const qcKey = 'books/mastery/audit/postfix-qc.json';
  const attempt = { id: 7, slug: 'mastery', image_key: archiveKey, created_at: 110, outcome: 'accepted' };
  f.put(archiveKey, 'LINE'); f.put(qcKey, { measured_at: 120, results: [{ key, scores: { anatomy: 0.4 } }] });
  const log = { coverageThrough: 200, gen_attempts: [attempt], classifications: [{ ref: 'gen_attempts:7', rowHash: revisionHash(attempt), kind: 'image-write', keys: [key] }],
    exceptions: [{ kind: 'mira-drift-fix', key, ref: 'gen_attempts:7', qcKey }] };
  const { driftFixBinding } = await import('../factory-ops/adoption-evidence');
  expect((await driftFixBinding(f.bucket, 'mastery', key, bytesHash(new TextEncoder().encode('LINE')), { logOk: true, log }))?.tier).toBe('enumerated-drift-fix');
  f.put(archiveKey, 'EDIT');
  expect(await driftFixBinding(f.bucket, 'mastery', key, bytesHash(new TextEncoder().encode('LINE')), { logOk: true, log })).toBeNull();
});
