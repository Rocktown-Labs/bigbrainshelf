import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getEffectiveSession } from "../../../lib/auth";
import { applyClubRetentionAction, type RetentionAction } from "../../../lib/revops";

export const prerender = false;

const VALID_ACTIONS = new Set<RetentionAction>([
  "skip_next_box",
  "switch_to_audio_club_monthly",
  "switch_to_audio_club_annual",
  "upgrade_book_club_annual",
  "upgrade_audio_club_annual",
]);

export const POST: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const session = await getEffectiveSession(request, locals, e.DB);
  if (!session?.user?.id || !session?.user?.email) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, any>;
  const action = String(body.action || "") as RetentionAction;
  if (!VALID_ACTIONS.has(action)) {
    return Response.json({ error: "Invalid retention action" }, { status: 400 });
  }

  const result = await applyClubRetentionAction({
    db: e.DB,
    userId: String(session.user.id),
    email: String(session.user.email),
    action,
  });

  return Response.json(result);
};
