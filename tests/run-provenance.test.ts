import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { recordWorkerRun, recordWorkflowRun } from '../packages/core/src/run-provenance';

const binding = JSON.stringify({ schema: 'worker-build/v1', worker: 'kidsbook-factory',
  sourceSha: 'a'.repeat(40), buildDigest: 'b'.repeat(64), deploymentId: 'deployment-one' });
function fixture() {
  const raw = new Database(':memory:');
  raw.exec(readFileSync(new URL('../db/migrations/0001_release_and_run_provenance.sql', import.meta.url), 'utf8'));
  const env = { BBS_BUILD_PROVENANCE: binding, DB: { prepare(sql: string) {
    return { bind(...args: any[]) { return { async run() { return raw.query(sql).run(...args); } }; } };
  } } };
  return { raw, env };
}
test('run provenance retains source, artifact digest and stable workflow identity', async () => {
  const { raw, env } = fixture();
  await recordWorkerRun(env, { worker: 'kidsbook-factory', runId: 'run-one', operation: 'bookbuild', bookSlug: 'test', startedAt: 123 });
  const row: any = raw.query('SELECT * FROM worker_runs').get();
  expect(row).toMatchObject({ run_id: 'run-one', source_sha: 'a'.repeat(40), build_digest: 'b'.repeat(64), deployment_id: 'deployment-one', started_at: 123 });
});
test('workflow replay is idempotent and later deployments append an observation', async () => {
  const { raw, env } = fixture();
  const completed = new Map();
  const step = { async do(name: string, callback: () => Promise<unknown>) {
    if (!completed.has(name)) completed.set(name, await callback());
    return completed.get(name);
  } };
  const event = { instanceId: 'run-one', timestamp: new Date(123) };
  await recordWorkflowRun(env, step, event, 'bookbuild', 'test');
  await recordWorkflowRun(env, step, event, 'bookbuild', 'test');
  expect(raw.query('SELECT * FROM worker_runs').all()).toHaveLength(1);
  await recordWorkflowRun({ ...env, BBS_BUILD_PROVENANCE: binding.replace('deployment-one', 'deployment-two') }, step, event, 'bookbuild', 'test');
  expect(raw.query('SELECT * FROM worker_runs').all()).toHaveLength(2);
});
test('missing provenance is explicit and bookkeeping failure does not change acceptance policy', async () => {
  const { raw, env } = fixture();
  await recordWorkerRun({ ...env, BBS_BUILD_PROVENANCE: undefined }, { worker: 'kidsbook-factory', runId: 'old-run', operation: 'repair', startedAt: 123 });
  expect(raw.query('SELECT provenance_status, source_sha FROM worker_runs').get()).toEqual({ provenance_status: 'unknown', source_sha: null });
  const result = await recordWorkerRun({ DB: { prepare() { throw new Error('unavailable'); } } } as any,
    { worker: 'kidsbook-factory', runId: 'failed-write', operation: 'repair', startedAt: 123 });
  expect(result.recorded).toBe(false);
});
test('a wrong-worker or malformed binding cannot masquerade as verified provenance', async () => {
  const { raw, env } = fixture();
  for (const value of ['{', binding.replace('kidsbook-factory', 'bigbrainshelf'), binding.replace('b'.repeat(64), 'not-a-digest')]) {
    await recordWorkerRun({ ...env, BBS_BUILD_PROVENANCE: value }, { worker: 'kidsbook-factory', runId: value, operation: 'repair', startedAt: 123 });
  }
  expect(raw.query("SELECT * FROM worker_runs WHERE provenance_status = 'known'").all()).toHaveLength(0);
});
test('migration preserves existing release records and is safe to apply twice', () => {
  const { raw } = fixture();
  raw.exec("INSERT INTO publish_releases VALUES ('existing','test','rev','{}','{}',NULL,'cg',123)");
  raw.exec(readFileSync(new URL('../db/migrations/0001_release_and_run_provenance.sql', import.meta.url), 'utf8'));
  expect(raw.query('SELECT id FROM publish_releases').get()).toEqual({ id: 'existing' });
});

test('every factory workflow records its run before other work', () => {
  const files = ['bookbuild.ts', 'colorize.ts', 'regen.ts', 'repair.ts', 'pagefix.ts', 'workflow.ts'];
  let count = 0;
  for (const file of files) {
    const source = readFileSync(new URL(`../factory/src/${file}`, import.meta.url), 'utf8');
    const workflows = [...source.matchAll(/async run\([^\n]+\) \{\s+await recordWorkflowRun\(this.env, step, event,/g)];
    count += workflows.length;
  }
  expect(count).toBe(7);
});
