// Publish readiness tests: the audio gate's model. Voice stamps parse
// and normalize across spellings (registry id "enzo", generator stamp
// "en-us-enzo", display "Enzo"); the readiness states come out right
// for the gate matrix (uncast blocks, draft blocks, matching stamp is
// final, missing audiobook blocks); the recorded casts seed truthfully
// against real-shaped data; and the let-it-ride override decision +
// durable record behave: default blocks, the flag waives ONLY the
// audio decision and writes its paper trail. Runs the real src/lib
// code against an in-memory bun:sqlite database and a fake bucket.
// Run with: bun tests/publish-readiness.test.ts
import { Database } from "bun:sqlite";
import {
  parseVoiceStamp,
  audiobookMetaKey,
  readVoiceStamp,
} from "../src/lib/audiobooks";
import {
  normalizeVoiceId,
  voiceDisplayName,
  computeReadiness,
  getPublishReadiness,
  audioGateDecision,
  recordPublishOverride,
  getPublishOverrides,
  type PublishReadiness,
} from "../src/lib/publish-readiness";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

/* ---------- stamp parsing + voice normalization (pure) ---------- */
const stamp = parseVoiceStamp({ voiceId: "Kore", engine: "gemini", generatedAt: "2026-10-28T04:15:42Z" });
assert(stamp && stamp.voiceId === "Kore" && stamp.engine === "gemini", "stamp object parses");
const stamp2 = parseVoiceStamp('{"voiceId":"en-us-enzo"}');
assert(stamp2 && stamp2.voiceId === "en-us-enzo" && stamp2.engine === null, "stamp JSON string parses, engine optional");
assert(parseVoiceStamp({ engine: "gemini" }) === null, "stamp without voiceId is unusable");
assert(parseVoiceStamp("not json") === null, "garbage stamp is null");
assert(parseVoiceStamp(null) === null, "null stamp is null");

assert(normalizeVoiceId("Kore") === "kore", '"Kore" normalizes to kore');
assert(normalizeVoiceId("en-us-enzo") === "enzo", '"en-us-enzo" normalizes to enzo');
assert(normalizeVoiceId("en-us-riko") === "riko", '"en-us-riko" normalizes to riko');
assert(normalizeVoiceId("riko") === "riko", '"riko" stays riko');
assert(normalizeVoiceId("Enzo") === "enzo", '"Enzo" normalizes to enzo');
assert(normalizeVoiceId("") === null && normalizeVoiceId(null) === null, "empty voice normalizes to null");
assert(voiceDisplayName("en-us-enzo") === "Enzo", '"en-us-enzo" displays as Enzo');
assert(voiceDisplayName("kore") === "Kore", '"kore" displays as Kore');
assert(audiobookMetaKey("books/mastery/audiobook.m4b") === "books/mastery/audiobook-meta.json", "meta key sits beside the audiobook");

/* ---------- the gate matrix (pure readiness) ---------- */
function mk(over: Partial<Parameters<typeof computeReadiness>[0]>): PublishReadiness {
  return computeReadiness({
    slug: "richdadpoordad",
    title: "Penny the Squirrel and the Acorn Orchard",
    bookStatus: "ready_for_qa",
    protagonist: "Penny",
    castVoiceId: null,
    audiobookKey: "books/richdadpoordad/audiobook.m4b",
    audiobookFileExists: true,
    stamp: { voiceId: "Kore", engine: "gemini", generatedAt: "2026-10-28T05:35:27Z" },
    ...over,
  } as any);
}

const uncast = mk({});
assert(uncast.state === "no-cast" && !uncast.ready, "uncast + draft audiobook = no-cast, blocked");
assert(uncast.blockers.length === 1 && uncast.blockers[0].includes("Penny is not cast yet"), "no-cast blocker names the protagonist");
assert(uncast.blockers[0].includes("draft read in Kore"), "no-cast blocker names the draft voice");
assert(uncast.blockers[0].includes("Cast Penny on the Casting page"), "no-cast blocker names the fix");

const finalKore = mk({ castVoiceId: "kore", stamp: { voiceId: "Kore", engine: "gemini", generatedAt: "x" } });
assert(finalKore.state === "final" && finalKore.ready && finalKore.blockers.length === 0, "cast + matching stamp (different spelling) = final");
assert(finalKore.statusLabel === "Final", "final label reads Final");

const draft = mk({ protagonist: "Basil", castVoiceId: "enzo", stamp: { voiceId: "Kore", engine: "gemini", generatedAt: "x" } });
assert(draft.state === "draft-audio" && !draft.ready, "cast + mismatched stamp = draft-audio, blocked");
assert(draft.blockers[0].includes("draft read in Kore") && draft.blockers[0].includes("cast as Enzo"), "draft blocker names both voices");
assert(draft.statusLabel === "Draft read in Kore", "draft label names the heard voice");

const unstamped = mk({ protagonist: "Basil", castVoiceId: "enzo", stamp: null });
assert(unstamped.state === "draft-audio" && unstamped.blockers[0].includes("no voice stamp"), "cast + no stamp = draft-audio with the stamp reason");

const noAudio = mk({ protagonist: "Basil", castVoiceId: "enzo", audiobookKey: null, audiobookFileExists: false, stamp: null });
assert(noAudio.state === "no-audiobook" && !noAudio.ready, "cast + no audiobook = no-audiobook, blocked");
assert(noAudio.blockers[0].includes("cast voice (Enzo)"), "no-audiobook blocker names the cast voice to generate in");

const uncastNoAudio = mk({ audiobookKey: null, audiobookFileExists: false, stamp: null });
assert(uncastNoAudio.state === "no-cast" && uncastNoAudio.blockers.length === 1, "uncast + no audiobook = no-cast with one combined blocker");

const keyButFileGone = mk({ castVoiceId: "kore", audiobookFileExists: false });
assert(keyButFileGone.state === "no-audiobook", "audiobook key set but file missing counts as no audiobook");

/* ---------- override decision (pure) ---------- */
assert(audioGateDecision(null, false).block === true, "unknown readiness blocks audio publish");
assert(audioGateDecision(finalKore, false).block === false && !audioGateDecision(finalKore, true).recordOverride, "a ready book publishes plainly, flag or not");
const blockedDecision = audioGateDecision(uncast, false);
assert(blockedDecision.block && !blockedDecision.recordOverride, "default path blocks the draft book");
const rideDecision = audioGateDecision(uncast, true);
assert(!rideDecision.block && rideDecision.recordOverride, "the flag waives the audio block and demands a record");

/* ---------- DB-backed readiness + override records ---------- */
const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, status TEXT, audiobook_key TEXT);
CREATE TABLE bibles (id TEXT, book_slug TEXT, data TEXT, created_at INTEGER);
INSERT INTO books (slug, title, status, audiobook_key) VALUES
  ('mastery', 'Mira the Heron and the Still Water', 'complete', 'books/mastery/audiobook.m4b'),
  ('designpatterns', 'Blaze the Beaver and the Pattern Book', 'ready_for_qa', 'books/designpatterns/audiobook.m4b'),
  ('richdadpoordad', 'Penny the Squirrel and the Acorn Orchard', 'ready_for_qa', 'books/richdadpoordad/audiobook.m4b'),
  ('quietbook', 'No Sound Yet', 'ready_for_qa', NULL);
INSERT INTO bibles (id, book_slug, data, created_at) VALUES
  ('b1', 'mastery', '{"characters":[{"name":"Mira","species":"heron"},{"name":"Ansel","species":"heron"}]}', 1),
  ('b2', 'designpatterns', '{"characters":[{"name":"Blaze","species":"beaver"}]}', 1),
  ('b3', 'richdadpoordad', '{"characters":[{"name":"Penny","species":"squirrel"},{"name":"Hazel","species":"squirrel"}]}', 1),
  ('b4', 'quietbook', '{"characters":[{"name":"Noor","species":"newt"}]}', 1);
`);

const db = {
  prepare(sql: string) {
    let binds: any[] = [];
    const api: any = {
      bind(...a: any[]) { binds = a; return api; },
      async run() { const r = raw.query(sql).run(...binds) as any; return { meta: { changes: r?.changes ?? 0 } }; },
      async first() { return raw.query(sql).get(...binds) ?? null; },
      async all() { return { results: raw.query(sql).all(...binds) }; },
    };
    return api;
  },
} as any;

function fakeBooks(files: Record<string, string>) {
  const map = new Map(Object.entries(files));
  return {
    async head(key: string) { return map.has(key) ? { size: (map.get(key) as string).length } : null; },
    async get(key: string) { return map.has(key) ? { text: async () => map.get(key) as string } : null; },
    async put(key: string, val: any) { map.set(key, String(val)); },
  } as any;
}

const bucket = fakeBooks({
  "books/mastery/audiobook.m4b": "m4b",
  "books/mastery/audiobook-meta.json": JSON.stringify({ voiceId: "Kore", engine: "gemini", generatedAt: "2026-10-28T04:15:42Z" }),
  "books/designpatterns/audiobook.m4b": "m4b",
  "books/designpatterns/audiobook-meta.json": JSON.stringify({ voiceId: "en-us-enzo", engine: "gemini", generatedAt: "2026-10-28T05:54:07Z" }),
  "books/richdadpoordad/audiobook.m4b": "m4b",
  "books/richdadpoordad/audiobook-meta.json": JSON.stringify({ voiceId: "Kore", engine: "gemini", generatedAt: "2026-10-28T05:35:27Z" }),
});

assert((await readVoiceStamp(bucket, "books/mastery/audiobook.m4b"))?.voiceId === "Kore", "readVoiceStamp reads the sidecar");
assert((await readVoiceStamp(bucket, "books/quietbook/audiobook.m4b")) === null, "readVoiceStamp is null without a sidecar");

// Registry starts EMPTY here: the recorded casts must seed inside
// readiness so shipped books read truthfully.
const mira = await getPublishReadiness(db, bucket, "mastery");
assert(mira && mira.protagonist === "Mira" && mira.castVoiceId === "kore", "mastery: Mira counts as cast from the recorded seed");
assert(mira && mira.state === "final" && mira.ready, "mastery: Kore stamp matches the Kore cast = final");

const basil = await getPublishReadiness(db, bucket, "designpatterns");
assert(basil && basil.state === "final" && basil.ready, "designpatterns: en-us-enzo stamp matches the enzo cast = final");

const penny = await getPublishReadiness(db, bucket, "richdadpoordad");
assert(penny && penny.protagonist === "Penny" && penny.state === "no-cast" && !penny.ready, "richdadpoordad: Penny uncast = no-cast, blocked");
assert(penny && penny.audiobookVoiceName === "Kore", "richdadpoordad: the draft voice reads as Kore");

const quiet = await getPublishReadiness(db, bucket, "quietbook");
assert(quiet && quiet.state === "no-cast" && quiet.blockers[0].includes("no audiobook has been generated"), "quietbook: uncast + no audiobook = no-cast with the combined fix");

assert((await getPublishReadiness(db, bucket, "nosuchbook")) === null, "unknown book = null readiness");

// An object-store outage is unknown, not evidence that a declared file exists.
let failedHeadThrew = false;
try {
  await getPublishReadiness(db, { ...bucket, head: async () => { throw new Error('outage'); } }, 'mastery', { readOnly: true });
} catch { failedHeadThrew = true; }
assert(failedHeadThrew, 'failed audiobook HEAD cannot pass readiness');
const noHead = await getPublishReadiness(db, { get: bucket.get }, 'mastery', { readOnly: true });
assert(noHead?.ready === false, 'missing HEAD capability cannot establish audio readiness');

const readOnlyDb = {
  prepare(sql: string) {
    assert(!/\b(CREATE|ALTER|INSERT|UPDATE|DELETE)\b/i.test(sql), 'read-only audio readiness issues no mutation SQL');
    return db.prepare(sql);
  },
};
await getPublishReadiness(readOnlyDb, bucket, 'mastery', { readOnly: true });

// --- Override record round-trip
assert((await getPublishOverrides(db, "richdadpoordad")).length === 0, "no overrides before any let-it-ride");
await recordPublishOverride(db, penny as PublishReadiness, 1700000100);
await recordPublishOverride(db, penny as PublishReadiness, 1700000200);
const history = await getPublishOverrides(db, "richdadpoordad");
assert(history.length === 2, "both override records persist");
assert(history[0].created_at === 1700000200 && history[1].created_at === 1700000100, "override history is newest first");
assert(history[0].state === "no-cast" && history[0].protagonist === "Penny", "the record keeps the waived state and protagonist");
assert(history[0].audiobook_voice_id === "kore" && history[0].cast_voice_id === null, "the record keeps the voice facts (draft Kore, no cast)");
assert(history[0].reasons.length === 1 && history[0].reasons[0].includes("Penny is not cast yet"), "the record keeps the exact waived reasons");
assert((await getPublishOverrides(db, "mastery")).length === 0, "override history is per book");

if (failures) { console.error(`\n${failures} FAILURES`); process.exit(1); }
console.log("\nAll publish readiness tests passed.");
