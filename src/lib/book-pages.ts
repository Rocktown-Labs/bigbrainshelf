// Book page-model reconciliation: the finale page of every chapter.
//
// A factory chapter is FIVE pages: four story pages plus a finale page
// (its own story text and art, S{n}-finale.jpg) that closes the chapter
// and carries the story into the next one. The assembled books (PDF /
// EPUB), the chapter plans (books/{slug}/plans/S{n}.json, whose
// `finale` block holds the finale's storyText + imageKey), the
// audiobook scripts (the {ch}-finale narration segments), the sample
// builder, and the reader's key allowlist all treat the finale as a
// real page.
//
// The one structure that omits it is the factory-written
// books/{slug}/editor_chapters.json: it lists only the four story
// pages per chapter. Every page-list builder fed by that file (Story
// Review, the customer reader, the editor chapters API) therefore
// dropped the last page of every chapter: the rendered pages ran out
// while the story (and the audiobook) continued into the missing
// finales. Mira's review showed 32 pages for a 40-page book.
//
// This module reconciles the model to the authoritative structure:
// load each chapter's finale from its plan and append it to the
// chapter's page list when the finale art actually exists and is not
// already listed. Pure and defensive: any missing or malformed plan
// simply leaves the chapter as stored, so a book without plans keeps
// today's behavior exactly.

import { keyFromMediaValue } from "./media";
import { keyFromImageUrl } from "./takes";

export interface ChapterFinale {
  text: string;
  imageKey: string;
  imageColorKey?: string;
}

/** The bucket key a stored page `image` value points at ("" if none). */
export function pageImageKey(pg: any): string {
  const raw = String(pg?.image || "");
  return keyFromMediaValue(raw) || keyFromImageUrl(raw) || "";
}

/**
 * Read books/{slug}/plans/S{n}.json for n = 1..chapterCount and pull
 * out each chapter's finale (storyText + imageKey). Chapters whose
 * plan is missing, unreadable, or finale-less are absent from the map.
 */
export async function loadChapterFinales(
  books: any,
  slug: string,
  chapterCount: number
): Promise<Map<number, ChapterFinale>> {
  const out = new Map<number, ChapterFinale>();
  if (!books || typeof books.get !== "function" || !(chapterCount > 0)) return out;
  const nums = Array.from({ length: chapterCount }, (_, i) => i + 1);
  const found = await Promise.all(
    nums.map(async (n) => {
      try {
        const obj = await books.get(`books/${slug}/plans/S${n}.json`);
        if (!obj) return null;
        const plan = JSON.parse(await obj.text());
        const fin = plan?.finale;
        const imageKey = typeof fin?.imageKey === "string" ? fin.imageKey.trim() : "";
        if (!imageKey) return null;
        const imageColorKey =
          typeof fin?.imageColorKey === "string" ? fin.imageColorKey.trim() : "";
        return {
          n,
          finale: {
            text: typeof fin.storyText === "string" ? fin.storyText : "",
            imageKey,
            ...(imageColorKey ? { imageColorKey } : {}),
          } as ChapterFinale,
        };
      } catch {
        return null;
      }
    })
  );
  for (const f of found) if (f) out.set(f.n, f.finale);
  return out;
}

/**
 * Return chaptersRaw with each chapter's finale page appended (as the
 * chapter's last page, shaped like a stored page plus `finale: true`)
 * when a finale is known for that chapter, its art is not already one
 * of the chapter's pages, and — when lineKeys is given (the book's
 * actual line-image keys from an R2 listing) — the finale art exists.
 * Chapters that fail any check pass through untouched.
 */
export function withFinalePages(
  chaptersRaw: any[],
  finales: Map<number, ChapterFinale>,
  lineKeys?: Set<string>
): any[] {
  if (!Array.isArray(chaptersRaw)) return chaptersRaw;
  if (!finales || finales.size === 0) return chaptersRaw;
  return chaptersRaw.map((ch: any, ci: number) => {
    const fin = finales.get(ci + 1);
    if (!fin) return ch;
    const pages = Array.isArray(ch?.pages) ? ch.pages : [];
    if (pages.some((pg: any) => pageImageKey(pg) === fin.imageKey)) return ch;
    if (lineKeys && !lineKeys.has(fin.imageKey)) return ch;
    return {
      ...ch,
      pages: [
        ...pages,
        {
          text: fin.text,
          image: fin.imageKey,
          ...(fin.imageColorKey ? { imageColor: fin.imageColorKey } : {}),
          character: "",
          concept: "",
          finale: true,
        },
      ],
    };
  });
}

/** Convenience: load finales for a stored chapter list and reconcile. */
export async function loadFullChapters(
  books: any,
  slug: string,
  chaptersRaw: any[],
  lineKeys?: Set<string>
): Promise<any[]> {
  if (!Array.isArray(chaptersRaw) || chaptersRaw.length === 0) return chaptersRaw;
  const finales = await loadChapterFinales(books, slug, chaptersRaw.length).catch(
    () => new Map<number, ChapterFinale>()
  );
  return withFinalePages(chaptersRaw, finales, lineKeys);
}
