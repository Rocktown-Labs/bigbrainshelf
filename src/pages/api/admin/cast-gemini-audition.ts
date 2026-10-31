import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import {
  findGeminiVoice,
  featuredGeminiVoices,
  geminiTtsText,
  geminiAuditionCacheKey,
  GEMINI_TTS_MODEL,
  GEMINI_GATEWAY_SPEECH_URL,
  GEMINI_AUDITION_STYLE,
  GEMINI_GATEWAY_SECRET,
} from "../../../lib/cast-gemini";
import { sha256Hex } from "../../../lib/cast";

// Admin Gemini voice auditions for the A Team cast page
// (/admin/cast-gemini). Gated by the middleware's admin session cookie,
// with the locals.user check as defense in depth (same pattern as the
// Aura B Team endpoint).
//
// GET  -> { generation: "connected" | "not_connected", secret, featured }
//         so the page can show a plain "key not connected" state for
//         on-demand rows instead of a broken button.
// POST { voice, text, book? }
//   -> 200 audio/wav bytes, X-Cast-Cache: hit | miss
// The optional book slug namespaces the cache key per book
// (cast-auditions-gemini/{book}/{voice}/{hash}.wav) for line sets derived
// from that book's chapters; without it the legacy key applies, which is
// where Mira's featured auditions are pre-generated.
// Audio is generated once per (voice, text) with Gemini 3.8 Flash TTS
// (Vercel AI Gateway speech route) and cached in the BOOKS R2 bucket
// under cast-auditions-gemini/. Featured voices are pre-generated from
// the VM, so their plays are cache hits with no worker secret involved.
// On-demand generation for the wider roster needs the worker secret
// AI_GATEWAY_API_KEY (a Vercel AI Gateway key); until it exists, a cache
// miss answers 501 with code "generation_not_connected".

function guard(locals: any) {
  return !(locals as any)?.user;
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer as ArrayBuffer;
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

export const GET: APIRoute = async ({ locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  return Response.json({
    generation: e[GEMINI_GATEWAY_SECRET] ? "connected" : "not_connected",
    secret: GEMINI_GATEWAY_SECRET,
    featured: featuredGeminiVoices().map((v) => v.id),
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  const body = await request.json().catch(() => ({}));
  const voiceId = String(body?.voice || "").toLowerCase();
  const text = String(body?.text || "").trim();
  const book = String(body?.book || "").trim();

  const voice = findGeminiVoice(voiceId);
  if (!voice) return Response.json({ error: `Unknown Gemini voice "${voiceId}"` }, { status: 400 });
  if (!text) return Response.json({ error: "Missing text" }, { status: 400 });
  if (text.length > 600) return Response.json({ error: "Snippet too long (600 character limit)" }, { status: 400 });
  if (book && !/^[A-Za-z0-9_-]+$/.test(book)) {
    return Response.json({ error: "bad book slug" }, { status: 400 });
  }

  const ttsText = geminiTtsText(text);
  const hash = await sha256Hex(ttsText);
  const key = book
    ? `cast-auditions-gemini/${book}/${voice.id}/${hash}.wav`
    : geminiAuditionCacheKey(voice.id, hash);

  // Replay from the R2 cache when this exact read already exists. This
  // is the normal path for every featured voice.
  try {
    const hit = await e.BOOKS.get(key);
    if (hit) return audioResponse(await hit.arrayBuffer(), "hit");
  } catch { /* cache read failure should not block generation */ }

  const apiKey = e[GEMINI_GATEWAY_SECRET];
  if (!apiKey) {
    return Response.json({
      error: `Voice generation key not connected yet: add the ${GEMINI_GATEWAY_SECRET} secret to the worker to voice new Gemini auditions on demand. Featured voices are pre-generated and play instantly.`,
      code: "generation_not_connected",
    }, { status: 501 });
  }

  let audio: ArrayBuffer | null = null;
  try {
    const res = await fetch(GEMINI_GATEWAY_SPEECH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "ai-model-id": GEMINI_TTS_MODEL,
        "ai-speech-model-specification-version": "4",
        "ai-gateway-protocol-version": "0.0.1",
      },
      body: JSON.stringify({ text: ttsText, voice: voice.voice, instructions: GEMINI_AUDITION_STYLE }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      return Response.json({ error: "Voice generation failed", detail: `gateway ${res.status}: ${detail}` }, { status: 502 });
    }
    const j: any = await res.json().catch(() => ({}));
    if (j?.audio) audio = base64ToBuffer(String(j.audio));
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
