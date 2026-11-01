import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getEffectiveSession } from "../../../lib/auth";
import { askCastCompanion, listCastCompanionBadges } from "../../../lib/family-sync";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const session = await getEffectiveSession(request, locals, e.DB);
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }
  const badges = await listCastCompanionBadges(e.DB, String(session.user.id));
  return Response.json({ ok: true, badges });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const session = await getEffectiveSession(request, locals, e.DB);
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, any>;
  const reply = await askCastCompanion({
    db: e.DB,
    userId: String(session.user.id),
    kidProfileId: body.kidProfileId ? Number(body.kidProfileId) : null,
    bookSlug: String(body.bookSlug || "fern-counts-the-forest"),
    characterName: String(body.characterName || "Fern"),
    questionText: String(body.questionText || "Where did you spot a pattern in the forest?"),
    vercelAiGatewayUrl: e.VERCEL_AI_GATEWAY_URL,
    vercelAiGatewayKey: e.VERCEL_AI_GATEWAY_KEY,
  });

  return Response.json({ ok: true, reply });
};
