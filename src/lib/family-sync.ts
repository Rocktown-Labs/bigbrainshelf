/**
 * Pillar 3: "Whispersync / Spotify Connect for Families" & Guardrailed "Talk to the Cast"
 * - Exports both:
 *   1. `FamilyRoomDurableObject` (real Cloudflare Durable Object class with SQLite storage & WebSocket broadcast
 *      when `env.FAMILY_ROOM_DO` is bound in Cloudflare Workers).
 *   2. D1 Polling Scaffolding (`family_sync_rooms` via `getFamilySyncState` / `updateFamilySyncState`), explicitly
 *      labeled with `syncBackend: "durable_object" | "d1_polling_scaffolding"` so callers and `/admin/revops`
 *      know whether live Durable Object WebSockets or D1 polling scaffolding are active.
 * - Guardrailed "Talk to the Cast" Story Companion:
 *   - Routes LLM comprehension exchanges through `VERCEL_AI_GATEWAY_URL` when configured, with deterministic
 *     story-grounded canon responses (`source: "vercel_ai_gateway" | "story_canon_scaffolding"`) when offline.
 */

import { KID_AVATARS } from "./family";
import { retrieveCanonContinuity } from "./braintrust";

export type FamilySyncBackendMode = "durable_object" | "d1_polling_scaffolding";

export interface FamilySyncState {
  familyUserId: string;
  /** The active kid profile id (a UUID string). */
  activeKidId: string | null;
  activeBookSlug: string | null;
  activeFormat: "story" | "read_along" | "audio";
  chapterIndex: number;
  pageIndex: number;
  audioPositionSec: number;
  isPlaying: boolean;
  autoFlipEnabled: boolean;
  dailyLimitMinutes: number;
  minutesUsedToday: number;
  isBedtimeLocked: boolean;
  activeDeviceId: string | null;
  updatedAt: string;
  syncBackend: FamilySyncBackendMode;
}

export interface FamilySyncUpdateInput {
  activeKidId?: string | null;
  activeBookSlug?: string | null;
  activeFormat?: "story" | "read_along" | "audio";
  chapterIndex?: number;
  pageIndex?: number;
  audioPositionSec?: number;
  isPlaying?: boolean;
  autoFlipEnabled?: boolean;
  dailyLimitMinutes?: number;
  elapsedMinutesDelta?: number;
  activeDeviceId?: string | null;
}

export interface CastCompanionReply {
  characterName: string;
  characterRole: string;
  bookSlug: string;
  questionText: string;
  responseText: string;
  comprehensionBadge: string;
  followUpPrompt: string;
  source: "vercel_ai_gateway" | "story_canon_scaffolding";
}

/**
 * Real Cloudflare Durable Object for stateful WebSocket + SQLite family room sync when `FAMILY_ROOM_DO` is bound.
 */
export class FamilyRoomDurableObject {
  private ctx: any;
  private env: any;

  constructor(ctx: any, env: any) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      if (typeof this.ctx?.acceptWebSocket === "function") {
        this.ctx.acceptWebSocket(server);
      } else {
        server.accept();
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && url.pathname.endsWith("/sync")) {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      await this.ctx?.storage?.put?.("state", {
        ...body,
        updatedAt: new Date().toISOString(),
        syncBackend: "durable_object",
      });
      const sockets: WebSocket[] =
        typeof this.ctx?.getWebSockets === "function" ? this.ctx.getWebSockets() : [];
      const payload = JSON.stringify({
        type: "family_sync_update",
        state: await this.ctx?.storage?.get?.("state"),
      });
      for (const ws of sockets) {
        try {
          ws.send(payload);
        } catch {
          // ignore closed socket
        }
      }
      return new Response(payload, { headers: { "content-type": "application/json" } });
    }

    const current = (await this.ctx?.storage?.get?.("state")) || { syncBackend: "durable_object" };
    return new Response(JSON.stringify({ ok: true, state: current }), {
      headers: { "content-type": "application/json" },
    });
  }
}

let syncSchemaReady = false;

export async function ensureFamilySyncSchema(db?: D1Database): Promise<void> {
  if (!db || syncSchemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS family_sync_rooms (
        family_user_id TEXT PRIMARY KEY,
        active_kid_id TEXT,
        active_book_slug TEXT,
        active_format TEXT NOT NULL DEFAULT 'story',
        chapter_index INTEGER NOT NULL DEFAULT 0,
        page_index INTEGER NOT NULL DEFAULT 0,
        audio_position_sec REAL NOT NULL DEFAULT 0,
        is_playing INTEGER NOT NULL DEFAULT 0,
        auto_flip_enabled INTEGER NOT NULL DEFAULT 1,
        daily_limit_minutes INTEGER NOT NULL DEFAULT 45,
        minutes_used_today REAL NOT NULL DEFAULT 0,
        last_activity_date TEXT,
        active_device_id TEXT,
        updated_at TEXT NOT NULL
      )`
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS cast_companion_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        kid_profile_id TEXT,
        book_slug TEXT NOT NULL,
        character_name TEXT NOT NULL,
        question_text TEXT NOT NULL,
        response_text TEXT NOT NULL,
        comprehension_badge TEXT,
        created_at TEXT NOT NULL
      )`
    )
    .run();
  syncSchemaReady = true;
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getFamilySyncState(
  db: D1Database | undefined,
  familyUserId: string,
  env?: { FAMILY_ROOM_DO?: any }
): Promise<FamilySyncState> {
  const syncBackend: FamilySyncBackendMode = env?.FAMILY_ROOM_DO
    ? "durable_object"
    : "d1_polling_scaffolding";

  const now = new Date().toISOString();
  const today = todayUtcDate();
  if (!db) {
    return {
      familyUserId,
      activeKidId: null,
      activeBookSlug: "fern-counts-the-forest",
      activeFormat: "read_along",
      chapterIndex: 0,
      pageIndex: 0,
      audioPositionSec: 0,
      isPlaying: false,
      autoFlipEnabled: true,
      dailyLimitMinutes: 45,
      minutesUsedToday: 0,
      isBedtimeLocked: false,
      activeDeviceId: null,
      updatedAt: now,
      syncBackend,
    };
  }

  await ensureFamilySyncSchema(db);
  const row = await db
    .prepare(`SELECT * FROM family_sync_rooms WHERE family_user_id = ?`)
    .bind(familyUserId)
    .first<Record<string, any>>();

  if (!row) {
    return {
      familyUserId,
      activeKidId: null,
      activeBookSlug: "fern-counts-the-forest",
      activeFormat: "read_along",
      chapterIndex: 0,
      pageIndex: 0,
      audioPositionSec: 0,
      isPlaying: false,
      autoFlipEnabled: true,
      dailyLimitMinutes: 45,
      minutesUsedToday: 0,
      isBedtimeLocked: false,
      activeDeviceId: null,
      updatedAt: now,
      syncBackend,
    };
  }

  const minutesUsedToday =
    row.last_activity_date === today ? Number(row.minutes_used_today || 0) : 0;
  const dailyLimitMinutes = Number(row.daily_limit_minutes || 45);

  return {
    familyUserId,
    activeKidId: row.active_kid_id ?? null,
    activeBookSlug: row.active_book_slug ?? "fern-counts-the-forest",
    activeFormat: (row.active_format as FamilySyncState["activeFormat"]) || "read_along",
    chapterIndex: Number(row.chapter_index || 0),
    pageIndex: Number(row.page_index || 0),
    audioPositionSec: Number(row.audio_position_sec || 0),
    isPlaying: Boolean(row.is_playing),
    autoFlipEnabled: row.auto_flip_enabled !== 0,
    dailyLimitMinutes,
    minutesUsedToday: Number(minutesUsedToday.toFixed(2)),
    isBedtimeLocked: dailyLimitMinutes > 0 && minutesUsedToday >= dailyLimitMinutes,
    activeDeviceId: row.active_device_id ?? null,
    updatedAt: String(row.updated_at || now),
    syncBackend,
  };
}

export async function updateFamilySyncState(
  db: D1Database | undefined,
  familyUserId: string,
  patch: FamilySyncUpdateInput,
  env?: { FAMILY_ROOM_DO?: any }
): Promise<FamilySyncState> {
  const current = await getFamilySyncState(db, familyUserId, env);
  const now = new Date().toISOString();
  const today = todayUtcDate();

  const nextActiveKidId =
    patch.activeKidId !== undefined
      ? patch.activeKidId === null
        ? null
        : String(patch.activeKidId)
      : current.activeKidId;

  let nextLimit =
    patch.dailyLimitMinutes !== undefined
      ? Math.max(5, Math.min(240, Number(patch.dailyLimitMinutes)))
      : current.dailyLimitMinutes;
  // N2 (2026-10-31): the room's daily limit is the parent's setting,
  // not the client's. The 5-240 clamp above only bounds the raw value;
  // this also caps it at the active kid profile's saved limit, so a kid
  // (or any client) cannot widen their own screen-time budget through
  // the sync route. No profile row (or a broken query) keeps the
  // clamped value — never the client's raw number unchecked.
  if (patch.dailyLimitMinutes !== undefined && db && nextActiveKidId) {
    try {
      const kid = await db
        .prepare("SELECT daily_limit_minutes FROM kid_profiles WHERE id = ? AND user_id = ? LIMIT 1")
        .bind(String(nextActiveKidId), familyUserId)
        .first<Record<string, any>>();
      if (kid && Number.isFinite(Number(kid.daily_limit_minutes))) {
        nextLimit = Math.min(nextLimit, Math.max(0, Number(kid.daily_limit_minutes)));
      }
    } catch {
      /* kid_profiles may not exist yet: keep the clamped value */
    }
  }
  const nextMinutes = Math.max(
    0,
    current.minutesUsedToday + Number(patch.elapsedMinutesDelta || 0)
  );
  const isBedtimeLocked = nextLimit > 0 && nextMinutes >= nextLimit;

  const updated: FamilySyncState = {
    familyUserId,
    activeKidId: nextActiveKidId,
    activeBookSlug:
      patch.activeBookSlug !== undefined ? patch.activeBookSlug : current.activeBookSlug,
    activeFormat: patch.activeFormat || current.activeFormat,
    chapterIndex:
      patch.chapterIndex !== undefined
        ? Math.max(0, Number(patch.chapterIndex))
        : current.chapterIndex,
    pageIndex:
      patch.pageIndex !== undefined ? Math.max(0, Number(patch.pageIndex)) : current.pageIndex,
    audioPositionSec:
      patch.audioPositionSec !== undefined
        ? Math.max(0, Number(patch.audioPositionSec))
        : current.audioPositionSec,
    isPlaying: isBedtimeLocked
      ? false
      : patch.isPlaying !== undefined
        ? Boolean(patch.isPlaying)
        : current.isPlaying,
    autoFlipEnabled:
      patch.autoFlipEnabled !== undefined
        ? Boolean(patch.autoFlipEnabled)
        : current.autoFlipEnabled,
    dailyLimitMinutes: nextLimit,
    minutesUsedToday: Number(nextMinutes.toFixed(2)),
    isBedtimeLocked,
    activeDeviceId:
      patch.activeDeviceId !== undefined ? patch.activeDeviceId : current.activeDeviceId,
    updatedAt: now,
    syncBackend: env?.FAMILY_ROOM_DO ? "durable_object" : "d1_polling_scaffolding",
  };

  if (db) {
    await ensureFamilySyncSchema(db);
    await db
      .prepare(
        `INSERT INTO family_sync_rooms
          (family_user_id, active_kid_id, active_book_slug, active_format, chapter_index, page_index,
           audio_position_sec, is_playing, auto_flip_enabled, daily_limit_minutes, minutes_used_today,
           last_activity_date, active_device_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(family_user_id) DO UPDATE SET
           active_kid_id = excluded.active_kid_id,
           active_book_slug = excluded.active_book_slug,
           active_format = excluded.active_format,
           chapter_index = excluded.chapter_index,
           page_index = excluded.page_index,
           audio_position_sec = excluded.audio_position_sec,
           is_playing = excluded.is_playing,
           auto_flip_enabled = excluded.auto_flip_enabled,
           daily_limit_minutes = excluded.daily_limit_minutes,
           minutes_used_today = excluded.minutes_used_today,
           last_activity_date = excluded.last_activity_date,
           active_device_id = excluded.active_device_id,
           updated_at = excluded.updated_at`
      )
      .bind(
        familyUserId,
        updated.activeKidId,
        updated.activeBookSlug,
        updated.activeFormat,
        updated.chapterIndex,
        updated.pageIndex,
        updated.audioPositionSec,
        updated.isPlaying ? 1 : 0,
        updated.autoFlipEnabled ? 1 : 0,
        updated.dailyLimitMinutes,
        updated.minutesUsedToday,
        today,
        updated.activeDeviceId,
        updated.updatedAt
      )
      .run();
  }

  return updated;
}

/**
 * Guardrailed "Talk to the Cast" Story Companion:
 * - Strictly scoped to Big Brain Shelf characters (`Fern`, `Mira`, `Penny`, `Wally`, `Basil`) and book canon.
 * - Routes via Vercel AI Gateway (`VERCEL_AI_GATEWAY_URL`) when configured, with deterministic
 *   story-grounded canon responses (`source: "story_canon_scaffolding"`) when offline.
 */
export async function askCastCompanion(params: {
  db?: D1Database;
  userId: string;
  /** The caller's own kid profile id (a UUID string; ownership is
   * verified by the route, F6). */
  kidProfileId?: string | null;
  bookSlug: string;
  characterName?: string;
  questionText: string;
  vercelAiGatewayUrl?: string;
  vercelAiGatewayKey?: string;
}): Promise<CastCompanionReply> {
  const requestedName = (params.characterName || "Fern").trim();
  const avatar =
    KID_AVATARS.find((a) => a.name.toLowerCase() === requestedName.toLowerCase()) ||
    KID_AVATARS.find((a) => a.id === "fern") ||
    KID_AVATARS[0];

  const cleanQuestion = (params.questionText || "").trim().slice(0, 280);
  const canonFacts = await retrieveCanonContinuity(
    `${avatar.name} ${params.bookSlug} ${cleanQuestion}`,
    { DB: params.db },
    3
  );

  const moral =
    canonFacts[0]?.factText ||
    "Look closely. Nature and everyday life are full of quiet patterns waiting to be noticed.";

  let responseText = "";
  let source: CastCompanionReply["source"] = "story_canon_scaffolding";

  if (params.vercelAiGatewayUrl && params.vercelAiGatewayKey) {
    try {
      const res = await fetch(params.vercelAiGatewayUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${params.vercelAiGatewayKey}`,
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content: `You are ${avatar.name} (${avatar.label}) from Big Brain Shelf. Keep replies under 3 warm sentences for ages 5-9. Never discuss anything outside the story canon. Canon context: ${moral}`,
            },
            { role: "user", content: cleanQuestion || "Tell me about the story!" },
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const gatewayReply = data?.choices?.[0]?.message?.content?.trim();
        if (gatewayReply) {
          responseText = gatewayReply;
          source = "vercel_ai_gateway";
        }
      }
    } catch {
      // Fall back to deterministic story-grounded response
    }
  }

  if (!responseText) {
    if (avatar.name === "Fern") {
      responseText = `*Fern flicks her tail and grins.* When you asked "${cleanQuestion || "how the pattern works"}", it reminded me of the clever trails we follow, one smart step at a time. ${moral}`;
    } else if (avatar.name === "Mira") {
      responseText = `*Mira stands tall in the still water and smiles.* Great question! Watching and waiting by the pond, I learned that ${moral}`;
    } else if (avatar.name === "Wally") {
      responseText = `*Wally taps a neat wooden container.* Down at the harbour, we tested that exact idea! ${moral}`;
    } else {
      responseText = `*${avatar.name} (${avatar.label}) nods thoughtfully.* ${moral}`;
    }
  }

  const badge = `${avatar.name}'s Pattern Spotter`;

  if (params.db) {
    await ensureFamilySyncSchema(params.db);
    await params.db
      .prepare(
        `INSERT INTO cast_companion_sessions
          (user_id, kid_profile_id, book_slug, character_name, question_text, response_text, comprehension_badge, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.userId,
        params.kidProfileId ?? null,
        params.bookSlug || "fern-counts-the-forest",
        avatar.name,
        cleanQuestion || "Story reflection",
        responseText,
        badge,
        new Date().toISOString()
      )
      .run();
  }

  return {
    characterName: avatar.name,
    characterRole: avatar.label,
    bookSlug: params.bookSlug || "fern-counts-the-forest",
    questionText: cleanQuestion,
    responseText,
    comprehensionBadge: badge,
    followUpPrompt: "Where did you spot a pattern or big idea in today's chapter?",
    source,
  };
}

export async function listCastCompanionBadges(
  db: D1Database | undefined,
  userId: string
): Promise<Array<{ characterName: string; bookSlug: string; badge: string; createdAt: string }>> {
  if (!db) return [];
  await ensureFamilySyncSchema(db);
  const rows = await db
    .prepare(
      `SELECT character_name, book_slug, comprehension_badge, created_at
       FROM cast_companion_sessions
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 12`
    )
    .bind(userId)
    .all<{
      character_name: string;
      book_slug: string;
      comprehension_badge: string;
      created_at: string;
    }>();

  return (rows.results || []).map((r) => ({
    characterName: r.character_name,
    bookSlug: r.book_slug,
    badge: r.comprehension_badge || "Forest Explorer",
    createdAt: r.created_at,
  }));
}
