// Language data layer for localized book editions (i18n Phase 0).
//
// The store's canonical catalog is English and lives in D1 (the books
// row). A translated edition is a PACKAGE in the factory R2 bucket at
// books/{slug}/i18n/{lang}/, produced and validated by the factory
// translation pipeline (see the pilot at factory-ops/translation-
// pilot): segments.json carries the localized title, description,
// chapter titles, glossary pairs, and back-cover copy as flat
// [[segment]] keys. This module is the only place that knows that
// layout: it loads a package, shapes it for templates, and falls back
// to the English D1 fields when no package exists, so callers ask for
// "this book in language X" and never branch on storage.
//
// Routing is Astro's built-in i18n (astro.config.mjs): locales are
// en/es/pt/fr/de/it/nl with prefixDefaultLocale off, so English URLs
// are unprefixed and every other locale is /{lang}/... URL building
// goes through astro:i18n's getRelativeLocaleUrl, never string
// concatenation, so the framework owns the path shape as locales land.

import { getRelativeLocaleUrl } from "astro:i18n";

export type LangCode = "en" | "es" | "pt" | "fr" | "de" | "it" | "nl";

/** source: the canonical English catalog. stored: at least one
 *  validated edition package exists in R2. empty: a launch language
 *  with nothing stored yet (routes 404, config ready). */
export type LangStatus = "source" | "stored" | "empty";

export interface SupportedLanguage {
  code: LangCode;
  /** BCP 47 tag for Intl formatters and the document lang attribute. */
  bcp47: string;
  /** og:locale value for pages in this language. */
  ogLocale: string;
  /** The language's own name for itself (future switcher/admin use). */
  label: string;
  /** The language's name in that language, for buyer-facing badges
   *  (the language seal on localized book covers). */
  endonym: string;
  /** The word for "Audiobook" in this language, for the red
   *  audiobook pill on audiobook detail covers. */
  audiobookLabel: string;
  status: LangStatus;
  /** Edition packages currently stored in R2 for this language. */
  storedEditions: number;
}

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: "en", bcp47: "en", ogLocale: "en_US", label: "English", endonym: "English", audiobookLabel: "Audiobook", status: "source", storedEditions: 0 },
  { code: "es", bcp47: "es", ogLocale: "es_LA", label: "Español", endonym: "Español", audiobookLabel: "Audiolibro", status: "stored", storedEditions: 1 },
  { code: "pt", bcp47: "pt", ogLocale: "pt_BR", label: "Português", endonym: "Português", audiobookLabel: "Audiolivro", status: "empty", storedEditions: 0 },
  { code: "fr", bcp47: "fr", ogLocale: "fr_FR", label: "Français", endonym: "Français", audiobookLabel: "Livre audio", status: "empty", storedEditions: 0 },
  { code: "de", bcp47: "de", ogLocale: "de_DE", label: "Deutsch", endonym: "Deutsch", audiobookLabel: "Hörbuch", status: "empty", storedEditions: 0 },
  { code: "it", bcp47: "it", ogLocale: "it_IT", label: "Italiano", endonym: "Italiano", audiobookLabel: "Audiolibro", status: "empty", storedEditions: 0 },
  { code: "nl", bcp47: "nl", ogLocale: "nl_NL", label: "Nederlands", endonym: "Nederlands", audiobookLabel: "Luisterboek", status: "empty", storedEditions: 0 },
];

export const DEFAULT_LANG: LangCode = "en";
export const SITE_ORIGIN = "https://bigbrainshelf.com";

export function languageDef(lang: string): SupportedLanguage {
  return (
    SUPPORTED_LANGUAGES.find((l) => l.code === lang) ??
    SUPPORTED_LANGUAGES[0]
  );
}

/** The word for "Audiobook" in a language (the audiobook cover pill). */
export function audiobookLabelFor(lang: string): string {
  return languageDef(lang).audiobookLabel;
}

export function isSupportedLanguage(lang: string): lang is LangCode {
  return SUPPORTED_LANGUAGES.some((l) => l.code === lang);
}

/** BCP 47 locale for Intl formatters and <html lang>. */
export function localeFor(lang: string): string {
  return languageDef(lang).bcp47;
}

// ---------------------------------------------------------------------------
// Localized edition packages (R2)
// ---------------------------------------------------------------------------

export interface LocalizedChapter {
  n: number;
  title: string;
}

export interface LocalizedGlossaryEntry {
  term: string;
  story: string;
}

export interface LocalizedBackCover {
  blurb: string | null;
  bigIdea: string | null;
  bullets: string[];
}

export interface LocalizedBookPackage {
  /** Internal book slug (the storage key, never a display value). */
  slug: string;
  language: LangCode;
  sourceLanguage: string;
  segmentCount: number | null;
  title: string;
  description: string | null;
  chapters: LocalizedChapter[];
  glossary: LocalizedGlossaryEntry[];
  backCover: LocalizedBackCover;
  /** The raw segment map, for segments the shaped view does not surface yet. */
  segments: Record<string, string>;
}

function shapePackage(raw: any, slug: string, lang: LangCode): LocalizedBookPackage | null {
  const segments = raw?.segments;
  if (!segments || typeof segments !== "object") return null;
  const title = String(segments["meta.title"] || "").trim();
  if (!title) return null;

  const chapters: LocalizedChapter[] = [];
  const glossaryByN = new Map<number, LocalizedGlossaryEntry>();
  const bullets: Array<[number, string]> = [];
  for (const [key, value] of Object.entries(segments)) {
    const v = String(value ?? "");
    let m = key.match(/^ch(\d+)\.title$/);
    if (m) {
      chapters.push({ n: Number(m[1]), title: v });
      continue;
    }
    m = key.match(/^glossary\.(\d+)\.(term|story)$/);
    if (m) {
      const entry = glossaryByN.get(Number(m[1])) ?? { term: "", story: "" };
      entry[m[2] as "term" | "story"] = v;
      glossaryByN.set(Number(m[1]), entry);
      continue;
    }
    m = key.match(/^backcover\.bullet(\d+)$/);
    if (m) bullets.push([Number(m[1]), v]);
  }
  chapters.sort((a, b) => a.n - b.n);
  bullets.sort((a, b) => a[0] - b[0]);

  return {
    slug,
    language: lang,
    sourceLanguage: String(raw?.source_language || "en"),
    segmentCount: typeof raw?.segment_count === "number" ? raw.segment_count : null,
    title,
    description: String(segments["meta.description"] || "").trim() || null,
    chapters,
    glossary: [...glossaryByN.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, e]) => e)
      .filter((e) => e.term || e.story),
    backCover: {
      blurb: String(segments["backcover.blurb"] || "").trim() || null,
      bigIdea: String(segments["backcover.bigidea"] || "").trim() || null,
      bullets: bullets.map(([, v]) => v).filter(Boolean),
    },
    segments,
  };
}

/**
 * Load a book's localized edition package from R2
 * (books/{slug}/i18n/{lang}/segments.json). Returns null for English
 * (the D1 row IS the English edition), for unsupported languages, and
 * for any book/language pair with nothing stored: callers fall back to
 * English data or 404, per route policy. Never throws.
 */
export async function loadLocalizedBook(
  env: any,
  slug: string,
  lang: string
): Promise<LocalizedBookPackage | null> {
  if (!slug || !isSupportedLanguage(lang) || lang === DEFAULT_LANG) return null;
  const bucket = env?.BOOKS;
  if (!bucket || typeof bucket.get !== "function") return null;
  try {
    const obj = await bucket.get(`books/${slug}/i18n/${lang}/segments.json`);
    if (!obj) return null;
    const raw = JSON.parse(await obj.text());
    return shapePackage(raw, slug, lang);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Text resolution: localized package first, English D1 row as fallback
// ---------------------------------------------------------------------------

export interface BookText {
  title: string;
  description: string | null;
  chapters: LocalizedChapter[];
  glossary: LocalizedGlossaryEntry[];
  backCover: LocalizedBackCover | null;
  /** True when the text came from a stored localized package. */
  localized: boolean;
}

/**
 * The display text for a book in a language. With a package, every
 * field comes from it. Without one, the English D1 fields carry the
 * title and description; the chapter/glossary/back-cover fields stay
 * empty because on the English side those live in the factory files,
 * not the books row (the English book page assembles them elsewhere).
 */
export function bookTextFor(book: any, pkg: LocalizedBookPackage | null): BookText {
  if (pkg) {
    return {
      title: pkg.title,
      description: pkg.description,
      chapters: pkg.chapters,
      glossary: pkg.glossary,
      backCover: pkg.backCover,
      localized: true,
    };
  }
  return {
    title: String(book?.title || ""),
    description: book?.description ? String(book.description) : null,
    chapters: [],
    glossary: [],
    backCover: null,
    localized: false,
  };
}

// ---------------------------------------------------------------------------
// Intl formatting (Phase 0 item 1: one money/date door, locale-parameterized)
// ---------------------------------------------------------------------------

/** Format integer cents in a language's conventions (currency stays USD until Phase 1's presentment decision). */
export function formatMoneyCents(
  cents: number,
  lang: string,
  currency = "USD"
): string {
  return new Intl.NumberFormat(localeFor(lang), {
    style: "currency",
    currency,
  }).format((Number(cents) || 0) / 100);
}

/** Format an epoch-ms timestamp (or Date) in a language's conventions, on the house timezone. */
export function formatDateInLang(value: number | Date, lang: string): string {
  const d = value instanceof Date ? value : new Date(Number(value) || 0);
  return new Intl.DateTimeFormat(localeFor(lang), {
    dateStyle: "long",
    timeZone: "America/Chicago",
  }).format(d);
}

// ---------------------------------------------------------------------------
// Locale URLs (astro:i18n owns the path shape)
// ---------------------------------------------------------------------------

/** The book page path for a language: /books/{slug} for English, /{lang}/books/{slug} otherwise. */
export function bookPathForLocale(lang: string, publicSlug: string): string {
  const p = getRelativeLocaleUrl(lang, `/books/${publicSlug}`);
  // getRelativeLocaleUrl returns trailing-slash paths; the store's
  // canonical URLs (SeoHead) carry no trailing slash, so hreflang and
  // cross-locale links must not either.
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** Absolute URL for hreflang/canonical-style links. */
export function absoluteUrl(path: string): string {
  return new URL(path, SITE_ORIGIN).href;
}
