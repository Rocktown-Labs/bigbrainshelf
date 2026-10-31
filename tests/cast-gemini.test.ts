// Focused tests for the Gemini A Team cast helpers (src/lib/cast-gemini.ts)
// and the roster in src/data/cast/gemini-voices.json.
// Run with: bun tests/cast-gemini.test.ts
import {
  geminiVoices,
  featuredGeminiVoices,
  findGeminiVoice,
  geminiTtsText,
  geminiAuditionCacheKey,
  GEMINI_TTS_MODEL,
  GEMINI_GATEWAY_SECRET,
} from "../src/lib/cast-gemini";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

// Roster shape: 8 featured (storyteller shortlist + Kore) and the wider
// studio set (30 studio voices total, 3 of them featured, so 27 more).
const all = geminiVoices();
const featured = featuredGeminiVoices();
assert(all.length === 35, `roster holds 35 voices (got ${all.length})`);
assert(featured.length === 8, `8 featured voices (got ${featured.length})`);
const ids = all.map((v) => v.id);
assert(new Set(ids).size === ids.length, "voice ids are unique");
const studio = all.filter((v) => v.kind === "studio");
assert(studio.length + featured.filter((v) => v.kind === "storyteller").length >= 30, "studio set present");

// The featured shortlist CG surfaced from AI Studio, with resolved
// generation identifiers (library voices carry en-us-* ids from
// GET /v1beta/voices; studio voices generate by name).
const expect: Record<string, string> = {
  kore: "Kore",
  fola: "en-us-fola",
  zali: "en-us-zali",
  sami: "en-us-sami",
  enzo: "en-us-enzo",
  riko: "en-us-riko",
  achird: "Achird",
  zubenelgenubi: "Zubenelgenubi",
};
for (const [id, voice] of Object.entries(expect)) {
  const v = findGeminiVoice(id);
  assert(!!v && v.featured && v.voice === voice, `${id} featured, generates as "${voice}"`);
}
assert(findGeminiVoice("nosuchvoice") === null, "unknown voice rejected");

// CG's note: Sami and Zali are the female storytellers. (Google's library
// metadata also lists Fola as female; all three carry the API's gender.)
assert(findGeminiVoice("sami")?.gender === "feminine", "sami marked feminine");
assert(findGeminiVoice("zali")?.gender === "feminine", "zali marked feminine");
assert(findGeminiVoice("enzo")?.gender === "masculine", "enzo marked masculine");
assert(findGeminiVoice("riko")?.traits.join(" ") === "Confident and clear", "riko traits from CG's shortlist");
assert(findGeminiVoice("zali")?.traits.join(" ") === "Warm and empathetic", "zali traits from CG's shortlist");

// TTS text: display text clean, only the EPUB IPA assist.
assert(geminiTtsText("Big Brain Shelf presents: Mira.") === "Big Brain Shelf presents: Mira.", "no respellings on the Gemini path");
assert(geminiTtsText("and the EPUB, out now") === "and the /ˈiː.pʌb/, out now", "EPUB becomes inline IPA");
assert(geminiTtsText("EPUBs are files") === "EPUBs are files", "word boundary respected");

// Cache key + constants
assert(geminiAuditionCacheKey("enzo", "abc123") === "cast-auditions-gemini/en/enzo/abc123.wav", "gemini cache key shape");
assert(GEMINI_TTS_MODEL === "google/gemini-3.8-flash-tts", "gateway model slug");
assert(GEMINI_GATEWAY_SECRET === "AI_GATEWAY_API_KEY", "on-demand secret name");

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nAll Gemini cast tests passed.");
