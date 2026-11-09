import { bookVocabulary } from '../../packages/core/src/book-vocabulary';
// Front/back matter composer: turns a book's bible into the pages that
// make it feel like a real published book (see pdf.ts BookMatter):
// a copyright page, a "Words to Know" glossary, and a back cover with a
// blurb, learn bullets, and a series line. The blurb follows the house
// pattern: a story about <the cast> that teaches kids <the vocab topics>,
// plus the book's big idea. Everything is programmatic from the bible,
// no model calls except the back-cover illustration, which goes through
// the same artist + QC path as chapter pages (B&W line art; in the
// coloring book it doubles as a bonus coloring page).
import { STYLE_SUFFIX, generateImageMetered, generateColorImageMetered, qcImageDetailed, qcColorImageDetailed } from "./ai";
import type { BookMatter } from "./pdf";
import { BookBuildEnv, r2GetBytes, genImageWithQC, MAX_ROLLS, logGenAttempt, spendCapHit, loadSheets } from "./bookbuild";
import { budgetGate } from "./budget";
import { editGatewayImageGptMetered, gptEditEnabled } from "./gateway";

export function bibleCharacters(bible: any): any[] {
  if (Array.isArray(bible?.characters) && bible.characters.length) return bible.characters;
  const out: any[] = [];
  if (bible?.protagonist) out.push(bible.protagonist);
  if (Array.isArray(bible?.supportingCast)) out.push(...bible.supportingCast);
  return out;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return items.join(" and ");
  return items.slice(0, -1).join(", ") + ", and " + items[items.length - 1];
}

// (cap(), which cut back-cover text at N chars with "...", was
// deleted 2026-10-31. The composer never shortens text: pdf.ts
// fits full text by stepping font sizes down. If a line is too
// long, the fix is at authoring, never a silent cut.)

export function composeMatter(bible: any): Omit<BookMatter, "backImage" | "backLineImage"> {
  const chars = bibleCharacters(bible);
  const charList = joinList(chars.map((c: any) => `${c.name} the ${c.species ?? "friend"}`));
  const vocabRaw: any[] = Array.isArray(bible?.vocab) ? bible.vocab : [];
  const ladder: any[] = Array.isArray(bible?.conceptLadder) ? bible.conceptLadder : [];

  // Back-cover topics are named in the STORY's words (the
  // storyName), never the grown-up term: the back cover is a
  // public surface, and printing the source's own concept labels
  // there (Mira's said "your calling (the life's task), deep
  // observation, deliberate practice...") hands any reader the
  // source framework's table of contents. The terms live in the
  // glossary, where grown-ups go looking for them. (2026-10-31.)
  const topics = joinList(
    vocabRaw.slice(0, 4).map((v: any) => String(v.storyName ?? v.term).toLowerCase())
  );
  let blurb = charList
    ? `A story about ${charList}${topics ? ` that teaches kids ${topics}` : ""}.`
    : (bible?.bigIdea ?? "");
  if (bible?.bigIdea && charList) blurb += ` ${bible.bigIdea}`;
  // A bible may carry a hand-written pitch (shortBlurb); it always wins
  // over the auto-composed vocabulary-list blurb.
  if (typeof bible?.shortBlurb === "string" && bible.shortBlurb.trim()) blurb = bible.shortBlurb.trim();

  const learn = ladder.slice(0, 3).map((c: any) => String(c.idea ?? "")).filter(Boolean);

  const vocab = bookVocabulary(bible);

  let seriesLine: string | undefined;
  const s = bible?.series;
  if (s?.name) {
    seriesLine = `Book ${s.bookNumber ?? 1} in the ${s.name} series.`;
    if (s.nextBookTease) seriesLine += ` Next up: ${s.nextBookTease}`;
  }

  return {
    year: new Date().getFullYear(),
    vocab,
    blurb,
    learn,
    seriesLine,
    ageLine: `For ages ${bible?.ageBand ?? "4 to 8"}.`,
    hook: typeof bible?.hookLine === "string" && bible.hookLine.trim() ? bible.hookLine.trim() : undefined,
  };
}

// Shared no-text ban for back-cover prompts: the same explicit
// language PR #65 gave the front cover, extended with ledgers after
// Tilda's 2026-11-08 archived rejects showed the two surviving
// defects were a BURROW BANK sign and the word LEDGER on a book
// spine. The old trailing "No text, no words..." was ignored by the
// artist in busy market scenes.
const NO_TEXT_BAN =
  "No text of any kind anywhere in the image: no signs, no lettering, " +
  "no words, no numbers, including on stalls, banners, books, ledgers, " +
  "or buildings. Any sign, banner, or book is left completely blank.";

export function backCoverPrompt(bible: any): string {
  const chars = bibleCharacters(bible);
  const cast = chars
    .map((c: any) => `${c.name} the ${c.species ?? ""}: ${c.visual ?? ""}`)
    .join(". ");
  return (
    `${cast}. All the friends together in ${bible?.setting ?? "their favorite place"}, ` +
    `smiling and waving at the reader, a happy final scene. ${STYLE_SUFFIX} ${NO_TEXT_BAN}`
  );
}

export const BACK_COVER_COLOR_KEY = (slug: string) => `books/${slug}/back-cover-color.jpg`;
export const BACK_COVER_LINE_KEY = (slug: string) => `books/${slug}/back-cover-line.jpg`;

export function backCoverColorPrompt(bible: any): string {
  const chars = bibleCharacters(bible);
  const cast = chars
    .map((c: any) => `${c.name} the ${c.species ?? ""}: ${c.visual ?? ""}`)
    .join(". ");
  return (
    `${cast}. All the friends together in ${bible?.setting ?? "their favorite place"}, ` +
    `smiling and waving at the reader, a happy final scene. ${NO_TEXT_BAN}`
  );
}

// Back-cover art is held to a harder rule than chapter pages: if all
// attempts fail QC, ship NO art (a text-only back cover) rather than the
// flagged last attempt the chapter pipeline settles for. A missing
// chapter page would break a book; a missing back-cover image is just
// a plainer back cover, and it beats letter-soup art. Rolls are
// conditioned on the cast's model sheets, and when the GPT edit rung
// is enabled the best reject gets one edit pass before the shutout.
// Every attempt is metered and archived (gen_attempts + bytes in R2)
// with the detailed gate scores and the deciding reason, like every
// other generation loop since 2026-11-01. Before this, back-cover
// rejects vanished into worker logs, so a shutout (Penny 2026-11-03,
// Tilda 2026-11-08) could not be diagnosed or reviewed after the fact.
// The gates a back-cover roll can fail, with the fix line the GPT edit
// rung acts on for each. Back covers deliberately carry NO cast gates
// (Penny precedent 2026-11-03): purity + color + anatomy only.
function coverFailures(kind: "color" | "line", scores: any): string[] {
  const s = scores ?? {};
  const out: string[] = [];
  if (typeof s.has_text === "number" && s.has_text > 0.12) out.push("has_text");
  if (kind === "color") {
    if (typeof s.is_color === "number" && s.is_color < 0.5) out.push("is_color");
  } else {
    if (typeof s.has_color === "number" && s.has_color > 0.3) out.push("has_color");
    if (typeof s.is_lineart === "number" && s.is_lineart < 0.4) out.push("is_lineart");
  }
  if (typeof s.anatomy === "number" && s.anatomy < 0.3) out.push("anatomy");
  return out;
}

const COVER_FIX_LINES: Record<string, string> = {
  has_text:
    "Remove ALL text, lettering, words and numbers everywhere in the image, including on signs, banners, books, ledgers and buildings. Leave every sign, banner, book spine and surface completely blank.",
  anatomy:
    "Fix any malformed hands, paws, feet, limbs, wings or faces so every character's anatomy is natural and correct.",
  is_color: "Keep the image in full, rich color.",
  has_color: "Remove all color; the image must be pure black and white line art.",
  is_lineart: "Make the image clean black and white line art with bold outlines.",
};

async function strictArt(
  env: BookBuildEnv,
  slug: string,
  kind: "color" | "line",
  prompt: string,
  castField: string
): Promise<Uint8Array | null> {
  const kindLabel = kind === "color" ? "back-cover-color" : "back-cover-line";
  // Condition on the cast's model sheets like every page path does. Until
  // 2026-11-09 back covers were generated from bible text alone, and the
  // cast drifted off-sheet (Penny's back cover) with no gate able to see
  // it: the sheets are the only identity ground truth the artist gets.
  const sheets = await loadSheets(env, slug, castField, 3, kind);
  let bestReject: { bytes: Uint8Array; scores: any; failures: string[] } | null = null;
  for (let attempt = 1; attempt <= MAX_ROLLS; attempt++) {
    const cap = await spendCapHit(env, slug);
    if (cap !== null) {
      await logGenAttempt(env, slug, kindLabel, null, null, attempt, { outcome: "spend_capped", reason: `spend cap $${cap} reached before this roll` });
      console.log(`spend cap ($${cap}) reached for ${slug}; back cover ${kind} art held`);
      return null;
    }
    const bcap = await budgetGate(env, slug);
    if (bcap !== null) {
      await logGenAttempt(env, slug, kindLabel, null, null, attempt, { outcome: "budget_capped", reason: `book budget $${bcap} reached before this roll (cross-run budget)` });
      console.log(`book budget ($${bcap}) reached for ${slug}; back cover ${kind} art held`);
      return null;
    }
    const cur =
      kind === "color"
        ? await generateColorImageMetered(env, prompt, sheets)
        : await generateImageMetered(env, prompt, sheets);
    const qd =
      kind === "color" ? await qcColorImageDetailed(env.AI, cur.bytes) : await qcImageDetailed(env.AI, cur.bytes, null);
    if (qd.pass) {
      await logGenAttempt(env, slug, kindLabel, null, null, attempt, { outcome: "accepted", scores: qd.scores, cost: cur.cost }, cur.bytes);
      return cur.bytes;
    }
    await logGenAttempt(env, slug, kindLabel, null, null, attempt, { outcome: "qc_reject", reason: qd.reason, scores: qd.scores, cost: cur.cost }, cur.bytes);
    console.log(`back cover ${kind} art attempt ${attempt} failed QC: ${qd.reason ?? "no reason recorded"}`);
    const failures = coverFailures(kind, qd.scores);
    if (!bestReject || failures.length < bestReject.failures.length)
      bestReject = { bytes: cur.bytes, scores: qd.scores, failures: failures.length ? failures : ["has_text"] };
  }
  // GPT edit rung (flag-gated, same pattern as the page paths): one edit
  // pass on the best reject for localized defects a re-roll keeps
  // redrawing, e.g. a named building's sign the artist letters no matter
  // how the prompt bans it (Tilda's BURROW BANK, 2026-11-09: two gorgeous
  // rolls, both shut out on has_text alone). The edit faces the same QC
  // gates and is archived like every other attempt.
  if (bestReject && gptEditEnabled(env)) {
    const attempt = MAX_ROLLS + 1;
    const cap = await spendCapHit(env, slug);
    const bcap = cap === null ? await budgetGate(env, slug) : null;
    if (cap !== null || bcap !== null) {
      await logGenAttempt(env, slug, kindLabel, null, null, attempt, { outcome: "spend_capped", reason: "spend cap or book budget reached before the gpt edit rung" });
    } else {
      try {
        const fixes = bestReject.failures.map((f) => COVER_FIX_LINES[f]).filter(Boolean);
        const editPrompt =
          "Edit the first image, a children's book back cover that failed quality control. " +
          "Keep the scene, the composition, and the characters exactly the same except for the fixes below.\n" +
          (fixes.length ? `Fix exactly these problems: ${fixes.join(" ")}\n` : "") +
          "The other images are the characters' model sheets: match them exactly. Change nothing else. " +
          (kind === "color"
            ? "Full color watercolor storybook art, one single scene, no text anywhere."
            : "Black and white line art, clean bold outlines, one single scene, no text, no color.");
        const cur = await editGatewayImageGptMetered(env, editPrompt, [bestReject.bytes, ...sheets.slice(0, 3)]);
        const qd =
          kind === "color" ? await qcColorImageDetailed(env.AI, cur.bytes) : await qcImageDetailed(env.AI, cur.bytes, null);
        if (qd.pass) {
          await logGenAttempt(env, slug, kindLabel, null, null, attempt, { outcome: "accepted_gpt_edit", scores: qd.scores, cost: cur.cost }, cur.bytes);
          return cur.bytes;
        }
        await logGenAttempt(env, slug, kindLabel, null, null, attempt, { outcome: "gpt_edit_reject", reason: qd.reason, scores: qd.scores, cost: cur.cost }, cur.bytes);
        console.log(`back cover ${kind} art gpt edit failed QC: ${qd.reason ?? "no reason recorded"}`);
      } catch (e: any) {
        await logGenAttempt(env, slug, kindLabel, null, null, attempt, { outcome: "gpt_edit_error", reason: String(e?.message ?? e).slice(0, 300) });
        console.log(`back cover ${kind} art gpt edit errored: ${e?.message ?? e}`);
      }
    }
  }
  console.log(`back cover ${kind} art: all attempts failed QC, shipping without art`);
  return null;
}

export interface BackCoverImages {
  color: Uint8Array | null;
  line: Uint8Array | null;
}

// Idempotent per image: returns the stored art when present, otherwise
// generates it and stores it in R2. The picture book's back cover is
// full color (like the front cover); the coloring book's back page is
// B&W line art, so it doubles as a bonus coloring page.
export async function ensureBackCoverImages(
  env: BookBuildEnv,
  slug: string,
  bible: any
): Promise<BackCoverImages> {
  const out: BackCoverImages = { color: null, line: null };
  const castField = bibleCharacters(bible).map((c: any) => c.name).filter(Boolean).join(", ");
  const ck = BACK_COVER_COLOR_KEY(slug);
  out.color = await r2GetBytes(env.BOOKS, ck);
  if (!out.color) {
    try {
      const bytes = await strictArt(env, slug, "color", backCoverColorPrompt(bible), castField);
      if (bytes) {
        await env.BOOKS.put(ck, bytes, { httpMetadata: { contentType: "image/jpeg" } });
        out.color = bytes;
      }
    } catch (e: any) {
      console.log(`color back cover failed for ${slug}: ${e?.message ?? e}`);
    }
  }
  const lk = BACK_COVER_LINE_KEY(slug);
  out.line = await r2GetBytes(env.BOOKS, lk);
  if (!out.line) {
    try {
      const bytes = await strictArt(env, slug, "line", backCoverPrompt(bible), castField);
      if (bytes) {
        await env.BOOKS.put(lk, bytes, { httpMetadata: { contentType: "image/jpeg" } });
        out.line = bytes;
      }
    } catch (e: any) {
      console.log(`line back cover failed for ${slug}: ${e?.message ?? e}`);
    }
  }
  return out;
}
