// Fixed-window rate limiting in D1 for routes outside better-auth's
// built-in limiter (admin password login, cast-chat, public semantic
// search). One row per key: the window start (epoch seconds) and the
// count of attempts inside it. Every check is a read + a write, which
// is the accepted cost: the routes that use this are either low-
// traffic admin endpoints or already-authenticated API calls.
//
// The table self-heals at runtime exactly like the other ensure*
// schemas, and rows are keyed per limiter (key includes the
// endpoint, the identity, and the window size), so limits are
// independent per rule.

import type { DBLike } from "./orders";

const ensured = new WeakSet<object>();

export async function ensureRateLimitTable(db: DBLike): Promise<void> {
  if (!db || ensured.has(db as object)) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS app_rate_limits (
        key TEXT NOT NULL PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0
      )`
    )
    .bind()
    .run();
  ensured.add(db as object);
}

export interface RateLimitResult {
  ok: boolean;
  /** Attempts recorded in the current window, including this one. */
  count: number;
  limit: number;
  /** Seconds until the window resets (0 when ok). */
  retryAfterSec: number;
}

/**
 * Count one attempt against the limit. Returns ok=false (and the
 * wait) once the window is full; the overflowing attempt is still
 * recorded, so repeated hammering never widens the window.
 */
export async function checkRateLimit(
  db: DBLike,
  key: string,
  limit: number,
  windowSec: number
): Promise<RateLimitResult> {
  await ensureRateLimitTable(db);
  const now = Math.floor(Date.now() / 1000);
  const k = String(key || "").slice(0, 200);
  const row = (await db
    .prepare("SELECT window_start, count FROM app_rate_limits WHERE key = ?")
    .bind(k)
    .first()) as any;
  const start = Number(row?.window_start || 0);
  const elapsed = now - start;
  if (!row || elapsed < 0 || elapsed >= windowSec) {
    // Fresh window (elapsed < 0 covers a clock rollback).
    await db
      .prepare(
        `INSERT INTO app_rate_limits (key, window_start, count)
         VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`
      )
      .bind(k, now)
      .run();
    return { ok: true, count: 1, limit, retryAfterSec: 0 };
  }
  const count = Number(row?.count || 0) + 1;
  await db
    .prepare("UPDATE app_rate_limits SET count = ? WHERE key = ?")
    .bind(count, k)
    .run();
  if (count > limit) {
    return { ok: false, count, limit, retryAfterSec: windowSec - elapsed };
  }
  return { ok: true, count, limit, retryAfterSec: 0 };
}

/** The client IP behind Cloudflare, or a constant for local dev. */
export function clientIp(request: Request): string {
  return String(request.headers.get("cf-connecting-ip") || "local");
}
