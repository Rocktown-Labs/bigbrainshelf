// Tests for the casting registry (src/lib/cast-registry.ts): casting is
// per CHARACTER and persistent. Pins the write path: seed inserts the
// recorded casts once and never overwrites a later admin assignment;
// assign writes registry + log + the R2 export; a voice change logs
// action "change"; re-assigning the same voice is a no-op; bibleCast
// reads both bible shapes; findCharacterLine pulls attributed dialogue.
//
// Run with: bun tests/cast-registry.test.ts
import {
  ensureCastTables,
  seedRecordedCasts,
  getRegistry,
  getAssignmentLog,
  assignVoice,
  exportRegistry,
  bibleCast,
  findCharacterLine,
  parsePageSegments,
  sceneSetForBook,
  sampleSegmentsFor,
  RECORDED_CASTS,
} from "../src/lib/cast-registry";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

/* ---------- in-memory D1 fake for the registry's SQL ---------- */
function fakeDb() {
  const voices = new Map<string, any>();
  const log: any[] = [];
  let logId = 0;
  function stmt(sql: string) {
    let binds: any[] = [];
    const api: any = {
      bind(...b: any[]) { binds = b; return api; },
      async run() {
        if (/CREATE TABLE/.test(sql)) return { meta: { changes: 0 } };
        if (/INSERT OR IGNORE INTO character_voices/.test(sql)) {
          const [name, vid, vname, slug, now] = binds;
          if (voices.has(name)) return { meta: { changes: 0 } };
          voices.set(name, { character_name: name, voice_id: vid, voice_name: vname, first_book_slug: slug, source: "recorded", updated_at: now });
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO character_voices/.test(sql)) {
          const [name, vid, vname, slug, now] = binds;
          const prev = voices.get(name);
          voices.set(name, {
            character_name: name, voice_id: vid, voice_name: vname,
            first_book_slug: prev?.first_book_slug ?? slug, source: "admin", updated_at: now,
          });
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO voice_assignment_log/.test(sql)) {
          const [name, vid, slug, action, now] = binds;
          log.push({ id: ++logId, character_name: name, voice_id: vid, book_slug: slug, action, created_at: now });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      async first() {
        if (/FROM character_voices WHERE character_name/.test(sql)) {
          return voices.get(binds[0]) ?? null;
        }
        return null;
      },
      async all() {
        if (/FROM voice_assignment_log/.test(sql)) {
          const limit = binds[0] ?? 50;
          return { results: [...log].sort((a, b) => b.id - a.id).slice(0, limit) };
        }
        if (/FROM character_voices/.test(sql)) {
          return { results: [...voices.values()].sort((a, b) => a.character_name.localeCompare(b.character_name)) };
        }
        return { results: [] };
      },
    };
    return api;
  }
  return { prepare: (sql: string) => stmt(sql), _voices: voices, _log: log };
}

function fakeBooks() {
  const store = new Map<string, string>();
  return {
    store,
    async get() { return null; },
    async put(key: string, value: any) { store.set(key, String(value)); },
  };
}

/* ---------- seed + registry ---------- */
const db = fakeDb();
const books = fakeBooks();
await ensureCastTables(db as any);
assert(await seedRecordedCasts(db as any) === true, "seed: first run inserts recorded casts");
assert(await seedRecordedCasts(db as any) === false, "seed: second run is idempotent");
let registry = await getRegistry(db as any);
assert(registry.length === RECORDED_CASTS.length, "seed: registry holds exactly the recorded casts");
const mira = registry.find((r) => r.character_name === "Mira");
assert(mira?.voice_id === "kore" && mira?.source === "recorded" && mira?.first_book_slug === "mastery",
  "seed: Mira recorded with Kore from mastery");
const wally = registry.find((r) => r.character_name === "Wally");
assert(wally?.voice_id === "riko" && wally?.first_book_slug === "docker", "seed: Wally recorded with Riko from docker");
const basil = registry.find((r) => r.character_name === "Basil");
assert(basil?.voice_id === "enzo" && basil?.first_book_slug === "designpatterns", "seed: Basil recorded with Enzo from designpatterns");

/* ---------- assign: new character ---------- */
const a1 = await assignVoice(db as any, books as any, { characterName: "Fern", voiceId: "zali", bookSlug: "algorithms" });
assert(a1.action === "assign", "assign: new character logs action assign");
assert(a1.row.voice_id === "zali" && a1.row.source === "admin" && a1.row.first_book_slug === "algorithms",
  "assign: registry row carries voice, admin source, first book");
let log = await getAssignmentLog(db as any);
assert(log.length === 1 && log[0].character_name === "Fern" && log[0].action === "assign",
  "assign: audit log has the assignment");
const exported = JSON.parse(books.store.get("cast-registry.json") || "{}");
assert(exported.characters?.Fern?.voice_id === "zali" && exported.characters?.Mira?.voice_id === "kore",
  "assign: R2 export refreshed with the whole registry");

/* ---------- no-op + change ---------- */
const a2 = await assignVoice(db as any, books as any, { characterName: "Fern", voiceId: "zali", bookSlug: "algorithms" });
assert(a2.action === "noop", "assign: same voice again is a no-op");
log = await getAssignmentLog(db as any);
assert(log.length === 1, "assign: no-op writes no log row");
const a3 = await assignVoice(db as any, books as any, { characterName: "Fern", voiceId: "sami", bookSlug: "algorithms" });
assert(a3.action === "change" && a3.row.voice_id === "sami", "change: new voice logs action change");
assert(a3.row.first_book_slug === "algorithms", "change: first_book_slug is preserved");
log = await getAssignmentLog(db as any);
assert(log.length === 2 && log[0].action === "change", "change: audit log records the change");

/* ---------- recorded cast can be revised; seed never clobbers ---------- */
const a4 = await assignVoice(db as any, books as any, { characterName: "Mira", voiceId: "fola", bookSlug: "mastery" });
assert(a4.action === "change" && a4.row.source === "admin", "recorded: an admin change replaces the recorded cast");
await seedRecordedCasts(db as any);
registry = await getRegistry(db as any);
assert(registry.find((r) => r.character_name === "Mira")?.voice_id === "fola",
  "recorded: re-seeding does not clobber the admin assignment");

/* ---------- unknown voice rejected ---------- */
let threw = false;
try {
  await assignVoice(db as any, books as any, { characterName: "Fern", voiceId: "not-a-voice", bookSlug: "algorithms" });
} catch { threw = true; }
assert(threw, "assign: unknown voice id is rejected");

/* ---------- bibleCast shapes ---------- */
const gen = bibleCast({
  protagonist: { name: "Mira", species: "heron" },
  supportingCast: [{ name: "Ansel", species: "heron" }, { name: "Dell", species: "duck" }],
  newCharacters: [{ name: "Dell", species: "duck" }],
});
assert(gen.length === 3 && gen[0].role === "protagonist" && gen[1].role === "supporting",
  "bibleCast: generated shape, protagonist first, dupes dropped");
const canon = bibleCast({ characters: [{ name: "Wally", species: "whale" }, { name: "Pip", species: "sea otter" }] });
assert(canon.length === 2 && canon[0].role === "protagonist", "bibleCast: canonical shape, first character leads");

/* ---------- findCharacterLine ---------- */
const pages = [
  "Mira wanted a thing of her own to be good at before the leaves turned. She paddled beside Dell all summer long.",
  "At the muddy end, one tall reed always leaned out over the water. \"You always end up here too,\" said Dell. \"Staring at the water, just like when you were a fuzzy chick.\"",
  "\"My feet made that,\" said Ansel, \"one walk every morning for many years. One big walk makes no path, little one. The plain, boring mornings are not in the way of learning. They are the learning.\"",
];
const dell = findCharacterLine(pages, "Dell");
assert(dell && dell.includes("end up here"), "lines: Dell's attributed dialogue is found");
const ansel = findCharacterLine(pages, "Ansel");
assert(ansel && ansel.includes("My feet made that"), "lines: Ansel's said-before dialogue is found");
const miraLine = findCharacterLine(pages, "Mira");
assert(miraLine && miraLine.includes("wanted a thing of her own"), "lines: fallback is a narration page naming the character");
assert(findCharacterLine(pages, "Nobody") === null, "lines: unknown character yields null");

/* ---------- parsePageSegments: scene derivation (S3) ---------- */
const castNames = ["Mira", "Ansel", "Dell"];
const dellSegs = parsePageSegments(pages[1], castNames);
assert(dellSegs.length === 2 && dellSegs[0].speaker === "Narrator" && dellSegs[1].speaker === "Dell",
  "scenes: Dell page splits into narration plus Dell");
assert(dellSegs[0].text.includes("muddy end") && !/said/i.test(dellSegs[0].text),
  "scenes: attribution phrase is stripped from the narration, never read aloud");
assert(dellSegs[1].text.includes("end up here") && dellSegs[1].text.includes("fuzzy chick"),
  "scenes: a continued quote after 'said Dell.' stays with Dell and merges");
const anselSegs = parsePageSegments(pages[2], castNames);
assert(anselSegs.length === 1 && anselSegs[0].speaker === "Ansel" && anselSegs[0].text.includes("My feet made that"),
  "scenes: Ansel's said-before page is one merged Ansel turn");
const mixedSegs = parsePageSegments(
  'The sun climbed over the marsh. "My feet made that," said Ansel, "one walk every morning for many years." Mira watched the path appear in the mud.',
  castNames
);
assert(
  mixedSegs.length === 3 && mixedSegs[0].speaker === "Narrator" && mixedSegs[1].speaker === "Ansel" && mixedSegs[2].speaker === "Narrator",
  "scenes: narration, dialogue, narration stay in order"
);

/* ---------- sceneSetForBook: earliest shared page wins ---------- */
const sceneChars = [
  { name: "Mira", species: "heron", role: "protagonist" as const },
  { name: "Ansel", species: "heron", role: "supporting" as const },
  { name: "Dell", species: "duck", role: "supporting" as const },
];
const sceneChapters = [
  {
    num: 1,
    title: "The Small Sky",
    pages: [
      { text: pages[0] },
      { text: pages[1] },
      { text: 'The sun climbed over the marsh. "My feet made that," said Ansel, "one walk every morning for many years." Mira watched the path appear in the mud.' },
    ],
  },
];
const sceneBooks = {
  async get(key: string) {
    if (key.endsWith("editor_chapters.json")) {
      return { text: async () => JSON.stringify(sceneChapters) };
    }
    return null;
  },
};
const scenes = await sceneSetForBook(sceneBooks as any, "any-book", sceneChars);
assert(!scenes.Mira, "scenes: the protagonist never gets a scene of her own");
assert(scenes.Dell && scenes.Dell.label === "Chapter 1 scene: The Small Sky" && scenes.Dell.id === "s1p2",
  "scenes: Dell's scene is the shared Chapter 1 page with its title");
assert(scenes.Dell && scenes.Dell.segments.some((s) => s.speaker === "Narrator"),
  "scenes: Dell's scene keeps the narration turns for the locked narrator voice");
assert(scenes.Ansel && scenes.Ansel.id === "s1p3" && scenes.Ansel.segments.some((s) => s.speaker === "Ansel"),
  "scenes: Ansel's scene is his shared page with the narrator");
const noTextScenes = await sceneSetForBook({ async get() { return null; } } as any, "x", sceneChars);
assert(Object.keys(noTextScenes).length === 0, "scenes: a book without chapter text yields no scenes, not an error");

/* ---------- sampleSegmentsFor: the free sample (S3) ---------- */
const sampleLines = [
  { id: "presents", character: "Promo", label: "Presents intro", text: "Big Brain Shelf presents: Mira.", cacheBook: "x" },
  { id: "narrator", character: "Narrator", label: "Chapter 1", text: "Mira wanted a thing of her own.", cacheBook: "x" },
  { id: "mira", character: "Mira", label: "Mira", text: "I can learn this.", cacheBook: "x" },
  { id: "dell", character: "Dell", label: "Dell", text: "You always end up here too.", cacheBook: "x" },
];
const sample = sampleSegmentsFor(sampleLines as any, "Mira");
assert(
  sample.length === 3 && sample[0].speaker === "Narrator" && sample[1].speaker === "Narrator" && sample[2].speaker === "Mira",
  "sample: presents and Chapter 1 narration, then the protagonist's own line"
);
assert(sampleSegmentsFor(sampleLines as any, null).length === 2,
  "sample: without a protagonist name the sample is narration only");

if (failures) { console.error(failures + " FAILURES"); process.exit(1); }
console.log("ALL PASS");
