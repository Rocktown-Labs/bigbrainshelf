// Free audio sample tests (A2, 2026-10-29; cover+audio expansion
// same day): the public sample route serves ONLY the introduction
// and chapter 1 of the audiobook of any book that has a cover and an
// audiobook (any publish status), with no entitlement. The route
// itself is an Astro endpoint (it reads the worker env), so the
// serving behavior is pinned here at the library seam the route is
// built on (parseTrackParam + serveAudiobookTrack against a fake
// bucket), the route's acceptance rules are exercised verbatim, and
// the route + middleware + pages are pinned at source level. Run
// with:
//   bun tests/audio-sample.test.ts
import { readFileSync } from "node:fs";
import { parseTrackParam, serveAudiobookTrack, probeAudiobook } from "../src/lib/audiobooks";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

// The route's acceptance rule, copied verbatim from
// src/pages/api/audio-sample/[slug]/[track].ts: a parsed track is a
// sample track only when it is the intro or chapter 1.
function isSampleTrack(raw: string): boolean {
  const track = parseTrackParam(raw);
  return !!track && (track.kind === "intro" || (track.kind === "chapter" && track.n === 1));
}
assert(isSampleTrack("intro"), "the introduction is a sample track");
assert(isSampleTrack("ch1"), "chapter 1 is a sample track");
for (const raw of ["ch2", "ch3", "ch12", "outro", "full", "m4b", "bogus", "", "ch0", "ch-1"]) {
  assert(!isSampleTrack(raw), `"${raw}" is refused as a sample track`);
}

// The route's book-eligibility rule, mirroring its SQL verbatim
// (WHERE cover_key IS NOT NULL AND audiobook_key IS NOT NULL): any
// publish status qualifies; a missing cover or a missing audiobook
// never does.
function sampleEligible(row: { cover_key: string | null; audiobook_key: string | null } | null): boolean {
  return !!row && row.cover_key != null && row.audiobook_key != null;
}
const pennyRow = { status: "ready_for_qa", cover_key: "books/richdadpoordad/cover.jpg", audiobook_key: "books/richdadpoordad/audiobook.m4b" };
const miraRow = { status: "complete", cover_key: "books/mastery/cover.jpg", audiobook_key: "books/mastery/audiobook.m4b" };
const tildaRow = { status: "failed", cover_key: "books/iwillteach/cover.jpg", audiobook_key: null };
assert(sampleEligible(pennyRow), "a ready_for_qa book with cover + audio is sample-eligible (Penny)");
assert(sampleEligible(miraRow), "a complete book with cover + audio is sample-eligible (Mira)");
assert(!sampleEligible(tildaRow), "a book with no audiobook is refused (iwillteach)");
assert(!sampleEligible({ cover_key: null, audiobook_key: "books/x/audiobook.m4b" }), "a book with no cover is refused");
assert(!sampleEligible(null), "an unknown book is refused");

// ---- Streaming behavior against a fake bucket -----------------------
const KEY = "books/mastery/audiobook.m4b";
const FILES = new Map<string, Uint8Array>();
for (const name of ["intro", "ch1", "ch2", "outro"]) {
  FILES.set(`books/mastery/audio/${name}.mp3`, new Uint8Array(1000).fill(name.length));
}
FILES.set(KEY, new Uint8Array(5000));
const fakeBooks = {
  head: async (k: string) => (FILES.has(k) ? { size: FILES.get(k)!.length } : null),
  get: async (k: string, opts?: any) => {
    const data = FILES.get(k);
    if (!data) return null;
    if (opts?.range) {
      const { offset, length } = opts.range;
      return { body: data.slice(offset, offset + length) };
    }
    return { body: data };
  },
};
async function serve(rawTrack: string) {
  const track = parseTrackParam(rawTrack);
  if (!track) return null;
  return serveAudiobookTrack({
    books: fakeBooks, audiobookKey: KEY, slug: "mastery", track,
    method: "GET", rangeHeader: null, allowDownload: false,
  });
}
const introRes = await serve("intro");
assert(introRes?.status === 200 && introRes?.headers.get("Content-Type") === "audio/mpeg", "intro streams as audio/mpeg");
const ch1Res = await serve("ch1");
assert(ch1Res?.status === 200, "chapter 1 streams");
const ranged = await serveAudiobookTrack({
  books: fakeBooks, audiobookKey: KEY, slug: "mastery",
  track: parseTrackParam("ch1")!, method: "GET", rangeHeader: "bytes=0-99", allowDownload: false,
});
assert(ranged.status === 206 && ranged.headers.get("Content-Range") === "bytes 0-99/1000", "range requests on the sample get 206 with a content range");
const missing = await serveAudiobookTrack({
  books: fakeBooks, audiobookKey: KEY, slug: "mastery",
  track: parseTrackParam("ch7")!, method: "GET", rangeHeader: null, allowDownload: false,
});
assert(missing.status === 404, "a chapter file that does not exist 404s at the streamer");

// ---- The route flow, composed: eligibility + track rule + streamer
// + decoy (performance/decoy pass, 2026-10-29). A ready_for_qa book
// with cover + audio (Penny) gets its intro and chapter 1 served;
// a LOCKED track (chapter 2+, outro, full, m4b) on an audio-
// published book returns the shared decoy clip instead of a bare
// 404 or, critically, the real chapter bytes; a book with no
// audiobook (iwillteach) and unparseable track names still 404.
const PENNY_KEY = "books/richdadpoordad/audiobook.m4b";
for (const name of ["intro", "ch1", "ch2"]) {
  FILES.set(`books/richdadpoordad/audio/${name}.mp3`, new Uint8Array(800).fill(3));
}
FILES.set(PENNY_KEY, new Uint8Array(4000));
const DECOY = new Uint8Array(48091).fill(7);
async function routeFlow(row: any, audiobookKey: string, slug: string, rawTrack: string) {
  const track = parseTrackParam(rawTrack);
  if (!track) return 404;
  if (!sampleEligible(row)) return 404;
  if (!isSampleTrack(rawTrack)) return DECOY; // the route serves the decoy asset here
  const res = await serveAudiobookTrack({
    books: fakeBooks, audiobookKey, slug,
    track, method: "GET", rangeHeader: null, allowDownload: false,
  });
  return res.status;
}
assert((await routeFlow(pennyRow, PENNY_KEY, "richdadpoordad", "intro")) === 200, "route flow: Penny (ready_for_qa) intro serves");
assert((await routeFlow(pennyRow, PENNY_KEY, "richdadpoordad", "ch1")) === 200, "route flow: Penny (ready_for_qa) chapter 1 serves");
assert((await routeFlow(pennyRow, PENNY_KEY, "richdadpoordad", "ch2")) === DECOY, "route flow: Penny chapter 2 returns the decoy, never the real chapter");
assert((await routeFlow(pennyRow, PENNY_KEY, "richdadpoordad", "outro")) === DECOY, "route flow: the outro returns the decoy");
assert((await routeFlow(pennyRow, PENNY_KEY, "richdadpoordad", "full")) === DECOY, "route flow: the full file returns the decoy");
assert((await routeFlow(pennyRow, PENNY_KEY, "richdadpoordad", "m4b")) === DECOY, "route flow: the M4B returns the decoy");
assert((await routeFlow(pennyRow, PENNY_KEY, "richdadpoordad", "bogus")) === 404, "route flow: an unparseable track still 404s");
assert((await routeFlow(tildaRow, PENNY_KEY, "iwillteach", "intro")) === 404, "route flow: a book with no audiobook is refused");
assert((await routeFlow(tildaRow, PENNY_KEY, "iwillteach", "ch2")) === 404, "route flow: a book with no audiobook gets no decoy either");
assert((await routeFlow(miraRow, KEY, "mastery", "ch1")) === 200, "route flow: Mira (complete) chapter 1 still serves");

// ---- Probe: the public pages' chapter counts and sample existence ---
const probe = await probeAudiobook({ BOOKS: fakeBooks }, { slug: "mastery", title: "Mira", audiobook_key: KEY });
assert(probe.chapterCount === 2, "probe counts contiguous chapters (ch1, ch2 present)");
assert(probe.hasIntro && probe.hasChapter1 && probe.hasOutro, "probe sees the intro, chapter 1, and the outro");
assert(probe.runtimeSecs > 0, "probe sums the measured durations");

// ---- Source pins: route, middleware, pages ---------------------------
const route = readFileSync(new URL("../src/pages/api/audio-sample/[slug]/[track].ts", import.meta.url), "utf8");
assert(route.includes("cover_key IS NOT NULL AND audiobook_key IS NOT NULL"), "the sample route serves the cover+audio set, any status");
assert(!route.includes("status = 'complete'"), "the sample route no longer gates on complete status");
assert(route.includes("resolveInternalSlug"), "the sample route resolves the public slug server-side");
assert(route.includes('track.kind === "intro"') && route.includes("track.n === 1"), "the sample route restricts itself to intro + chapter 1");
assert(route.includes('headers.set("Cache-Control", "public, max-age=86400")'), "served samples are publicly cacheable");
// Decoy contract pins (2026-10-29): locked tracks on audio-
// published books serve the shared public decoy asset; the route
// fails closed to 404 when the asset cannot be read, and real audio
// is never reachable through the locked branch.
assert(route.includes("/just-buy-it.mp3"), "the sample route serves the just-buy-it decoy asset for locked tracks");
assert(route.includes("ASSETS.fetch"), "the decoy is read from the static assets binding");
assert(route.includes('headers.set("X-BBS-Decoy", "just-buy-it")'), "decoy responses are marked as decoys");
assert(route.includes("if (!track)"), "unparseable tracks 404 before any book lookup");
const decoyBytes = readFileSync(new URL("../public/just-buy-it.mp3", import.meta.url));
assert(decoyBytes.length > 10000 && decoyBytes.length < 200000, "the decoy asset exists and is a short clip, not a chapter file");

const middleware = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
assert(middleware.includes('pathname.startsWith("/api/audio-sample/")'), "middleware passes the audio sample route publicly");

const detail = readFileSync(new URL("../src/pages/audiobooks/[slug].astro", import.meta.url), "utf8");
const sampleUrls = [...detail.matchAll(/audio-sample\/\$\{publicSlug\}\/([a-z0-9]+)/g)].map((m) => m[1]);
assert(sampleUrls.length === 2 && sampleUrls.includes("intro") && sampleUrls.includes("ch1"), "the audio page builds sample URLs for intro and chapter 1 only");
assert(!detail.includes("/api/library/audio"), "the audio page never references the entitled audio route");
assert(detail.includes("chapters.slice(1)"), "chapters past the first render as locked rows");
assert(detail.includes('id="buy-audio"') && detail.includes('format: "audio"'), "the buy block adds the audio-only format to the cart");
assert(detail.includes("CartSheet"), "the audio page carries the shared cart sheet");
assert(detail.includes("A Big Brain Shelf Original."), "the audio page carries the Original line");
assert(detail.includes("Prefer to read it?"), "the audio page links back to the book page");
assert(detail.includes("/clubs"), "the Audio Club upsell links to the plans page");
assert(detail.includes("if (!book.cover_key || !book.audiobook_key)"), "the audio page gates on cover + audiobook, not on complete status");
assert(!detail.includes("Coming soon"), "the audio page has no Coming soon variant: audio-published books get the full page");
assert(detail.includes('book.status === "complete" && digitalCents > 0'), "the digital-bundle clause only points at a digital edition that is actually on sale");

const shelf = readFileSync(new URL("../src/pages/audiobooks.astro", import.meta.url), "utf8");
assert(shelf.includes("cover_key IS NOT NULL AND audiobook_key IS NOT NULL"), "the listening shelf lists every cover+audio book, any status");
assert(!shelf.includes("status = 'complete'"), "the listening shelf no longer filters to complete books");
assert(shelf.includes("The Audio Club: every audiobook on the shelf"), "the shelf carries ONE Audio Club banner above the grid (2026-10-30)");
assert(!shelf.includes("or hear it in Audio Club"), "shelf cards no longer repeat the Audio Club microcopy on every card");
assert(shelf.includes("audiobook only"), "shelf cards carry the audiobook-only price line");
assert(shelf.includes("ab-add") && shelf.includes("initAudioCardCart"), "shelf cards carry a working Add to cart for the audiobook (2026-10-31)");
assert(shelf.includes("probeAudiobook"), "the listening shelf probes chapter counts and runtimes");
assert(shelf.includes('<SectionNav active="audio" />'), "the listening shelf renders the routes bar with Audio active");

console.log(failures === 0 ? "\nALL AUDIO SAMPLE TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
