/**
 * Pillar 5A: Reading & Listening Telemetry + Cloudflare Basin Lakehouse Stream
 * - When Cloudflare Workers Analytics Engine (`env.READING_TELEMETRY`) is bound, calls `writeDataPoint(...)`.
 * - When Cloudflare Basin (`env.BASIN_PIPELINE_URL` or `env.BASIN_STREAM`) is bound, streams structured JSON events
 *   to the R2 Apache Iceberg pipeline.
 * - Honest Scaffolding Fallback: Always persists aggregated page/chapter rollups in D1 (`reading_telemetry_rollups`)
 *   and outbox events in D1 (`basin_event_log`), explicitly reporting `telemetryBackend` and `basinBackend` status
 *   so `/admin/revops` distinguishes live bindings from D1 local outbox/rollup scaffolding.
 */

export interface AnalyticsEngineBinding {
  writeDataPoint(event: {
    indexes?: string[];
    blobs?: string[];
    doubles?: number[];
  }): void;
}

export interface TelemetryEnv {
  DB?: D1Database;
  READING_TELEMETRY?: AnalyticsEngineBinding;
  BASIN_PIPELINE_URL?: string;
  BASIN_PIPELINE_TOKEN?: string;
  BASIN_STREAM?: {
    send(message: unknown): Promise<void>;
  };
}

export interface ReadingTelemetryEvent {
  userId?: string | null;
  bookSlug: string;
  chapterIndex: number;
  pageIndex: number;
  eventType: "page_view" | "audio_complete" | "drop_off" | "read_along_flip";
  dwellSeconds?: number;
  isReplay?: boolean;
  format?: "story" | "read_along" | "audio";
}

export interface BasinCommerceOrTelemetryEvent {
  streamName: "bbs_reading_telemetry" | "bbs_commerce_events" | "bbs_ai_cogs";
  eventName: string;
  userId?: string | null;
  bookSlug?: string | null;
  revenueCents?: number;
  cogsCents?: number;
  payload: Record<string, unknown>;
}

let telemetrySchemaReady = false;

export async function ensureTelemetrySchema(db?: D1Database): Promise<void> {
  if (!db || telemetrySchemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS reading_telemetry_rollups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_slug TEXT NOT NULL,
        chapter_index INTEGER NOT NULL DEFAULT 0,
        page_index INTEGER NOT NULL DEFAULT 0,
        event_type TEXT NOT NULL,
        total_events INTEGER NOT NULL DEFAULT 0,
        avg_dwell_seconds REAL NOT NULL DEFAULT 0,
        replay_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`
    )
    .run();
  await db
    .prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS reading_telemetry_unique_idx
       ON reading_telemetry_rollups(book_slug, chapter_index, page_index, event_type)`
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS basin_event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_name TEXT NOT NULL,
        event_name TEXT NOT NULL,
        user_id TEXT,
        book_slug TEXT,
        revenue_cents INTEGER NOT NULL DEFAULT 0,
        cogs_cents INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL DEFAULT '{}',
        synced_to_basin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`
    )
    .run();
  telemetrySchemaReady = true;
}

export async function recordReadingTelemetry(
  env: TelemetryEnv | undefined,
  event: ReadingTelemetryEvent
): Promise<{
  wroteAnalyticsEngine: boolean;
  updatedD1Rollup: boolean;
  telemetryBackend: "workers_analytics_engine" | "d1_rollup_scaffolding";
}> {
  let wroteAnalyticsEngine = false;
  let updatedD1Rollup = false;

  if (env?.READING_TELEMETRY) {
    try {
      env.READING_TELEMETRY.writeDataPoint({
        indexes: [event.bookSlug],
        blobs: [
          event.eventType,
          event.format || "story",
          `ch:${event.chapterIndex}`,
          `pg:${event.pageIndex}`,
        ],
        doubles: [
          event.chapterIndex,
          event.pageIndex,
          Number(event.dwellSeconds || 0),
          event.isReplay ? 1 : 0,
        ],
      });
      wroteAnalyticsEngine = true;
    } catch {
      // non-fatal
    }
  }

  if (env?.DB) {
    await ensureTelemetrySchema(env.DB);
    const now = new Date().toISOString();
    const dwell = Math.max(0, Number(event.dwellSeconds || 0));
    const replayDelta = event.isReplay ? 1 : 0;

    await env.DB.prepare(
      `INSERT INTO reading_telemetry_rollups
        (book_slug, chapter_index, page_index, event_type, total_events, avg_dwell_seconds, replay_count, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(book_slug, chapter_index, page_index, event_type) DO UPDATE SET
        avg_dwell_seconds = ROUND(((reading_telemetry_rollups.avg_dwell_seconds * reading_telemetry_rollups.total_events) + excluded.avg_dwell_seconds) / (reading_telemetry_rollups.total_events + 1), 2),
        total_events = reading_telemetry_rollups.total_events + 1,
        replay_count = reading_telemetry_rollups.replay_count + excluded.replay_count,
        updated_at = excluded.updated_at`
    )
      .bind(
        event.bookSlug,
        Math.max(0, Math.round(event.chapterIndex)),
        Math.max(0, Math.round(event.pageIndex)),
        event.eventType,
        dwell,
        replayDelta,
        now
      )
      .run();
    updatedD1Rollup = true;
  }

  await streamToBasinPipeline(env, {
    streamName: "bbs_reading_telemetry",
    eventName: event.eventType,
    userId: event.userId ?? null,
    bookSlug: event.bookSlug,
    payload: {
      chapterIndex: event.chapterIndex,
      pageIndex: event.pageIndex,
      dwellSeconds: event.dwellSeconds ?? 0,
      isReplay: Boolean(event.isReplay),
      format: event.format || "story",
    },
  });

  return {
    wroteAnalyticsEngine,
    updatedD1Rollup,
    telemetryBackend: wroteAnalyticsEngine
      ? "workers_analytics_engine"
      : "d1_rollup_scaffolding",
  };
}

export async function streamToBasinPipeline(
  env: TelemetryEnv | undefined,
  event: BasinCommerceOrTelemetryEvent
): Promise<{
  syncedToBasin: boolean;
  basinBackend: "cloudflare_basin_live" | "d1_outbox_scaffolding";
}> {
  let syncedToBasin = false;
  const now = new Date().toISOString();

  if (env?.BASIN_STREAM) {
    try {
      await env.BASIN_STREAM.send({ ...event, timestamp: now });
      syncedToBasin = true;
    } catch {
      // keep in D1 outbox
    }
  } else if (env?.BASIN_PIPELINE_URL) {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (env.BASIN_PIPELINE_TOKEN) {
        headers.authorization = `Bearer ${env.BASIN_PIPELINE_TOKEN}`;
      }
      const res = await fetch(env.BASIN_PIPELINE_URL, {
        method: "POST",
        headers,
        body: JSON.stringify([{ ...event, timestamp: now }]),
      });
      if (res.ok) syncedToBasin = true;
    } catch {
      // keep in D1 outbox
    }
  }

  if (env?.DB) {
    await ensureTelemetrySchema(env.DB);
    await env.DB.prepare(
      `INSERT INTO basin_event_log
        (stream_name, event_name, user_id, book_slug, revenue_cents, cogs_cents, payload_json, synced_to_basin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        event.streamName,
        event.eventName,
        event.userId ?? null,
        event.bookSlug ?? null,
        Math.round(event.revenueCents || 0),
        Math.round(event.cogsCents || 0),
        JSON.stringify(event.payload || {}),
        syncedToBasin ? 1 : 0,
        now
      )
      .run();
  }

  return {
    syncedToBasin,
    basinBackend: syncedToBasin ? "cloudflare_basin_live" : "d1_outbox_scaffolding",
  };
}

export async function getReadingDropoffSummary(db?: D1Database): Promise<
  Array<{
    bookSlug: string;
    chapterIndex: number;
    pageIndex: number;
    eventType: string;
    totalEvents: number;
    avgDwellSeconds: number;
    replayCount: number;
  }>
> {
  if (!db) return [];
  await ensureTelemetrySchema(db);
  const rows = await db
    .prepare(
      `SELECT book_slug, chapter_index, page_index, event_type, total_events, avg_dwell_seconds, replay_count
       FROM reading_telemetry_rollups
       ORDER BY total_events DESC, chapter_index ASC
       LIMIT 25`
    )
    .all<{
      book_slug: string;
      chapter_index: number;
      page_index: number;
      event_type: string;
      total_events: number;
      avg_dwell_seconds: number;
      replay_count: number;
    }>();

  return (rows.results || []).map((r) => ({
    bookSlug: r.book_slug,
    chapterIndex: Number(r.chapter_index || 0),
    pageIndex: Number(r.page_index || 0),
    eventType: r.event_type,
    totalEvents: Number(r.total_events || 0),
    avgDwellSeconds: Number(r.avg_dwell_seconds || 0),
    replayCount: Number(r.replay_count || 0),
  }));
}
