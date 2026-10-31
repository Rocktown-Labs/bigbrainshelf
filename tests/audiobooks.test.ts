// Focused tests for the admin audiobook player helpers
// (src/lib/audiobooks.ts). Run with: bun tests/audiobooks.test.ts
import {
  audiobookDir,
  chapterAudioKey,
  introAudioKey,
  outroAudioKey,
  fullBookMp3Key,
  parseChapterParam,
  parseTrackParam,
  trackKey,
  trackContentType,
  chapterTitle,
  chapterLabel,
  chapterDuration,
  edgeTrackMeta,
  inspectAudiobook,
  serveAudiobookTrack,
  formatClock,
  parseRangeHeader,
  MAX_CHAPTER,
} from "../src/lib/audiobooks";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

// Key derivation from books.audiobook_key
const KEY = "books/mastery/audiobook.m4b";
assert(audiobookDir(KEY) === "books/mastery", "dir derived from audiobook_key");
assert(chapterAudioKey(KEY, 1) === "books/mastery/audio/ch1.mp3", "chapter 1 key");
assert(chapterAudioKey(KEY, 8) === "books/mastery/audio/ch8.mp3", "chapter 8 key");
assert(introAudioKey(KEY) === "books/mastery/audio/intro.mp3", "intro key");
assert(outroAudioKey(KEY) === "books/mastery/audio/outro.mp3", "outro key");
assert(fullBookMp3Key(KEY) === "books/mastery/audiobook.mp3", "full-book MP3 key");

// Chapter guard: 1..MAX_CHAPTER only (Wally has 18 chapters)
assert(parseChapterParam("1") === 1, "chapter 1 parses");
assert(parseChapterParam("12") === 12, "chapter 12 parses");
assert(parseChapterParam("0") === null, "chapter 0 rejected");
assert(parseChapterParam("18") === 18, "chapter 18 parses (Wally)");
assert(parseChapterParam("31") === null, "chapter 31 rejected");
assert(parseChapterParam("-1") === null, "negative chapter rejected");
assert(parseChapterParam("abc") === null, "non-numeric chapter rejected");
assert(parseChapterParam("2.5") === null, "fractional chapter rejected");
assert(parseChapterParam("") === null, "empty chapter rejected");
assert(MAX_CHAPTER === 30, "chapter cap is 30");

// Track parsing for /api/admin/audiobook/{slug}/{track}
assert(parseTrackParam("full")?.kind === "full", "full track parses");
assert(parseTrackParam("m4b")?.kind === "m4b", "m4b track parses");
assert(parseTrackParam("intro")?.kind === "intro", "intro track parses");
assert(parseTrackParam("outro")?.kind === "outro", "outro track parses");
assert(parseTrackParam("Intro")?.kind === "intro", "intro track is case-insensitive");
const ch3 = parseTrackParam("ch3");
assert(ch3?.kind === "chapter" && ch3.n === 3, "ch3 track parses");
assert(parseTrackParam("ch0") === null, "ch0 track rejected");
const ch18 = parseTrackParam("ch18");
assert(ch18?.kind === "chapter" && ch18.n === 18, "ch18 track parses (Wally)");
assert(parseTrackParam("ch31") === null, "ch31 track rejected");
assert(parseTrackParam("chx") === null, "chx track rejected");
assert(parseTrackParam("video") === null, "unknown track rejected");
assert(trackKey(KEY, { kind: "chapter", n: 5 }) === "books/mastery/audio/ch5.mp3", "track key for chapter");
assert(trackKey(KEY, { kind: "full" }) === "books/mastery/audiobook.mp3", "track key for full");
assert(trackKey(KEY, { kind: "m4b" }) === KEY, "track key for m4b is the audiobook_key itself");
assert(trackKey(KEY, { kind: "intro" }) === "books/mastery/audio/intro.mp3", "track key for intro");
assert(trackKey(KEY, { kind: "outro" }) === "books/mastery/audio/outro.mp3", "track key for outro");
assert(trackContentType({ kind: "m4b" }) === "audio/mp4", "m4b is audio/mp4");
assert(trackContentType({ kind: "full" }) === "audio/mpeg", "full is audio/mpeg");
assert(trackContentType({ kind: "chapter", n: 1 }) === "audio/mpeg", "chapter is audio/mpeg");
assert(trackContentType({ kind: "intro" }) === "audio/mpeg", "intro is audio/mpeg");
assert(trackContentType({ kind: "outro" }) === "audio/mpeg", "outro is audio/mpeg");

// Chapter labels and durations from src/data/audiobooks.json, with fallback
assert(chapterTitle("mastery", 1) === "The Thing That Pulls", "Mira chapter 1 title from data");
assert(chapterTitle("mastery", 8) === "The Long Path", "Mira chapter 8 title from data");
assert(chapterLabel("mastery", 3) === "Chapter 3: The Morning Path", "label joins number and title");
assert(chapterLabel("mastery", 9) === "Chapter 9", "label falls back past the known list");
assert(chapterLabel("nosuchbook", 2) === "Chapter 2", "label falls back for unknown book");
assert(chapterDuration("mastery", 1) === 115.6, "Mira chapter 1 duration from data");
assert(chapterDuration("nosuchbook", 1) === null, "duration null for unknown book");

// Intro/outro metadata: every published book carries both entries in
// src/data/audiobooks.json with the canonical titles and the measured
// MP3 durations (a spoken "presents" opening and a short closing).
const PUBLISHED = [
  "mastery", "richdadpoordad", "algorithms", "designpatterns",
  "docker", "compoundeffect", "motivationmanifesto", "thewarofart",
];
for (const slug of PUBLISHED) {
  const intro = edgeTrackMeta(slug, "intro");
  const outro = edgeTrackMeta(slug, "outro");
  assert(intro.title === "Introduction", `${slug} intro titled Introduction`);
  assert(outro.title === "The End", `${slug} outro titled The End`);
  assert(intro.duration !== null && intro.duration >= 10 && intro.duration <= 30,
    `${slug} intro duration sane (${intro.duration}s)`);
  assert(outro.duration !== null && outro.duration >= 5 && outro.duration <= 20,
    `${slug} outro duration sane (${outro.duration}s)`);
}
assert(edgeTrackMeta("mastery", "intro").duration === 19.0, "Mira intro is the measured 19.0s");
assert(edgeTrackMeta("mastery", "outro").duration === 11.1, "Mira outro is the measured 11.1s");
assert(edgeTrackMeta("nosuchbook", "intro").title === "Introduction", "intro title falls back");
assert(edgeTrackMeta("nosuchbook", "outro").duration === null, "outro duration null for unknown book");

// Clock formatting
assert(formatClock(0) === "0:00", "zero formats");
assert(formatClock(65) === "1:05", "minutes and seconds");
assert(formatClock(1030.6) === "17:11", "Mira total formats");
assert(formatClock(3723) === "1:02:03", "hours format");
assert(formatClock(null) === "0:00", "null clock is safe");

// Range parsing against a 1000-byte object
const SIZE = 1000;
assert(parseRangeHeader(null, SIZE).kind === "none", "no header is no range");
assert(parseRangeHeader("", SIZE).kind === "none", "empty header is no range");
assert(parseRangeHeader("bytes=0-99", SIZE).kind === "range", "bounded range parses");
const r1 = parseRangeHeader("bytes=0-99", SIZE);
assert(r1.kind === "range" && r1.start === 0 && r1.end === 99, "bounded range values");
const r2 = parseRangeHeader("bytes=500-", SIZE);
assert(r2.kind === "range" && r2.start === 500 && r2.end === 999, "open-ended range runs to the end");
const r3 = parseRangeHeader("bytes=-100", SIZE);
assert(r3.kind === "range" && r3.start === 900 && r3.end === 999, "suffix range takes the tail");
const r4 = parseRangeHeader("bytes=900-5000", SIZE);
assert(r4.kind === "range" && r4.start === 900 && r4.end === 999, "end clamps to size");
const r5 = parseRangeHeader("bytes=-5000", SIZE);
assert(r5.kind === "range" && r5.start === 0 && r5.end === 999, "oversized suffix covers the file");
assert(parseRangeHeader("bytes=1000-", SIZE).kind === "unsatisfiable", "start at size is unsatisfiable");
assert(parseRangeHeader("bytes=1500-2000", SIZE).kind === "unsatisfiable", "start past size is unsatisfiable");
assert(parseRangeHeader("bytes=600-500", SIZE).kind === "unsatisfiable", "end before start is unsatisfiable");
assert(parseRangeHeader("bytes=-0", SIZE).kind === "unsatisfiable", "zero suffix is unsatisfiable");
assert(parseRangeHeader("items=0-10", SIZE).kind === "none", "wrong unit ignored");
assert(parseRangeHeader("bytes=0-10,20-30", SIZE).kind === "none", "multi-range ignored");
assert(parseRangeHeader("bytes=abc-def", SIZE).kind === "none", "garbage range ignored");
assert(parseRangeHeader("bytes=0-", 0).kind === "unsatisfiable", "empty object cannot satisfy a range");

// ---- Playlist composition + streaming, against a fake bucket ----
// inspectAudiobook must open with the intro and close with the outro
// in `tracks`, while `chapters` stays chapter-pure for counting and
// chip mapping. Tracks that do not exist in R2 are simply absent.
function fakeEnv(present: Set<string>) {
  return {
    BOOKS: {
      head: async (k: string) => (present.has(k) ? { size: 1000 } : null),
      get: async (k: string) =>
        present.has(k) ? { body: "abc", text: async () => "{}" } : null,
    },
  };
}
const fakeBook: any = { slug: "mastery", title: "Mira", audiobook_key: KEY };

const withEdges = new Set([
  KEY,
  "books/mastery/audio/intro.mp3",
  "books/mastery/audio/ch1.mp3",
  "books/mastery/audio/ch2.mp3",
  "books/mastery/audio/outro.mp3",
]);
const insp = await inspectAudiobook(fakeEnv(withEdges), fakeBook);
assert(insp.tracks.map((t) => t.id).join(",") === "intro,ch1,ch2,outro",
  "playlist order is intro, chapters, outro");
assert(insp.chapters.map((t) => t.id).join(",") === "ch1,ch2", "chapters stay chapter-pure");
assert(insp.intro?.label === "Introduction" && insp.intro?.duration === 19.0,
  "intro track carries title and duration");
assert(insp.outro?.label === "The End" && insp.outro?.duration === 11.1,
  "outro track carries title and duration");
assert(insp.intro?.url === "/api/admin/audiobook/mastery/intro", "intro url under the admin route");
assert(insp.outro?.url === "/api/admin/audiobook/mastery/outro", "outro url under the admin route");
assert(insp.tracks[0].chapter === null && insp.tracks[1].chapter === 1 && insp.tracks[3].chapter === null,
  "only chapter tracks carry a chapter number");

const libInsp = await inspectAudiobook(fakeEnv(withEdges), fakeBook, "/api/library/audio/mastery");
assert(libInsp.intro?.url === "/api/library/audio/mastery/intro",
  "intro url follows the library base path");

const noEdges = new Set([KEY, "books/mastery/audio/ch1.mp3"]);
const inspBare = await inspectAudiobook(fakeEnv(noEdges), fakeBook);
assert(inspBare.intro === null && inspBare.outro === null, "missing edge files stay absent");
assert(inspBare.tracks.map((t) => t.id).join(",") === "ch1", "bare playlist is chapters only");

// The shared streamer serves the intro exactly like a chapter (the
// library route's ownership check runs before this is ever reached,
// so intro/outro inherit the same entitlement gate as ch{n}).
const served = await serveAudiobookTrack({
  books: fakeEnv(withEdges).BOOKS,
  audiobookKey: KEY,
  slug: "mastery",
  track: { kind: "intro" },
  method: "GET",
  rangeHeader: null,
  allowDownload: false,
});
assert(served.status === 200, "intro track streams");
assert(served.headers.get("Content-Type") === "audio/mpeg", "intro streams as audio/mpeg");
const missing = await serveAudiobookTrack({
  books: fakeEnv(noEdges).BOOKS,
  audiobookKey: KEY,
  slug: "mastery",
  track: { kind: "outro" },
  method: "GET",
  rangeHeader: null,
  allowDownload: false,
});
assert(missing.status === 404, "missing outro 404s instead of erroring");

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nAll audiobook tests passed.");
