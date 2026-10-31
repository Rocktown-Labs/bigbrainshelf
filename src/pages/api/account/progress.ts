import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getEffectiveSession } from "../../../lib/auth";
import {
  getReadingProgress,
  listReadingProgress,
  saveReadingProgress,
} from "../../../lib/family";

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

  return json({
    ok: true,
    ...result,
  });
};
