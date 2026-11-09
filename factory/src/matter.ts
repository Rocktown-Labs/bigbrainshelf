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
import { BookBuildEnv, r2GetBytes, genImageWithQC, MAX_ROLLS, logGenAttempt, spendCapHit } from "./bookbuild";
import { budgetGate } from "./budget";

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
// a plainer back cover, and it beats letter-soup art.
// Every attempt is metered and archived (gen_attempts + bytes in R2)
// with the detailed gate scores and the deciding reason, like every
// other generation loop since 2026-11-01. Before this, back-cover
// rejects vanished into worker logs, so a shutout (Penny 2026-11-03,
// Tilda 2026-11-08) could not be diagnosed or reviewed after the fact.
async function strictArt(
  env: BookBuildEnv,
  slug: string,
  kind: "color" | "line",
  prompt: string
): Promise<Uint8Array | null> {
  const kindLabel = kind === "color" ? "back-cover-color" : "back-cover-line";
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
        ? await generateColorImageMetered(env, prompt, null)
        : await generateImageMetered(env, prompt, null);
    const qd =
      kind === "color" ? await qcColorImageDetailed(env.AI, cur.bytes) : await qcImageDetailed(env.AI, cur.bytes, null);
    if (qd.pass) {
      await logGenAttempt(env, slug, kindLabel, null, null, attempt, { outcome: "accepted", scores: qd.scores, cost: cur.cost }, cur.bytes);
      return cur.bytes;
    }
    await logGenAttempt(env, slug, kindLabel, null, null, attempt, { outcome: "qc_reject", reason: qd.reason, scores: qd.scores, cost: cur.cost }, cur.bytes);
    console.log(`back cover ${kind} art attempt ${attempt} failed QC: ${qd.reason ?? "no reason recorded"}`);
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
  const ck = BACK_COVER_COLOR_KEY(slug);
  out.color = await r2GetBytes(env.BOOKS, ck);
  if (!out.color) {
    try {
      const bytes = await strictArt(env, slug, "color", backCoverColorPrompt(bible));
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
      const bytes = await strictArt(env, slug, "line", backCoverPrompt(bible));
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
