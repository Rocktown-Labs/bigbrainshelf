import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  getEffectiveSession,
  checkUsernameAvailabilityInDb,
  updateUserUsernameInDb,
} from "../../../lib/auth";

export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const GET: APIRoute = async ({ request, locals }) => {
  const db = (env as any)?.DB;
  const session = await getEffectiveSession(request, locals, db);
  return json({
    ok: true,
    user: session?.user || null,
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const db = (env as any)?.DB;
  const session = await getEffectiveSession(request, locals, db);
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = String(body.action || "check_username");

  if (action === "check_username") {
    const check = await checkUsernameAvailabilityInDb(
      db,
      String(body.username || ""),
      session?.user?.id || null
    );
    return json({
      ok: true,
      available: check.available,
      normalized: check.normalized,
      displayUsername: check.displayUsername,
      error: check.error || null,
    });
  }

  if (!session?.user?.id) {
    return json({ error: "Sign in required" }, 401);
  }

  if (action === "update_username" || action === "update_account") {
    const res = await updateUserUsernameInDb(
      db,
      session.user.id,
      body.username,
      body.name
    );
    if (!res.ok) {
      return json({ ok: false, error: res.error || "Could not update username" }, 400);
    }
    const refreshed = await getEffectiveSession(request, locals, db);
    return json({
      ok: true,
      username: res.username,
      displayUsername: res.displayUsername,
      user: refreshed?.user || session.user,
    });
  }

  return json({ error: "Unknown action" }, 400);
};
