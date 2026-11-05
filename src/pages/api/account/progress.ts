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
    audio_elapsed_sec: body.audio_elapsed_sec,
    audio_total_sec: body.audio_total_sec,
    reader_total_pages: body.reader_total_pages,
    sync_enabled: body.sync_enabled,
    elapsed_minutes_delta: body.elapsed_minutes_delta,
  });

  // Sync cross-device FamilyRoom state, reading telemetry, and 80% completion upsell check
  try {
    await updateFamilySyncState(
      db,
      userId,
      {
        activeBookSlug: String(body.book_slug),
        activeFormat: body.view_edition === "readalong" ? "read_along" : "story",
        chapterIndex: Number(body.chapter_num || 0),
        pageIndex: Number(body.page_index || 0),
        audioPositionSec: Number(body.audio_position_sec || 0),
        autoFlipEnabled: body.sync_enabled !== false,
        elapsedMinutesDelta: Number(body.elapsed_minutes_delta || 0),
      },
      env as any
    );

    await recordReadingTelemetry(env as any, {
      userId,
      bookSlug: String(body.book_slug),
      chapterIndex: Number(body.chapter_num || 0),
      pageIndex: Number(body.page_index || 0),
      eventType: body.view_edition === "readalong" ? "read_along_flip" : "page_view",
      dwellSeconds: Number(body.elapsed_minutes_delta || 0) * 60,
      format: body.view_edition === "readalong" ? "read_along" : "story",
    });

    const totalPages = Math.max(1, Number(body.total_pages || 24));
    const pageIdx = Number(body.page_index || 0);
    const audioDur = Number(body.audio_duration_sec || 0);
    const audioPos = Number(body.audio_position_sec || 0);
    const pctByPage = Math.round(((pageIdx + 1) / totalPages) * 100);
    const pctByAudio = audioDur > 0 ? Math.round((audioPos / audioDur) * 100) : 0;
    const percentComplete = Math.max(pctByPage, pctByAudio);

    if (percentComplete >= 80 && session.user.email) {
      await checkAndEnqueueCompletionUpsell({
        db,
        userId,
        email: String(session.user.email),
        bookSlug: String(body.book_slug),
        percentComplete,
      });
    }
  } catch {
    // Telemetry & RevOps hooks are non-blocking
  }

  return json({
    ok: true,
    ...result,
  });
};
