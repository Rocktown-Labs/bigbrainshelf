// Front/back matter composer: turns a book's bible into the pages that
// make it feel like a real published book (see pdf.ts BookMatter):
// a copyright page, a "Words to Know" glossary, and a back cover with a
// blurb, learn bullets, and a series line. The blurb follows the house
// pattern: a story about <the cast> that teaches kids <the vocab topics>,
// plus the book's big idea. Everything is programmatic from the bible,
// no model calls except the back-cover illustration, which goes through
// the same artist + QC path as chapter pages (B&W line art; in the
// coloring book it doubles as a bonus coloring page).
import { STYLE_SUFFIX, generateImage, generateColorImage, qcImage, qcColorImage } from "./ai";
import type { BookMatter } from "./pdf";
import { BookBuildEnv, r2GetBytes, genImageWithQC, MAX_ROLLS } from "./bookbuild";

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

  const vocab = vocabRaw.map((v: any) => {
    let def = typeof v.definition === "string" ? v.definition : "";
    if (!def) {
      const term = String(v.term ?? "").toLowerCase();
      const hit = ladder.find((c: any) => String(c.idea ?? "").toLowerCase().includes(term));
      if (hit) def = String(hit.idea);
    }
    return { term: String(v.term ?? ""), storyName: String(v.storyName ?? ""), definition: def };
  });

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

export function backCoverPrompt(bible: any): string {
  const chars = bibleCharacters(bible);
  const cast = chars
    .map((c: any) => `${c.name} the ${c.species ?? ""}: ${c.visual ?? ""}`)
    .join(". ");
  return (
    `${cast}. All the friends together in ${bible?.setting ?? "their favorite place"}, ` +
    `smiling and waving at the reader, a happy final scene. ${STYLE_SUFFIX} No text, no words, no letters, no signs.`
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
    `smiling and waving at the reader, a happy final scene. No text, no words, no letters, no signs.`
  );
}

// Back-cover art is held to a harder rule than chapter pages: if all
// attempts fail QC, ship NO art (a text-only back cover) rather than the
// flagged last attempt the chapter pipeline settles for. A missing
// chapter page would break a book; a missing back-cover image is just
// a plainer back cover, and it beats letter-soup art.
async function strictArt(
  env: BookBuildEnv,
  kind: "color" | "line",
  prompt: string
): Promise<Uint8Array | null> {
  for (let attempt = 1; attempt <= MAX_ROLLS; attempt++) {
    const bytes =
      kind === "color"
        ? await generateColorImage(env, prompt, null)
        : await generateImage(env, prompt, null);
    const ok =
      kind === "color" ? await qcColorImage(env.AI, bytes) : await qcImage(env.AI, bytes, null);
    if (ok) return bytes;
    console.log(`back cover ${kind} art attempt ${attempt} failed QC`);
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
      const bytes = await strictArt(env, "color", backCoverColorPrompt(bible));
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
      const bytes = await strictArt(env, "line", backCoverPrompt(bible));
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
