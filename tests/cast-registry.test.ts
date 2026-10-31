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

if (failures) { console.error(failures + " FAILURES"); process.exit(1); }
console.log("ALL PASS");
