// Locale string registry for the externalized surfaces.
//
// stringsFor(lang) returns the catalog for a supported language and
// falls back to English for any language whose catalog has not landed
// yet, so a route can ask for its language's strings without branching.
// As the factory template packs arrive, each language gains a file
// here implementing the same interfaces; nothing else changes.

import { BOOK_PAGE_STRINGS_EN, type BookPageStrings } from "./en";
import { BOOK_PAGE_STRINGS_ES } from "./es";

const BOOK_PAGE_STRINGS: Record<string, BookPageStrings> = {
  en: BOOK_PAGE_STRINGS_EN,
  es: BOOK_PAGE_STRINGS_ES,
};

export function bookPageStrings(lang: string): BookPageStrings {
  return BOOK_PAGE_STRINGS[String(lang || "en")] ?? BOOK_PAGE_STRINGS_EN;
}

export type { BookPageStrings };
