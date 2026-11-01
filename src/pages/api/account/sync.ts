import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getEffectiveSession } from "../../../lib/auth";
import { getFamilySyncState, updateFamilySyncState } from "../../../lib/family-sync";

export const prerender = false;

/**
 * GET / POST /api/account/sync
 * FamilyRoom real-time playback & Read-Along page sync endpoint.
 * - When `env.FAMILY_ROOM_DO` is bound and the client sends `Upgrade: websocket` (or `room=do`),
 *   forwards to the stateful `FamilyRoomDurableObject` instance for the family.
 * - Otherwise uses D1 `family_sync_rooms` polling scaffolding (`syncBackend: "d1_polling_scaffolding"`).
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const session = await getEffectiveSession(request, locals, e.DB);
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }
  const userId = String(session.user.id);

  if (e.FAMILY_ROOM_DO && request.headers.get("Upgrade") === "websocket") {
    const id = e.FAMILY_ROOM_DO.idFromName(userId);
    const stub = e.FAMILY_ROOM_DO.get(id);
    return stub.fetch(request);
  }

  const state = await getFamilySyncState(e.DB, userId, e);
  return Response.json({ ok: true, state });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const session = await getEffectiveSession(request, locals, e.DB);
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }
  const userId = String(session.user.id);
  const body = (await request.json().catch(() => ({}))) as Record<string, any>;

  const state = await updateFamilySyncState(
    e.DB,
    userId,
    {
      activeKidId: body.activeKidId !== undefined && body.activeKidId !== null
        ? String(body.activeKidId)
        : body.activeKidId === null
          ? null
          : undefined,
      activeBookSlug: body.activeBookSlug,
      activeFormat: body.activeFormat,
      chapterIndex: body.chapterIndex,
      pageIndex: body.pageIndex,
      audioPositionSec: body.audioPositionSec,
      isPlaying: body.isPlaying,
      autoFlipEnabled: body.autoFlipEnabled,
      dailyLimitMinutes: body.dailyLimitMinutes,
      elapsedMinutesDelta: body.elapsedMinutesDelta,
      activeDeviceId: body.activeDeviceId,
    },
    e
  );

  if (e.FAMILY_ROOM_DO) {
    try {
      const id = e.FAMILY_ROOM_DO.idFromName(userId);
      const stub = e.FAMILY_ROOM_DO.get(id);
      await stub.fetch("https://family-room.internal/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state),
      });
    } catch {
      // D1 state remains updated
    }
  }

  return Response.json({ ok: true, state });
};
