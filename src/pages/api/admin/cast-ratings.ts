import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

// Admin verdicts for the Audio Cast audition tool (/admin/cast).
// One row per (voice_model, lang): CG's No / Maybe / Yes for each voice,
// kept in D1 so the verdicts follow him across phone and desktop.
//
// GET  -> { ratings: [{ voice_model, lang, verdict }] }
// POST { voice_model, lang, verdict }  verdict: "no" | "maybe" | "yes";
//      an empty verdict clears the row.

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS cast_ratings (
  voice_model TEXT NOT NULL,
  lang TEXT NOT NULL,
  verdict TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (voice_model, lang)
)`;

function guard(locals: any) {
  return !(locals as any)?.user;
}

export const GET: APIRoute = async ({ locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  await e.DB.prepare(CREATE_SQL).run();
  const rows = await e.DB.prepare(
    "SELECT voice_model, lang, verdict FROM cast_ratings ORDER BY lang, voice_model"
  ).all();
  return Response.json({ ratings: rows.results || [] });
};

export const POST: APIRoute = async ({ request, locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  const body = await request.json().catch(() => ({}));
  const voiceModel = String(body?.voice_model || "");
  const lang = String(body?.lang || "en").toLowerCase();
  const verdict = String(body?.verdict || "").toLowerCase();
  if (!voiceModel) return Response.json({ error: "Missing voice_model" }, { status: 400 });

  await e.DB.prepare(CREATE_SQL).run();
  if (!verdict) {
    await e.DB.prepare("DELETE FROM cast_ratings WHERE voice_model = ? AND lang = ?")
      .bind(voiceModel, lang).run();
    return Response.json({ ok: true, cleared: true });
  }
  if (!["no", "maybe", "yes"].includes(verdict)) {
    return Response.json({ error: "verdict must be no, maybe, or yes" }, { status: 400 });
  }
  await e.DB.prepare(
    `INSERT INTO cast_ratings (voice_model, lang, verdict, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(voice_model, lang) DO UPDATE SET verdict = excluded.verdict, updated_at = excluded.updated_at`
  ).bind(voiceModel, lang, verdict, Math.floor(Date.now() / 1000)).run();
  return Response.json({ ok: true, voice_model: voiceModel, lang, verdict });
};
