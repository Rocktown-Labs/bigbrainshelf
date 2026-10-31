import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getAuth } from "../../../lib/auth";
import { getClubSignup } from "../../../lib/club";
import { saveClubSelection } from "../../../lib/club-cycles";

// POST /api/club/selection — a paid Book Club member chooses the
// books for one box, or returns a slot to "Surprise me".
// Body: { ship_date: "2026-11-15", selection: "<book slug>" | "surprise",
//         selection_2: "<book slug>" | "surprise" (optional second slot),
//         allow_repeat: boolean }
// Auth: the customer's better-auth session (the middleware passes this
// route through to self-authenticate, like /api/club/checkout). The
// member row is loaded by the session account's email, so a member can
// only ever change their own boxes. Owned titles are refused unless
// allow_repeat is explicitly set (see saveClubSelection).
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.email) {
    return json({ error: "Sign in to choose your book." }, 401);
  }
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const shipDate = String(body.ship_date || "");
  const selection = String(body.selection || "surprise");
  const hasSecond = body.selection_2 !== undefined && body.selection_2 !== null;
  const selection2 = hasSecond ? String(body.selection_2 || "surprise") : undefined;
  const allowRepeat = body.allow_repeat === true;

  const member = await getClubSignup(e.DB, session.user.email);
  if (!member) return json({ error: "No Book Club membership found for this account." }, 404);
  if (member.status !== "paid") {
    return json({ error: "Book choice opens once your membership is active." }, 403);
  }

  const result = await saveClubSelection(e.DB, {
    member,
    shipDate,
    bookSlug: selection === "surprise" ? null : selection,
    secondBookSlug: hasSecond ? (selection2 === "surprise" ? null : selection2) : undefined,
    allowRepeat,
  });
  if (!result.ok) return json({ error: result.error || "Could not save your pick." }, 400);
  return json({ ok: true, box: result.box });
};
