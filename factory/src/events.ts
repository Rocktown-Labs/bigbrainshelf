// ------------------------------------------------------- event envelope
//
// One versioned event shape for everything the factory does, landed
// 2026-11-01 with the FAANG-grade data plane: every stage change,
// appeal, edition, visual pass, and budget action writes the same
// envelope to D1 production_events (the exact, durable record) and
// emits a datapoint to Analytics Engine (the hot SQL window). R2
// remains the artifact archive. Envelope:
//   { slug, kind, stage, event, detail (JSON), cost_usd, created_at }
// kind is the domain (stage | appeal | edition | visualpass | budget |
// run); event is the verb inside it. New kinds never need a schema
// change: detail carries the specifics, versioned by the kind itself.

import { emitEventMetric } from "./metrics";

export interface FactoryEvent {
  slug: string;
  kind: string;
  stage?: string | null;
  event: string;
  detail?: any;
  costUsd?: number | null;
}

let tableReady = false;

export async function emitEvent(env: any, e: FactoryEvent): Promise<void> {
  try {
    if (!tableReady) {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS production_events (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, kind TEXT, stage TEXT, event TEXT, detail TEXT, cost_usd REAL, created_at INTEGER)"
      ).run();
      tableReady = true;
    }
    await env.DB.prepare(
      "INSERT INTO production_events (slug, kind, stage, event, detail, cost_usd, created_at) VALUES (?,?,?,?,?,?,?)"
    )
      .bind(
        e.slug,
        e.kind,
        e.stage ?? null,
        e.event,
        e.detail != null ? JSON.stringify(e.detail).slice(0, 4000) : null,
        e.costUsd ?? null,
        Math.floor(Date.now() / 1000)
      )
      .run();
  } catch {
    // the envelope must never break the work it describes
  }
  emitEventMetric(env, e.slug, e.kind, e.event, e.costUsd ?? 0);
}
