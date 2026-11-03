// Publish readiness: the audio leg of CG's publish loop (2026-10-28).
//
// A draft audiobook in a placeholder voice is a QC read-back tool.
// Once a book's protagonist is cast, the FINAL audiobook is generated
// in that cast voice, and publishing gates on the pair matching:
// the protagonist must be cast in the voice registry, an audiobook
// must exist, and its voice stamp (books/{slug}/audiobook-meta.json,
// written by the generator) must name the cast voice. Colorize is
// deliberately NOT part of readiness.
//
// Voice ids arrive in three spellings and are normalized before any
// comparison: the registry's catalog ids ("kore", "enzo"), the
// callable ids the generator stamps ("Kore", "en-us-enzo"), and the
// display names ("Kore", "Enzo") all resolve through the Gemini voice
// catalog to the same catalog id.
import { findGeminiVoice, geminiVoices } from "./cast-gemini";
import {
  bibleCast,
  ensureCastTables,
  seedRecordedCasts,
  type CastCharacter,
} from "./cast-registry";
import { readVoiceStamp, type AudiobookVoiceStamp } from "./audiobooks";

/** Any spelling of a voice -> the catalog id ("kore"), or the
 *  lowercased input when the catalog does not know it. */
export function normalizeVoiceId(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  const byCallable = geminiVoices().find((v) => v.voice.toLowerCase() === s);
  if (byCallable) return byCallable.id;
  const byId = findGeminiVoice(s);
  if (byId) return byId.id;
  if (s.startsWith("en-us-")) return s.slice("en-us-".length);
  if (s.startsWith("en_us_")) return s.slice("en_us_".length);
  return s;
}

/** Human-facing voice name for any spelling ("en-us-enzo" -> "Enzo"). */
export function voiceDisplayName(raw: unknown): string | null {
  const id = normalizeVoiceId(raw);
  if (!id) return null;
  const v = findGeminiVoice(id);
  if (v) return v.name;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export type PublishAudioState = "final" | "draft-audio" | "no-audiobook" | "no-cast";

export interface PublishReadiness {
  slug: string;
  title: string;
  bookStatus: string | null;
  protagonist: string | null;
  castVoiceId: string | null;
  castVoiceName: string | null;
  audiobookKey: string | null;
  audiobookExists: boolean;
  stamp: AudiobookVoiceStamp | null;
  audiobookVoiceId: string | null;
  audiobookVoiceName: string | null;
  state: PublishAudioState;
  ready: boolean;
  blockers: string[];
  statusLabel: string;
}

export interface ReadinessInput {
  slug: string;
  title: string;
  bookStatus: string | null;
  protagonist: string | null;
  castVoiceId: string | null; // raw registry voice_id, any spelling
  audiobookKey: string | null;
  audiobookFileExists: boolean; // resolved by the caller (R2 head)
  stamp: AudiobookVoiceStamp | null;
}

/** The pure gate decision: facts in, state + plain-language blockers out. */
export function computeReadiness(input: ReadinessInput): PublishReadiness {
  const castVoiceId = normalizeVoiceId(input.castVoiceId);
  const castVoiceName = castVoiceId ? voiceDisplayName(castVoiceId) : null;
  const audiobookVoiceId = input.stamp ? normalizeVoiceId(input.stamp.voiceId) : null;
  const audiobookVoiceName = input.stamp ? voiceDisplayName(input.stamp.voiceId) : null;
  const audiobookExists = !!input.audiobookKey && input.audiobookFileExists;
  const hero = input.protagonist || "The protagonist";

  const blockers: string[] = [];
  if (!castVoiceId) {
    if (audiobookExists) {
      const heard = audiobookVoiceName
        ? ` The audiobook on file is a draft read in ${audiobookVoiceName}.`
        : ` The audiobook on file is a draft read back for QC.`;
      blockers.push(
        `${hero} is not cast yet.${heard} Cast ${hero} on the Casting page, then generate the final audiobook in their cast voice before publishing.`
      );
    } else {
      blockers.push(
        `${hero} is not cast yet, and no audiobook has been generated. Cast ${hero} on the Casting page, then generate the final audiobook in their cast voice before publishing.`
      );
    }
  } else if (!audiobookExists) {
    blockers.push(
      `No audiobook has been generated for this book. Generate the final audiobook in ${hero}'s cast voice (${castVoiceName}) before publishing.`
    );
  } else if (audiobookVoiceId !== castVoiceId) {
    if (!input.stamp) {
      blockers.push(
        `The audiobook on file has no voice stamp, so it cannot be confirmed as the final read. Regenerate the audiobook in ${hero}'s cast voice (${castVoiceName}) so the final read is stamped, then publish.`
      );
    } else {
      blockers.push(
        `The audiobook is a draft read in ${audiobookVoiceName}, but ${hero} is cast as ${castVoiceName}. Generate the final audiobook in ${castVoiceName} before publishing.`
      );
    }
  }

  const state: PublishAudioState = !castVoiceId
    ? "no-cast"
    : !audiobookExists
      ? "no-audiobook"
      : audiobookVoiceId !== castVoiceId
        ? "draft-audio"
        : "final";

  const statusLabel =
    state === "final"
      ? "Final"
      : state === "draft-audio"
        ? `Draft read in ${audiobookVoiceName ?? "an unstamped voice"}`
        : state === "no-audiobook"
          ? "Not generated"
          : `${hero} not cast yet`;

  return {
    slug: input.slug,
    title: input.title,
    bookStatus: input.bookStatus,
    protagonist: input.protagonist,
    castVoiceId,
    castVoiceName,
    audiobookKey: input.audiobookKey,
    audiobookExists,
    stamp: input.stamp,
    audiobookVoiceId,
    audiobookVoiceName,
    state,
    ready: blockers.length === 0,
    blockers,
    statusLabel,
  };
}

// ---- The gate decision, including the let-it-ride override --------------

/**
 * The publish endpoint's audio-gate decision. Default: an unready
 * book is refused with its blockers. With an explicit override (CG's
 * deliberate "let it ride" click), the audio reasons are waived and
 * the publish proceeds, but the waiver must be recorded. The override
 * governs ONLY this audio gate: every other publish precondition
 * (page approvals above all) is checked separately and is never
 * touched by the flag.
 */
export function audioGateDecision(
  readiness: PublishReadiness | null,
  override: boolean
): { block: boolean; recordOverride: boolean } {
  if (readiness?.ready) return { block: false, recordOverride: false };
  if (override) return { block: false, recordOverride: true };
  return { block: true, recordOverride: false };
}

export interface PublishOverrideRecord {
  id: number;
  book_slug: string;
  created_at: number;
  reasons: string[];
  state: string;
  protagonist: string | null;
  cast_voice_id: string | null;
  audiobook_voice_id: string | null;
}

export async function ensurePublishOverridesTable(db: any): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS publish_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_slug TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        reasons TEXT NOT NULL,
        state TEXT NOT NULL,
        protagonist TEXT,
        cast_voice_id TEXT,
        audiobook_voice_id TEXT
      )`
    )
    .run();
}

/** Durable record of one let-it-ride publish: what was waived, and
 *  the cast/audio state at the moment it was waived. */
export async function recordPublishOverride(
  db: any,
  readiness: PublishReadiness,
  nowSec: number
): Promise<void> {
  await ensurePublishOverridesTable(db);
  await db
    .prepare(
      `INSERT INTO publish_overrides
         (book_slug, created_at, reasons, state, protagonist, cast_voice_id, audiobook_voice_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      readiness.slug,
      nowSec,
      JSON.stringify(readiness.blockers),
      readiness.state,
      readiness.protagonist,
      readiness.castVoiceId,
      readiness.audiobookVoiceId
    )
    .run();
}

/** A book's override history, newest first (empty when none). */
export async function getPublishOverrides(
  db: any,
  slug: string
): Promise<PublishOverrideRecord[]> {
  try {
    await ensurePublishOverridesTable(db);
    const { results } = await db
      .prepare(
        `SELECT id, book_slug, created_at, reasons, state, protagonist, cast_voice_id, audiobook_voice_id
         FROM publish_overrides WHERE book_slug = ? ORDER BY id DESC`
      )
      .bind(slug)
      .all();
    return ((results || []) as any[]).map((r) => ({
      id: r.id,
      book_slug: r.book_slug,
      created_at: r.created_at,
      reasons: safeJsonArray(r.reasons),
      state: r.state,
      protagonist: r.protagonist ?? null,
      cast_voice_id: r.cast_voice_id ?? null,
      audiobook_voice_id: r.audiobook_voice_id ?? null,
    }));
  } catch {
    return [];
  }
}

function safeJsonArray(raw: unknown): string[] {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

// ---- DB/R2 assembly ----------------------------------------------------

async function protagonistForBook(db: any, slug: string): Promise<string | null> {
  try {
    const row = await db
      .prepare(`SELECT data FROM bibles WHERE book_slug = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(slug)
      .first();
    if (!row?.data) return null;
    const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    const cast: CastCharacter[] = bibleCast(data);
    return cast.find((c) => c.role === "protagonist")?.name ?? cast[0]?.name ?? null;
  } catch {
    return null;
  }
}

async function castVoiceFor(db: any, characterName: string | null): Promise<string | null> {
  if (!characterName) return null;
  try {
    const row = await db
      .prepare(`SELECT voice_id FROM character_voices WHERE character_name = ?`)
      .bind(characterName)
      .first();
    return row?.voice_id ? String(row.voice_id) : null;
  } catch {
    return null;
  }
}

async function assembleReadiness(
  books: any,
  book: { slug: string; title: string; status: string | null; audiobook_key: string | null },
  protagonist: string | null,
  castVoiceId: string | null
): Promise<PublishReadiness> {
  const key = book.audiobook_key ? String(book.audiobook_key) : null;
  let fileExists = false;
  if (key && books && typeof books.head === "function") {
    try {
      fileExists = !!(await books.head(key));
    } catch {
      throw new Error("Audiobook existence could not be verified");
    }
  }
  const stamp = key ? await readVoiceStamp(books, key) : null;
  return computeReadiness({
    slug: book.slug,
    title: book.title,
    bookStatus: book.status,
    protagonist,
    castVoiceId,
    audiobookKey: key,
    audiobookFileExists: fileExists,
    stamp,
  });
}

/**
 * Readiness for one book, straight from D1 + R2. Ensures the cast
 * registry exists and the recorded casts are seeded first, so a book
 * whose audiobook already shipped in its cast voice reads as cast
 * even if the Casting page was never opened. Returns null when the
 * book row does not exist.
 */
export async function getPublishReadiness(
  db: any,
  books: any,
  slug: string,
  options: { readOnly?: boolean } = {}
): Promise<PublishReadiness | null> {
  if (!options.readOnly) {
    try { await ensureCastTables(db); } catch { /* reads below expose missing state */ }
    try { await seedRecordedCasts(db); } catch { /* reads below expose missing state */ }
  }
  const book = await db
    .prepare(`SELECT slug, title, status, audiobook_key FROM books WHERE slug = ?`)
    .bind(slug)
    .first();
  if (!book) return null;
  const protagonist = await protagonistForBook(db, slug);
  const castVoiceId = await castVoiceFor(db, protagonist);
  return assembleReadiness(books, book, protagonist, castVoiceId);
}

/** Readiness for every non-failed book (the Casting page's overview). */
export async function listPublishReadiness(db: any, books: any): Promise<PublishReadiness[]> {
  try { await ensureCastTables(db); } catch { /* as above */ }
  try { await seedRecordedCasts(db); } catch { /* as above */ }
  const { results: bookRows } = await db
    .prepare(`SELECT slug, title, status, audiobook_key FROM books WHERE status != 'failed' ORDER BY title`)
    .all();
  const { results: bibleRows } = await db.prepare(`SELECT book_slug, data FROM bibles`).all();
  const castBySlug = new Map<string, CastCharacter[]>();
  for (const r of (bibleRows || []) as any[]) {
    let data: any = null;
    try { data = typeof r.data === "string" ? JSON.parse(r.data) : r.data; } catch { /* no cast */ }
    if (data) castBySlug.set(r.book_slug, bibleCast(data));
  }
  const { results: voiceRows } = await db
    .prepare(`SELECT character_name, voice_id FROM character_voices`)
    .all();
  const voiceByName = new Map<string, string | null>();
  for (const r of (voiceRows || []) as any[]) voiceByName.set(r.character_name, r.voice_id ?? null);

  const out: PublishReadiness[] = [];
  for (const b of (bookRows || []) as any[]) {
    const cast = castBySlug.get(b.slug) || [];
    const protagonist =
      cast.find((c) => c.role === "protagonist")?.name ?? cast[0]?.name ?? null;
    const castVoiceId = protagonist ? (voiceByName.get(protagonist) ?? null) : null;
    out.push(await assembleReadiness(books, b, protagonist, castVoiceId));
  }
  return out;
}
