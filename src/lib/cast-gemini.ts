// Audio Cast, A Team: shared helpers for the Gemini audition tool
// (/admin/cast-gemini). The B Team (Deepgram Aura-2) lives in cast.ts and
// is untouched by this module; the two teams share only the snippet set.
//
// Generation route: Gemini 3.8 Flash TTS through the Vercel AI Gateway
// native speech endpoint, the same route kidsbook-video/tts_voice.py
// uses in production. Featured voices' auditions are pre-generated from
// the VM into the BOOKS R2 bucket under cast-auditions-gemini/, so they
// play instantly with no worker secret. Non-featured voices generate on
// demand once the worker carries an AI_GATEWAY_API_KEY secret.
import geminiVoicesData from "../data/cast/gemini-voices.json";
import { castBooks, sha256Hex } from "./cast";

export interface GeminiVoice {
  id: string;
  name: string;
  // The exact voice identifier the speech route accepts: a studio voice
  // name ("Kore") or an Extended Voice Library id ("en-us-enzo").
  voice: string;
  kind: "storyteller" | "studio";
  featured: boolean;
  gender: string;
  traits: string[];
  pitch: string;
  accent: string;
  description: string;
}

export const GEMINI_TTS_MODEL = "google/gemini-3.8-flash-tts";
export const GEMINI_GATEWAY_SPEECH_URL = "https://ai-gateway.vercel.sh/v4/ai/speech-model";
export const GEMINI_CAST_LANG = "en";
// The worker secret that unlocks on-demand generation for non-featured
// voices. Featured auditions are pre-generated and never need it.
export const GEMINI_GATEWAY_SECRET = "AI_GATEWAY_API_KEY";

// House delivery for Gemini narration. Mirrors GEMINI_STYLE in
// kidsbook-video/tts_voice.py so auditions sound like production reads;
// Gemini keeps directions out of the transcript (instructions field).
export const GEMINI_AUDITION_STYLE =
  "Warm, bright book-trailer narrator for a children's picture book " +
  "promo: friendly storyteller energy, brisk upbeat pace, clear " +
  "diction, short pauses between sentences, smiling tone. This is a " +
  "45 second advertisement, not a bedtime read: keep it moving.";

export function geminiVoices(): GeminiVoice[] {
  return ((geminiVoicesData as any).voices || []) as GeminiVoice[];
}

export function featuredGeminiVoices(): GeminiVoice[] {
  return geminiVoices().filter((v) => v.featured);
}

export function findGeminiVoice(id: string): GeminiVoice | null {
  const key = String(id || "").toLowerCase();
  return geminiVoices().find((v) => v.id === key) || null;
}

export { castBooks };

// What Gemini actually hears. Display text goes in clean (Gemini handles
// pronunciation natively, so the Aura respellings do not apply); the one
// assist carried over from the pilot is EPUB as inline IPA, per CG's
// ruling, which the gateway read cleanly. Mirrored in Python by the
// pre-generation script (kidsbook-video/gen_cast_gemini.py) so both sides
// hash and cache the identical string.
export function geminiTtsText(text: string): string {
  return text.replace(/\bEPUB\b/g, "/ˈiː.pʌb/");
}

// R2 cache key for one generated Gemini audition. The hash is of the TTS
// text (what is actually spoken), same discipline as the Aura cache.
export function geminiAuditionCacheKey(voiceId: string, ttsTextHash: string): string {
  return `cast-auditions-gemini/${GEMINI_CAST_LANG}/${voiceId}/${ttsTextHash}.wav`;
}

export async function geminiAuditionKeyFor(voiceId: string, displayText: string): Promise<string> {
  return geminiAuditionCacheKey(voiceId, await sha256Hex(geminiTtsText(displayText)));
}
