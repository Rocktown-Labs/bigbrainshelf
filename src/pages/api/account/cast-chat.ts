import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getEffectiveSession } from "../../../lib/auth";
import { askCastCompanion, listCastCompanionBadges } from "../../../lib/family-sync";
import { checkRateLimit } from "../../../lib/rate-limit";

export const prerender = false;

// SECURITY + abuse (F6, 2026-10-31): this route calls a PAID AI
// gateway (gemini-2.5-flash via the Vercel AI Gateway) and answers
// child-facing questions, so every request costs money and every
// reply is seen by a kid. Hardening before any UI ships:
//   - per-user rate limit (6/minute) and daily quota (30/day);
//   - the book slug must exist in the catalog;
//   - a kid profile id, when sent, must belong to the caller;
//   - question length stays capped in the lib (280 chars).
// TODO(output filter) before the companion UI ships: an output
// allowlist on top of the system prompt, per SECURITY-FINDINGS F6.

const PER_MINUTE = 6;
const PER_DAY = 30;

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
  const userId = String(session.user.id);

  // F6: cost abuse guard — a looping client cannot spend the store's
  // AI gateway budget. Minute window for burst, day window for quota.
  const [perMinute, perDay] = await Promise.all([
    checkRateLimit(e.DB, `cast_chat:min:${userId}`, PER_MINUTE, 60),
    checkRateLimit(e.DB, `cast_chat:day:${userId}`, PER_DAY, 24 * 60 * 60),
  ]);
  if (!perMinute.ok || !perDay.ok) {
    const wait = Math.max(perMinute.retryAfterSec, perDay.retryAfterSec);
    const which = !perDay.ok ? "daily" : "minute";
    return Response.json(
      { error: perDay.ok ? `Slow down — ${PER_MINUTE} questions per minute.` : `That is all for today — ${PER_DAY} questions per day.` },
      { status: 429, headers: { "Retry-After": String(wait), "X-Rate-Limit": which } }
    );
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, any>;

  // F6: the book must exist in the catalog — the companion may only
  // discuss a real book, never an arbitrary prompt context.
  const bookSlug = String(body.bookSlug || "fern-counts-the-forest").trim().slice(0, 120);
  if (bookSlug) {
    const book = await e.DB
      .prepare("SELECT slug FROM books WHERE slug = ? LIMIT 1")
      .bind(bookSlug)
      .first()
      .catch(() => null);
    if (!book) {
      return Response.json({ error: "Unknown book." }, { status: 400 });
    }
  }

  // F6: a kid profile id, when the client sends one, must be the
  // caller's own profile (it is stored on the session row). Profile
  // ids are UUID strings; a foreign id is refused, never recorded.
  let kidProfileId: string | null = null;
  const rawKidId = body.kidProfileId !== undefined && body.kidProfileId !== null
    ? String(body.kidProfileId).trim()
    : "";
  if (rawKidId) {
    const kid = await e.DB
      .prepare("SELECT id FROM kid_profiles WHERE id = ? AND user_id = ? LIMIT 1")
      .bind(rawKidId, userId)
      .first()
      .catch(() => null);
    if (!kid) {
      return Response.json({ error: "Unknown kid profile." }, { status: 400 });
    }
    kidProfileId = rawKidId;
  }

  const reply = await askCastCompanion({
    db: e.DB,
    userId,
    kidProfileId,
    bookSlug,
    characterName: String(body.characterName || "Fern"),
    questionText: String(body.questionText || "Where did you spot a pattern in the forest?"),
    vercelAiGatewayUrl: e.VERCEL_AI_GATEWAY_URL,
    vercelAiGatewayKey: e.VERCEL_AI_GATEWAY_KEY,
  });

  return Response.json({ ok: true, reply });
};
