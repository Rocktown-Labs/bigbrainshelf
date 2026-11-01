import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getEffectiveSession } from "../../../lib/auth";
import { getFamilySyncState, updateFamilySyncState } from "../../../lib/family-sync";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const db = (env as any).DB;
  const session = await getEffectiveSession(request, locals, db);
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }
  const state = await getFamilySyncState(db, String(session.user.id));
  return Response.json({ ok: true, state });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const db = (env as any).DB;
  const session = await getEffectiveSession(request, locals, db);
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }
  const body: any = await request.json().catch(() => ({}));
  const state = await updateFamilySyncState(db, String(session.user.id), {
    active_profile_id: body.active_profile_id,
    active_book_slug: body.active_book_slug,
    chapter_num: body.chapter_num,
    page_index: body.page_index,
    view_edition: body.view_edition,
    audio_track_id: body.audio_track_id,
    audio_position_sec: body.audio_position_sec,
    is_playing: body.is_playing,
    sleep_remaining_sec: body.sleep_remaining_sec,
    daily_limit_reached: body.daily_limit_reached,
    device_id: body.device_id,
    device_label: body.device_label,
  });
  return Response.json({ ok: true, state });
};
