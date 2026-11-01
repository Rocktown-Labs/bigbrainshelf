import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getEffectiveSession } from "../../../lib/auth";
import { applyClubRetentionAction, type ClubRetentionAction } from "../../../lib/revops";

export const prerender = false;

// POST /api/club/retention
// Self-serve Club churn-save & upgrade actions grounded in `src/lib/offers.ts`:
//   - "skip_next_box": Pushes a physical Book Club ($60/quarter or $199/year) next box anchor out by 3 months
//   - "switch_to_audio_club": Downsells physical Book Club ($60/quarter) to The Audio Club ($5.99/month)
//   - "upgrade_to_annual": Upgrades quarterly ($60/qtr -> $199/yr) or monthly ($5.99/mo -> $49/yr) to Annual
export const POST: APIRoute = async ({ request, locals }) => {
  const db = (env as any).DB;
  const session = await getEffectiveSession(request, locals, db);
  if (!session?.user?.id || !session?.user?.email) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }

  const body: any = await request.json().catch(() => ({}));
  const action = String(body?.action || "") as ClubRetentionAction;
  if (!["skip_next_box", "switch_to_audio_club", "upgrade_to_annual"].includes(action)) {
    return Response.json({ error: "Invalid retention action" }, { status: 400 });
  }

  const result = await applyClubRetentionAction(
    db,
    { id: String(session.user.id), email: String(session.user.email) },
    action
  );
  if (!result.ok) {
    return Response.json({ error: result.error || "Could not update membership" }, { status: 400 });
  }
  return Response.json(result);
};
