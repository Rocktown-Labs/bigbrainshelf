// Focused tests for the Audio Cast helpers (src/lib/cast.ts) and the
// curated data in src/data/cast/. Run with: bun tests/cast.test.ts
import {
  respellForTts,
  auditionCacheKey,
  workersAiModelId,
  findVoice,
  voicesForLang,
  castBooks,
  CAST_LANGS,
} from "../src/lib/cast";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

// Respelling map (English only, mirrors kidsbook-video/tts_gen3.py)
assert(respellForTts("Big Brain Shelf presents: Mira.", "en") === "Big Brain Shelf prezents: Meera.", "presents + Mira respelled");
assert(respellForTts("Presents are nice.", "en").startsWith("Prezents"), "capital Presents keeps its capital");
assert(respellForTts("Get the EPUB at bigbrainshelf.com", "en") === "Get the ee-puhb at big brain shelf dot com", "EPUB + domain respelled");
assert(respellForTts("Mira's legs wobbled.", "en") === "Meera's legs wobbled.", "possessive Mira respelled");
assert(respellForTts("Big Brain Shelf presents: Mira.", "es") === "Big Brain Shelf presents: Mira.", "non-English text untouched");

// Catalog integrity
assert(CAST_LANGS.length === 7, "seven languages in the catalog");
const total = CAST_LANGS.reduce((n, l) => n + voicesForLang(l).length, 0);
assert(total === 90, `catalog holds 90 voices (got ${total})`);
const thalia = findVoice("en", "thalia");
assert(!!thalia && thalia.featured && thalia.model === "aura-2-thalia-en", "thalia resolves as a featured English voice");
assert(findVoice("en", "andromeda")?.featured === true, "andromeda resolves as featured");
assert(!!findVoice("es", "estrella"), "estrella resolves for Spanish");
assert(findVoice("en", "nosuchvoice") === null, "unknown voice rejected");
assert(findVoice("es", "thalia") === null, "voice from the wrong language rejected");

// Snippet curation
const books = castBooks();
assert(books.length === 1 && books[0].id === "mira", "one book staged: Mira");
const snips = books[0].snippets;
const ids = snips.map((s) => s.id);
assert(new Set(ids).size === ids.length, "snippet ids are unique");
for (const need of ["presents", "narrator", "mira", "ansel", "dell", "otter", "problem"]) {
  assert(ids.includes(need), `snippet present: ${need}`);
}
const problem = snips.find((s) => s.id === "problem")!;
assert(/presents/.test(problem.text) && /EPUB/.test(problem.text) && /bigbrainshelf\.com/.test(problem.text), "problem snippet carries all three problem tokens");
for (const s of snips) {
  assert(s.text.length > 0 && s.text.length <= 600, `snippet ${s.id} within the generation length limit`);
  assert(!!s.character && !!s.label && s.lang === "en", `snippet ${s.id} fully tagged`);
}

// Cache key + model id shapes
assert(auditionCacheKey("en", "thalia", "abc123") === "cast-auditions/en/thalia/abc123.wav", "cache key shape");
assert(workersAiModelId("es") === "@cf/deepgram/aura-2-es", "Workers AI model id shape");

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nAll cast tests passed.");
