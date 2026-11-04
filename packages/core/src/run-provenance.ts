/** Deployment attribution only. This does not change generation/gate policies. */
interface RunDatabase {
  prepare(sql: string): { bind(...values: (string | number | null)[]): { run(): Promise<unknown> } };
}
interface ProvenanceEnv { DB?: RunDatabase; BBS_BUILD_PROVENANCE?: string }
interface RunInfo {
  worker: string;
  runId: string;
  operation: string;
  bookSlug?: string;
  startedAt: number;
}
interface BuildInfo { sourceSha: string | null; buildDigest: string | null; deploymentId: string | null }
export type RunRecord = RunInfo & BuildInfo & { provenanceStatus: 'known' | 'unknown'; recorded: boolean };

function buildInfo(env: ProvenanceEnv, worker: string): BuildInfo {
  try {
    const value = JSON.parse(env.BBS_BUILD_PROVENANCE ?? 'null');
    if (value?.schema === 'worker-build/v1' && value.worker === worker &&
      /^[a-f0-9]{40}$/.test(value.sourceSha) && /^[a-f0-9]{64}$/.test(value.buildDigest) &&
      typeof value.deploymentId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value.deploymentId))
      return { sourceSha: value.sourceSha, buildDigest: value.buildDigest, deploymentId: value.deploymentId };
  } catch { /* old or local bundles have unknown attribution */ }
  return { sourceSha: null, buildDigest: null, deploymentId: null };
}

export async function recordWorkerRun(env: ProvenanceEnv, run: RunInfo): Promise<RunRecord> {
  const build = buildInfo(env, run.worker);
  const status = build.sourceSha ? 'known' : 'unknown';
  const id = JSON.stringify([run.worker, run.operation, run.runId, run.startedAt, build.deploymentId, build.sourceSha, build.buildDigest]);
  const record: RunInfo & BuildInfo & { provenanceStatus: 'known' | 'unknown' } = { ...run, ...build, provenanceStatus: status };
  try {
    if (!env.DB) throw new Error('Run database unavailable');
    await env.DB.prepare(`INSERT OR IGNORE INTO worker_runs
      (id, worker, run_id, operation, book_slug, deployment_id, source_sha, build_digest,
       provenance_status, started_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, run.worker, run.runId, run.operation, run.bookSlug ?? null, build.deploymentId,
        build.sourceSha, build.buildDigest, status, run.startedAt, Date.now()).run();
    console.log(JSON.stringify({ event: 'run_provenance', recorded: true, ...record }));
    return { recorded: true, ...record };
  } catch {
    // CG has not approved durability-first acceptance behavior. Expose the gap
    // without blocking work or pretending the durable write succeeded.
    console.warn(JSON.stringify({ event: 'run_provenance', recorded: false, ...record }));
    return { recorded: false, ...record };
  }
}

export async function recordWorkflowRun(
  env: ProvenanceEnv,
  step: { do(name: string, callback: () => Promise<RunRecord>): Promise<RunRecord> },
  event: { instanceId: string; timestamp: Date }, operation: string, bookSlug?: string
) {
  const build = buildInfo(env, 'kidsbook-factory');
  const stepName = `provenance ${operation} ${build.deploymentId ?? 'unknown'} ${build.buildDigest ?? 'unknown'}`;
  return step.do(stepName, () => recordWorkerRun(env, { worker: 'kidsbook-factory', runId: event.instanceId,
    operation, bookSlug, startedAt: event.timestamp.getTime() }));
}
