import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { findVoice, respellForTts, sha256Hex, auditionCacheKey, workersAiModelId } from "../../../lib/cast";

// Admin voice audition generation. Gated by the middleware's admin session
// cookie, with the locals.user check as defense in depth (same pattern as
// /api/admin/orders).
//
// POST { speaker, lang, text }
//   -> 200 audio/wav bytes, X-Cast-Cache: hit | miss
// Audio is generated once per (language, voice, text) with Cloudflare
// Workers AI (binding AI, model @cf/deepgram/aura-2-{lang}) and cached in
// the BOOKS R2 bucket under cast-auditions/, so replays are instant on
// every device. English text is respelled for the TTS model first (the
// promo pipeline's map in src/lib/cast.ts); other languages go as-is.

function guard(locals: any) {
  return !(locals as any)?.user;
}

// Workers AI binding results come back in different shapes depending on the
// model: raw bytes, a stream, a Response, or JSON with base64 audio.
async function extractAudio(result: any): Promise<ArrayBuffer | null> {
  if (!result) return null;
  if (result instanceof ArrayBuffer) return result;
  if (result instanceof Uint8Array) return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
  if (typeof result === "object") {
    if (typeof result.audio === "string") {
      const bin = atob(result.audio);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer as ArrayBuffer;
    }
    if (result instanceof ReadableStream || typeof result.arrayBuffer === "function") {
      try { return await new Response(result as any).arrayBuffer(); } catch { return null; }
    }
  }
  return null;
}

function audioResponse(buf: ArrayBuffer, cache: string) {
  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(buf.byteLength),
      "X-Cast-Cache": cache,
      "Cache-Control": "private, no-store",
    },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  const body = await request.json().catch(() => ({}));
  const lang = String(body?.lang || "en").toLowerCase();
  const speaker = String(body?.speaker || "").toLowerCase();
  const text = String(body?.text || "").trim();

  const voice = findVoice(lang, speaker);
  if (!voice) return Response.json({ error: `Unknown voice "${speaker}" for language "${lang}"` }, { status: 400 });
  if (!text) return Response.json({ error: "Missing text" }, { status: 400 });
  if (text.length > 600) return Response.json({ error: "Snippet too long (600 character limit)" }, { status: 400 });

  const ttsText = respellForTts(text, lang);
  const hash = await sha256Hex(ttsText);
  const key = auditionCacheKey(lang, speaker, hash);

  // Replay from the R2 cache when this exact read already exists.
  try {
    const hit = await e.BOOKS.get(key);
    if (hit) return audioResponse(await hit.arrayBuffer(), "hit");
  } catch { /* cache read failure should not block generation */ }

  if (!e.AI) {
    return Response.json({
      error: "Voice generation is not switched on yet: the worker has no Workers AI binding (AI). Add the AI binding in deploy.py and redeploy.",
    }, { status: 501 });
  }

  let audio: ArrayBuffer | null = null;
  try {
    const result = await e.AI.run(workersAiModelId(lang), {
      text: ttsText,
      speaker,
      encoding: "linear16",
      container: "wav",
    });
    audio = await extractAudio(result);
  } catch (err: any) {
    return Response.json({
      error: "Voice generation failed",
      detail: String(err?.message || err).slice(0, 300),
    }, { status: 502 });
  }
  if (!audio || audio.byteLength === 0) {
    return Response.json({ error: "Voice generation returned no audio" }, { status: 502 });
  }

  try {
    await e.BOOKS.put(key, audio, { httpMetadata: { contentType: "audio/wav" } });
  } catch { /* a cache write failure should not block playback */ }

  return audioResponse(audio, "miss");
};
