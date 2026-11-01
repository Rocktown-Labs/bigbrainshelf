import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getEffectiveSession } from "../../../lib/auth";
import {
  askCastCompanion,
  CAST_PERSONAS,
  listCastCompanionBadges,
} from "../../../lib/family-sync";

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const db = (env as any).DB;
  const session = await getEffectiveSession(request, locals, db);
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }
  const profileId = url.searchParams.get("profile_id") || undefined;
  const badges = await listCastCompanionBadges(db, String(session.user.id), profileId);
  return Response.json({
    ok: true,
    personas: Object.values(CAST_PERSONAS),
    badges,
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const db = e.DB;
  const session = await getEffectiveSession(request, locals, db);
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }
  const body: any = await request.json().catch(() => ({}));
  const characterSlug = String(body.character_slug || "mira");
  const question = String(body.question || "");
  const profileId = String(body.profile_id || "default");

  const reply = await askCastCompanion(db, e, {
    userId: String(session.user.id),
    profileId,
    characterSlug,
    question,
  });
  const badges = await listCastCompanionBadges(db, String(session.user.id), profileId);

  return Response.json({
    ok: true,
    ...reply,
    badges,
  });
};
