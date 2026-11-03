// ------------------------------------------------------- metrics plane
//
// Workers Analytics Engine: the hot, SQL-queryable window over factory
// events (retention is about three months, so D1 gen_attempts and the
// R2 archive stay the durable record; this plane exists for fast
// questions: accept rates by kind this week, cost burn by book, gate
// score distributions). Added 2026-11-01 with the budget counter, from
// the merged factory-scale plan.
//
// One dataset, factory_metrics. Every datapoint carries the event name
// as blob1 and the book slug as the index. Emits are fire-and-forget:
// writeDataPoint never throws into the build path, and the try/catch
// here is belt and braces.

export interface MetricEnvLike {
  METRICS?: { writeDataPoint?: (p: any) => void };
}

function emit(env: MetricEnvLike, blobs: string[], doubles: number[], index: string): void {
  try {
    const ds = (env as any)?.METRICS;
    if (!ds?.writeDataPoint) return;
    ds.writeDataPoint({ blobs, doubles, indexes: [index] });
  } catch {
    // metrics must never break a build
  }
}

// Score doubles use -1 for "gate did not score this": AE has no null.
const sc = (scores: Record<string, number | null> | null | undefined, k: string): number =>
  typeof scores?.[k] === "number" ? (scores[k] as number) : -1;

export function emitAttemptMetric(
  env: MetricEnvLike,
  slug: string,
  kind: string,
  chapter: string | null,
  page: number | null,
  attempt: number,
  detail: { outcome: string; cost?: number | null; scores?: Record<string, number | null> | null }
): void {
  emit(
    env,
    ["gen_attempt", slug, kind, detail.outcome, chapter ?? "", page == null ? "" : String(page)],
    [
      detail.cost ?? 0,
      attempt,
      sc(detail.scores, "anatomy"),
      sc(detail.scores, "character_match"),
      sc(detail.scores, "cast_match"),
      sc(detail.scores, "has_text"),
      sc(detail.scores, "is_lineart"),
      sc(detail.scores, "is_color"),
    ],
    slug
  );
}

export function emitBudgetMetric(
  env: MetricEnvLike,
  slug: string,
  action: string,
  amountUsd: number,
  spentUsd: number
): void {
  emit(env, ["budget", slug, action], [amountUsd, spentUsd], slug);
}

export function emitTextMetric(
  env: MetricEnvLike,
  slug: string | null,
  model: string,
  purpose: string,
  costUsd: number,
  inputTokens: number,
  outputTokens: number
): void {
  emit(
    env,
    ["text_call", slug ?? "", model, purpose],
    [costUsd, inputTokens, outputTokens],
    slug ?? "text"
  );
}

export function emitEventMetric(
  env: MetricEnvLike,
  slug: string,
  kind: string,
  event: string,
  costUsd: number
): void {
  emit(env, ["event", slug, kind, event], [costUsd], slug);
}

export function emitAppealMetric(
  env: MetricEnvLike,
  slug: string,
  judgeModel: string,
  verdict: string,
  claimUpheld: number
): void {
  emit(env, ["appeal", slug, judgeModel, verdict], [claimUpheld], slug);
}
