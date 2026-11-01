// Pillar 5: High-Cardinality Product Telemetry (Workers Analytics Engine)
// & Cloudflare Basin (Pipelines -> R2 Apache Iceberg) Event Streamer.
//
// Keeps Traks strictly cookieless, zero-PII, and low-cardinality on the
// storefront while capturing Netflix/Spotify-grade chapter completion,
// page drop-off, Read-Along auto-flip engagement, and Iceberg lakehouse
// events on the backend.

import type { DBLike } from "./orders";
import { ensureOnce } from "./schema-cache";

export interface ReadingTelemetryPoint {
  bookSlug: string;
  chapterNum: number;
  pageIndex: number;
  edition: string; // "story" | "coloring" | "fullcolor" | "readalong" | "cover"
  ageGroup?: string;
  audioPositionSec?: number;
  audioDurationSec?: number;
  listenDeltaSec?: number;
}

export interface BasinLakehouseEvent {
  tableTarget: "orders_iceberg" | "reading_iceberg" | "club_iceberg" | "revops_iceberg";
  eventName: string;
  payload: Record<string, any>;
}

export async function ensureTelemetryTables(db: DBLike): Promise<void> {
  await ensureOnce(db, "telemetry_basin_tables_v1", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS reading_telemetry_rollups (
          id TEXT PRIMARY KEY,
          book_slug TEXT NOT NULL,
          chapter_num INTEGER NOT NULL DEFAULT 1,
          edition TEXT NOT NULL DEFAULT 'story',
          age_group TEXT NOT NULL DEFAULT '4-8',
          heartbeats INTEGER NOT NULL DEFAULT 0,
          completions INTEGER NOT NULL DEFAULT 0,
          total_listen_sec INTEGER NOT NULL DEFAULT 0,
          max_page_reached INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        )`
      )
      .run();
    await db
      .prepare("CREATE INDEX IF NOT EXISTS reading_telemetry_book_idx ON reading_telemetry_rollups(book_slug)")
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS basin_event_log (
          id TEXT PRIMARY KEY,
          table_target TEXT NOT NULL,
          event_name TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          synced_to_basin INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )`
      )
      .run();
    await db
      .prepare("CREATE INDEX IF NOT EXISTS basin_event_synced_idx ON basin_event_log(synced_to_basin, created_at)")
      .run();
  });
}

// Compute completion percentage (0..100) from audio position/duration or page index
export function computeCompletionPct(point: ReadingTelemetryPoint): number {
  const pos = Number(point.audioPositionSec || 0);
  const dur = Number(point.audioDurationSec || 0);
  if (dur > 10 && pos > 0) {
    return Math.min(100, Math.round((pos / dur) * 100));
  }
  const pIdx = Number(point.pageIndex || 0);
  if (pIdx > 0) {
    // Typical book has ~12-16 pages across chapters
    return Math.min(100, Math.round(((pIdx + 1) / 10) * 100));
  }
  return 0;
}

// Write a high-cardinality reading/listening telemetry datapoint to:
//   1. Cloudflare Workers Analytics Engine (`env.READING_TELEMETRY.writeDataPoint`) if bound
//   2. D1 `reading_telemetry_rollups` so `/admin/revops` can query chapter completion &
//      Read-Along lift immediately
export async function recordReadingTelemetry(
  db: DBLike,
  env: any,
  point: ReadingTelemetryPoint
): Promise<{ completionPct: number; isCompleted80: boolean }> {
  await ensureTelemetryTables(db);
  const bookSlug = String(point.bookSlug || "unknown").trim();
  const chapterNum = Math.max(1, Number(point.chapterNum || 1));
  const edition = String(point.edition || "story").trim();
  const ageGroup = String(point.ageGroup || "4-8").trim();
  const pageIndex = Math.max(0, Number(point.pageIndex || 0));
  const listenDelta = Math.max(0, Number(point.listenDeltaSec || 15));
  const completionPct = computeCompletionPct(point);
  const isCompleted80 = completionPct >= 80;
  const now = Math.floor(Date.now() / 1000);

  // 1. Cloudflare Workers Analytics Engine binding (when configured on Worker)
  if (env?.READING_TELEMETRY && typeof env.READING_TELEMETRY.writeDataPoint === "function") {
    try {
      env.READING_TELEMETRY.writeDataPoint({
        indexes: [bookSlug],
        blobs: [bookSlug, edition, ageGroup, `ch${chapterNum}`],
        doubles: [chapterNum, pageIndex, Number(point.audioPositionSec || 0), completionPct],
      });
    } catch {}
  }

  // 2. Rollup in D1 `reading_telemetry_rollups`
  const id = `${bookSlug}:${chapterNum}:${edition}`;
  const completionInc = isCompleted80 ? 1 : 0;
  await db
    .prepare(
      `INSERT INTO reading_telemetry_rollups
        (id, book_slug, chapter_num, edition, age_group, heartbeats, completions, total_listen_sec, max_page_reached, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         heartbeats = reading_telemetry_rollups.heartbeats + 1,
         completions = reading_telemetry_rollups.completions + excluded.completions,
         total_listen_sec = reading_telemetry_rollups.total_listen_sec + excluded.total_listen_sec,
         max_page_reached = MAX(reading_telemetry_rollups.max_page_reached, excluded.max_page_reached),
         updated_at = excluded.updated_at`
    )
    .bind(id, bookSlug, chapterNum, edition, ageGroup, completionInc, listenDelta, pageIndex, now)
    .run();

  return { completionPct, isCompleted80 };
}

// Stream a structured event to Cloudflare Basin (HTTP Pipeline endpoint or binding)
// and persist in `basin_event_log` for Apache Iceberg table ingestion on R2.
export async function streamToBasinPipeline(
  db: DBLike,
  env: any,
  event: BasinLakehouseEvent
): Promise<{ id: string; synced: boolean }> {
  await ensureTelemetryTables(db);
  const now = Math.floor(Date.now() / 1000);
  const id = `basin_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const envelope = {
    event_id: id,
    timestamp: new Date(now * 1000).toISOString(),
    table_target: event.tableTarget,
    event_name: event.eventName,
    ...event.payload,
  };

  let synced = false;
  if (env?.BASIN_PIPELINE_URL) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (env.BASIN_API_TOKEN) headers.Authorization = `Bearer ${env.BASIN_API_TOKEN}`;
      const res = await fetch(String(env.BASIN_PIPELINE_URL), {
        method: "POST",
        headers,
        body: JSON.stringify([envelope]),
      });
      synced = res.ok;
    } catch {}
  } else if (env?.BASIN_STREAM && typeof env.BASIN_STREAM.send === "function") {
    try {
      await env.BASIN_STREAM.send([envelope]);
      synced = true;
    } catch {}
  }

  await db
    .prepare(
      `INSERT INTO basin_event_log
        (id, table_target, event_name, payload_json, synced_to_basin, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, event.tableTarget, event.eventName, JSON.stringify(envelope), synced ? 1 : 0, now)
    .run();

  return { id, synced };
}

export async function getReadingTelemetrySummary(
  db: DBLike
): Promise<{
  totalHeartbeats: number;
  totalCompletions: number;
  readAlongSharePct: number;
  byBook: {
    bookSlug: string;
    heartbeats: number;
    completions: number;
    readAlongHeartbeats: number;
    maxPageReached: number;
  }[];
}> {
  await ensureTelemetryTables(db);
  const res = await db
    .prepare("SELECT * FROM reading_telemetry_rollups")
    .all()
    .catch(() => ({ results: [] }));
  const rows = (res.results || (res as any).rows || []) as any[];

  let totalHeartbeats = 0;
  let totalCompletions = 0;
  let readAlongHeartbeats = 0;
  const bookMap = new Map<
    string,
    { heartbeats: number; completions: number; readAlongHeartbeats: number; maxPageReached: number }
  >();

  for (const r of rows) {
    const hb = Number(r.heartbeats || 0);
    const comp = Number(r.completions || 0);
    const isReadAlong = r.edition === "readalong" || r.edition === "fullcolor";
    const slug = String(r.book_slug || "unknown");

    totalHeartbeats += hb;
    totalCompletions += comp;
    if (isReadAlong) readAlongHeartbeats += hb;

    const prev = bookMap.get(slug) || {
      heartbeats: 0,
      completions: 0,
      readAlongHeartbeats: 0,
      maxPageReached: 0,
    };
    prev.heartbeats += hb;
    prev.completions += comp;
    if (isReadAlong) prev.readAlongHeartbeats += hb;
    prev.maxPageReached = Math.max(prev.maxPageReached, Number(r.max_page_reached || 0));
    bookMap.set(slug, prev);
  }

  return {
    totalHeartbeats,
    totalCompletions,
    readAlongSharePct:
      totalHeartbeats > 0 ? Math.round((readAlongHeartbeats / totalHeartbeats) * 100) : 0,
    byBook: Array.from(bookMap.entries())
      .map(([bookSlug, v]) => ({ bookSlug, ...v }))
      .sort((a, b) => b.heartbeats - a.heartbeats),
  };
}
