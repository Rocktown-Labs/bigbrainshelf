// Book page-model tests: chapter finale reconciliation (lib/book-pages).
//
// Regression for the 2026-10-28 Story Review defect: Mira's review
// showed 32 pages for a 40-page book. editor_chapters.json lists only
// the four story pages per chapter; every chapter's finale page (real
// story text + art, present in the assembled book, the chapter plans,
// and the audiobook) was dropped by every page-list builder fed by
// that file. These tests pin the reconciled model against mastery's
// REAL shape and data: 8 chapters x (4 story pages + 1 finale) = 40.
// Run with: bun tests/book-pages.test.ts
import {
  loadChapterFinales,
  withFinalePages,
  loadFullChapters,
  pageImageKey,
} from "../src/lib/book-pages";
import { loadReaderBook } from "../src/lib/library";
import { readFileSync } from "node:fs";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const R2 = "https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev/";

// ---- Mastery's real stored shape (from books/mastery in R2) --------
// editor_chapters.json: 8 chapters x 4 story pages, no finales.
function masteryStoredChapters() {
  const chapters: any[] = [];
  for (let n = 1; n <= 8; n++) {
    chapters.push({
      num: n,
      title: `Chapter ${n}`,
      pages: [0, 1, 2, 3].map((pi) => ({
        text: `Story text S${n}p${pi}.`,
        image: `${R2}books/mastery/images/S${n}-page-${pi}.jpg`,
        character: "Mira",
        concept: `Concept S${n}p${pi}.`,
      })),
    });
  }
  return chapters;
}
// Plan finales: real S1 text/key, same shape for the rest.
const MASTERY_FINALE_TEXT =
  "On her next try, Mira caught a minnow no bigger than a leaf, and she laughed out loud. " +
  "On the old willow bank, a tall heron named Ansel had been watching.";
function masteryFinales(): Map<number, { text: string; imageKey: string }> {
  const m = new Map();
  for (let n = 1; n <= 8; n++) {
    m.set(n, {
      text: n === 1 ? MASTERY_FINALE_TEXT : `Finale text S${n}.`,
      imageKey: `books/mastery/images/S${n}-finale.jpg`,
    });
  }
  return m;
}
const masteryLineKeys = new Set<string>();
for (let n = 1; n <= 8; n++) {
  for (let pi = 0; pi <= 3; pi++) masteryLineKeys.add(`books/mastery/images/S${n}-page-${pi}.jpg`);
  masteryLineKeys.add(`books/mastery/images/S${n}-finale.jpg`);
}

// ---- withFinalePages: the reconciled model ---------------------------
{
  const stored = masteryStoredChapters();
  assert(
    stored.reduce((s, c) => s + c.pages.length, 0) === 32,
    "stored mastery shape is 32 pages (the defective input)"
  );
  const full = withFinalePages(stored, masteryFinales(), masteryLineKeys);
  assert(full.length === 8, "model keeps 8 chapters");
  assert(
    full.every((c: any) => c.pages.length === 5),
    "every chapter gains its finale page (5 pages per chapter)"
  );
  assert(
    full.reduce((s: number, c: any) => s + c.pages.length, 0) === 40,
    "reconciled mastery model is the whole book: 40 pages"
  );
  // The exact reported failure, pinned loud: NO chapter may end on a
  // story page when its finale exists.
  assert(
    full.every((c: any, ci: number) => c.pages[4].finale === true),
    "every chapter's LAST page is its finale (the dropped-page failure cannot recur silently)"
  );
  assert(
    full[0].pages[4].text === MASTERY_FINALE_TEXT &&
      pageImageKey(full[0].pages[4]) === "books/mastery/images/S1-finale.jpg",
    "chapter 1 finale carries the real finale text and art key"
  );
  assert(
    full[0].pages.slice(0, 4).every((p: any, pi: number) => pageImageKey(p) === `books/mastery/images/S1-page-${pi}.jpg`),
    "story pages keep their order ahead of the finale"
  );
  assert(
    stored.every((c: any) => c.pages.length === 4),
    "withFinalePages does not mutate the stored chapters"
  );
}

// Dedupe: a chapter that already lists its finale is left alone.
{
  const stored = masteryStoredChapters();
  stored[0].pages.push({
    text: "Already here.",
    image: `${R2}books/mastery/images/S1-finale.jpg`,
  });
  const full = withFinalePages(stored, masteryFinales(), masteryLineKeys);
  assert(full[0].pages.length === 5, "finale already listed is not duplicated");
  assert(
    full[0].pages.filter((p: any) => pageImageKey(p) === "books/mastery/images/S1-finale.jpg").length === 1,
    "exactly one finale page after dedupe"
  );
}

// Existence gate: finale art missing from the line listing -> no append
// (never render a page whose art is not really there).
{
  const keys = new Set(masteryLineKeys);
  keys.delete("books/mastery/images/S3-finale.jpg");
  const full = withFinalePages(masteryStoredChapters(), masteryFinales(), keys);
  assert(full[2].pages.length === 4, "chapter without finale art in R2 stays as stored");
  assert(full[0].pages.length === 5, "other chapters still gain their finales");
}

// No finales known -> input passes through untouched (books w/o plans).
{
  const stored = masteryStoredChapters();
  assert(
    withFinalePages(stored, new Map(), masteryLineKeys) === stored,
    "empty finale map returns the stored chapters unchanged"
  );
}

// ---- loadChapterFinales against a fake bucket ------------------------
function planJson(n: number, withFinale = true) {
  return JSON.stringify({
    storyTitle: `Chapter ${n}`,
    pages: [],
    finale: withFinale
      ? {
          storyText: n === 1 ? MASTERY_FINALE_TEXT : `Finale text S${n}.`,
          imageKey: `books/mastery/images/S${n}-finale.jpg`,
          imagePrompt: "prompt",
        }
      : null,
  });
}
const fakeBooks = {
  async get(key: string) {
    const m = /^books\/mastery\/plans\/S(\d+)\.json$/.exec(key);
    if (m) {
      const n = Number(m[1]);
      if (n === 6) return { text: async () => "{not json" }; // malformed
      if (n === 7) return { text: async () => planJson(n, false) }; // no finale
      if (n <= 8) return { text: async () => planJson(n) };
      return null;
    }
    return null;
  },
};
{
  const finales = await loadChapterFinales(fakeBooks, "mastery", 8);
  assert(finales.size === 6, "finales load for the 6 well-formed plan chapters");
  assert(finales.get(1)?.text === MASTERY_FINALE_TEXT, "finale text comes from the plan's storyText");
  assert(
    finales.get(1)?.imageKey === "books/mastery/images/S1-finale.jpg",
    "finale art key comes from the plan's imageKey"
  );
  assert(!finales.has(6) && !finales.has(7), "malformed / finale-less plans are skipped, never thrown");

  const full = await loadFullChapters(fakeBooks, "mastery", masteryStoredChapters(), masteryLineKeys);
  assert(full[0].pages.length === 5 && full[5].pages.length === 4,
    "loadFullChapters appends only where a plan finale exists");
  const none = await loadChapterFinales(fakeBooks, "mastery", 0);
  assert(none.size === 0, "zero chapters -> no finales");
  const noBucket = await loadChapterFinales(null, "mastery", 8);
  assert(noBucket.size === 0, "missing bucket -> no finales, no throw");
}

// ---- Reader integration: loadReaderBook shows the whole book ---------
{
  const stored = masteryStoredChapters();
  const readerBucket = {
    async get(key: string) {
      if (key === "books/mastery/editor_chapters.json") {
        return { text: async () => JSON.stringify(stored) };
      }
      const pm = /^books\/mastery\/plans\/S(\d+)\.json$/.exec(key);
      if (pm) return { text: async () => planJson(Number(pm[1])) };
      return null;
    },
    async list({ prefix }: any) {
      if (prefix === "books/mastery/images/") {
        return {
          objects: [...masteryLineKeys].map((key) => ({ key, uploaded: new Date(1000) })),
          truncated: false,
        };
      }
      return { objects: [], truncated: false };
    },
  };
  const reader = await loadReaderBook(readerBucket, "mastery");
  assert(reader.error === null, "reader loads mastery");
  assert(reader.totalPages === 40, `reader counts the whole book (got ${reader.totalPages}, want 40)`);
  assert(
    reader.chapters.every((c) => c.pages.length === 5),
    "reader shows 5 pages in every chapter, finale last"
  );
  const ch1Finale = reader.chapters[0].pages[4];
  assert(ch1Finale.text === MASTERY_FINALE_TEXT, "reader finale page carries the finale story text");
  assert(
    ch1Finale.lineUrl ===
      `/api/library/page/mastery?key=${encodeURIComponent("books/mastery/images/S1-finale.jpg")}`,
    "reader finale art is served through the gated reader route"
  );
  assert(!JSON.stringify(reader).includes("r2.dev"), "reader data contains no public bucket URLs");
}

// ---- Review page structure pins (source-level) ------------------------
// The slim nav + finale wiring live in the .astro source; pin the load-
// bearing hooks so a future edit cannot silently fatten the bar again
// or drop the finale reconciliation.
{
  const src = readFileSync(
    new URL("../src/pages/admin/books/[slug]/review.astro", import.meta.url),
    "utf8"
  );
  assert(src.includes("withFinalePages"), "review page reconciles finale pages into its model");
  assert(src.includes("S${num} finale"), "review labels finale pages in factory notation (S1 finale)");
  assert(src.includes("scroll-margin-top: 140px"), "chapter anchors clear the slim bar (desktop)");
  assert(src.includes("scroll-margin-top: 184px"), "chapter anchors clear the slim bar (mobile)");
  assert(!src.includes("scroll-margin-top: 248px"), "old tall-player anchor offset is gone");
  assert(src.includes('id="flag-summary"'), "flag count lives in the slim bar");
  assert(src.includes('id="art-line"') && src.includes('id="art-color"'), "Line/Color toggle lives in the slim bar");
  assert(src.includes('id="seek"') && src.includes('id="speed"'), "seek + speed stay in the bar");
  assert(src.includes('id="mode-chapters"') && src.includes('id="mode-full"'), "Chapters/Full book mode stays reachable");
  assert(src.includes("rv-chapter-chip"), "chapter chips remain one-tap jumps in the bar");
  assert(!src.includes("Notes save against the version you are viewing (line or color).</span>"),
    "the notes-hint line no longer eats bar height");
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll book-pages tests passed.");
