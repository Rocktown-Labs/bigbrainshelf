import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getEffectiveSession } from "../../../lib/auth";
import {
  getReadingProgress,
  listReadingProgress,
  saveReadingProgress,
} from "../../../lib/family";
import { updateFamilySyncState } from "../../../lib/family-sync";
import { recordReadingTelemetry } from "../../../lib/telemetry";
import { checkAndEnqueueCompletionUpsell } from "../../../lib/revops";

export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const GET: APIRoute = async ({ request, url, locals }) => {
  const db = (env as any).DB;
  const session = await getEffectiveSession(request, locals, db);
  if (!session?.user?.id) {
    return json({ error: "Sign in required" }, 401);
  }
  const userId = String(session.user.id);
  const profileId = url.searchParams.get("profile_id") || undefined;
  const bookSlug = url.searchParams.get("book_slug") || undefined;

  if (bookSlug) {
    const progress = await getReadingProgress(db, userId, profileId || "default", bookSlug);
    return json({ ok: true, progress });
  }

  const progressList = await listReadingProgress(db, userId, profileId);
  return json({ ok: true, progress: progressList });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const db = (env as any).DB;
  const session = await getEffectiveSession(request, locals, db);
  if (!session?.user?.id) {
    return json({ error: "Sign in required" }, 401);
  }
  const userId = String(session.user.id);

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.book_slug) {
    return json({ error: "book_slug is required" }, 400);
  }

  const result = await saveReadingProgress(db, userId, {
    profile_id: body.profile_id || "default",
    book_slug: String(body.book_slug),
    chapter_num: body.chapter_num,
    page_index: body.page_index,
    view_edition: body.view_edition,
    view_mode: body.view_mode,
    audio_track_id: body.audio_track_id,
    audio_position_sec: body.audio_position_sec,
    audio_duration_sec: body.audio_duration_sec,
    sync_enabled: body.sync_enabled,
    elapsed_minutes_delta: body.elapsed_minutes_delta,
  });

  // Update real-time cross-device Family Sync state & high-cardinality telemetry
  let completionPct = 0;
  try {
    await updateFamilySyncState(db, userId, {
      active_profile_id: String(body.profile_id || "default"),
      active_book_slug: String(body.book_slug),
      chapter_num: Number(body.chapter_num || 1),
      page_index: Number(body.page_index || 0),
      view_edition: String(body.view_edition || "story"),
      audio_track_id: String(body.audio_track_id || "ch1"),
      audio_position_sec: Number(body.audio_position_sec || 0),
      is_playing: Boolean(body.is_playing),
      daily_limit_reached: Boolean(result.limitReached),
      device_id: body.device_id ? String(body.device_id) : undefined,
      device_label: body.device_label ? String(body.device_label) : undefined,
    });
    const tel = await recordReadingTelemetry(db, env as any, {
      bookSlug: String(body.book_slug),
      chapterNum: Number(body.chapter_num || 1),
      pageIndex: Number(body.page_index || 0),
      edition: String(body.view_edition || "story"),
      audioPositionSec: Number(body.audio_position_sec || 0),
      audioDurationSec: Number(body.audio_duration_sec || 0),
      listenDeltaSec: Number(body.elapsed_minutes_delta || 0) * 60 || 15,
    });
    completionPct = tel.completionPct;
    if (tel.isCompleted80 && session.user.email) {
      const site = (env as any)?.BETTER_AUTH_URL || "https://bigbrainshelf.com";
      await checkAndEnqueueCompletionUpsell(db, site, {
        userId,
        userEmail: String(session.user.email),
        userName: session.user.name ? String(session.user.name) : null,
        bookSlug: String(body.book_slug),
        completionPct,
      });
    }
  } catch {}

  return json({
    ok: true,
    completionPct,
    ...result,
  });
};
