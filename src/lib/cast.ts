// Audio Cast: shared helpers for the voice audition tool (/admin/cast).
// The respelling map is the same one the promo pipeline uses (tts_gen3.py):
// it changes only what the TTS model hears, never the displayed text.
import voicesData from "../data/cast/voices.json";
import snippetsData from "../data/cast/snippets.json";

export interface CastVoice {
  model: string;
  name: string;
  featured: boolean;
  gender: string;
  age: string;
  accent: string;
  characteristics: string[];
  use_cases: string[];
  codeswitching?: boolean;
}

export interface CastSnippet {
  id: string;
  label: string;
  character: string;
  lang: string;
  text: string;
}

export const CAST_LANGS = Object.keys((voicesData as any).languages || {});

export function voicesForLang(lang: string): CastVoice[] {
  const list = ((voicesData as any).languages || {})[lang] || [];
  return list as CastVoice[];
}

export function findVoice(lang: string, speaker: string): CastVoice | null {
  const name = String(speaker || "").toLowerCase();
  return voicesForLang(lang).find((v) => v.name === name) || null;
}

export function castBooks(): { id: string; title: string; snippets: CastSnippet[] }[] {
  return (snippetsData as any).books || [];
}

// English-only pronunciation insurance for Aura-2. Whole-word replacements,
// mirroring kidsbook-video/tts_gen3.py: presents -> prezents, EPUB -> ee-puhb,
// bigbrainshelf.com -> "big brain shelf dot com", Mira -> Meera.
export function respellForTts(text: string, lang: string): string {
  if (lang !== "en") return text;
  return text
    .replace(/bigbrainshelf\.com/gi, "big brain shelf dot com")
    .replace(/\bEPUB\b/g, "ee-puhb")
    .replace(/\bpresents\b/gi, (m) => (m.charAt(0) === "P" ? "Prezents" : "prezents"))
    .replace(/\bMira\b/g, "Meera");
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// R2 cache key for one generated audition. The hash is of the TTS text (what
// is actually spoken), so a respelling change produces fresh audio.
export function auditionCacheKey(lang: string, speaker: string, ttsTextHash: string): string {
  return `cast-auditions/${lang}/${speaker}/${ttsTextHash}.wav`;
}

export function workersAiModelId(lang: string): string {
  return `@cf/deepgram/aura-2-${lang}`;
}
