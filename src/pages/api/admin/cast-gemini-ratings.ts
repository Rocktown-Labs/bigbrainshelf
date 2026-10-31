import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

// Admin verdicts for the Gemini A Team audition tool (/admin/cast-gemini).
// A parallel table to cast_ratings (the Aura B Team's), so Gemini
// verdicts can never collide with or disturb Aura's saved rows.
//
// GET  -> { ratings: [{ voice_id, lang, verdict }] }
// POST { voice_id, lang, verdict }  verdict: "no" | "maybe" | "yes";
//      an empty verdict clears the row.

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS cast_ratings_gemini (
  voice_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  verdict TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (voice_id, lang)
)`;

function guard(locals: any) {
  return !(locals as any)?.user;
}

export const GET: APIRoute = async ({ locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  await e.DB.prepare(CREATE_SQL).run();
  const rows = await e.DB.prepare(
    "SELECT voice_id, lang, verdict FROM cast_ratings_gemini ORDER BY lang, voice_id"
  ).all();
  return Response.json({ ratings: rows.results || [] });
};

export const POST: APIRoute = async ({ request, locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  const body = await request.json().catch(() => ({}));
  const voiceId = String(body?.voice_id || "");
  const lang = String(body?.lang || "en").toLowerCase();
  const verdict = String(body?.verdict || "").toLowerCase();
  if (!voiceId) return Response.json({ error: "Missing voice_id" }, { status: 400 });

  await e.DB.prepare(CREATE_SQL).run();
  if (!verdict) {
    await e.DB.prepare("DELETE FROM cast_ratings_gemini WHERE voice_id = ? AND lang = ?")
      .bind(voiceId, lang).run();
    return Response.json({ ok: true, cleared: true });
  }
  if (!["no", "maybe", "yes"].includes(verdict)) {
    return Response.json({ error: "verdict must be no, maybe, or yes" }, { status: 400 });
  }
  await e.DB.prepare(
    `INSERT INTO cast_ratings_gemini (voice_id, lang, verdict, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(voice_id, lang) DO UPDATE SET verdict = excluded.verdict, updated_at = excluded.updated_at`
  ).bind(voiceId, lang, verdict, Math.floor(Date.now() / 1000)).run();
  return Response.json({ ok: true, voice_id: voiceId, lang, verdict });
};
