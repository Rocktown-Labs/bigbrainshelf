// Voice casting registry: casting is per CHARACTER and persistent across
// books and versions (CG's casting model, 2026-10-28). A character, once
// assigned a Gemini voice, keeps that voice in every book where they
// appear and in every future version of their books. The protagonist's
// voice locks three roles at once: narrator, main character, promo voice.
//
// Storage: D1 tables character_voices (the registry) and
// voice_assignment_log (audit trail), plus a full-registry JSON export at
// the BOOKS bucket root (cast-registry.json) for books-side consumers.
// The B Team (Aura) data in cast.ts / cast_ratings is untouched.
import { findGeminiVoice } from "./cast-gemini";
import snippetsData from "../data/cast/snippets.json";

export interface CastCharacter {
  name: string;
  species: string;
  role: "protagonist" | "supporting";
}

export interface CastLine {
  id: string;
  character: string;
  label: string;
  text: string;
  // R2 cache namespace for generated audio: the book slug for derived
  // line sets, null for Mira's curated set (which uses the legacy
  // pre-generated cache keys).
  cacheBook: string | null;
}

export interface RegistryRow {
  character_name: string;
  voice_id: string | null;
  voice_name: string | null;
  first_book_slug: string | null;
  source: string; // "recorded" (shipped audiobook cast) | "admin"
  updated_at: number;
}

// The casts that already shipped in published audiobooks. These are the
// working casts of record (revisable from the casting page like any
// other assignment); they seed the registry so it starts truthful.
export const RECORDED_CASTS: { character: string; voiceId: string; bookSlug: string }[] = [
  { character: "Mira", voiceId: "kore", bookSlug: "mira-the-heron-and-the-still-water" },
  { character: "Wells", voiceId: "riko", bookSlug: "docker" },
  { character: "Blaze", voiceId: "enzo", bookSlug: "designpatterns" },
];

export async function ensureCastTables(db: any): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS character_voices (
      character_name TEXT PRIMARY KEY,
      voice_id TEXT,
      voice_name TEXT,
      first_book_slug TEXT,
      source TEXT NOT NULL DEFAULT 'admin',
      updated_at INTEGER
    )`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS voice_assignment_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name TEXT,
      voice_id TEXT,
      book_slug TEXT,
      action TEXT,
      created_at INTEGER
    )`
  ).run();
}

// Insert the recorded casts if the registry does not know those
// characters yet. Returns true when any row was inserted.
export async function seedRecordedCasts(db: any): Promise<boolean> {
  let inserted = false;
  const now = Math.floor(Date.now() / 1000);
  for (const rc of RECORDED_CASTS) {
    const voice = findGeminiVoice(rc.voiceId);
    const res: any = await db
      .prepare(
        `INSERT OR IGNORE INTO character_voices
           (character_name, voice_id, voice_name, first_book_slug, source, updated_at)
         VALUES (?, ?, ?, ?, 'recorded', ?)`
      )
      .bind(rc.character, rc.voiceId, voice?.name ?? rc.voiceId, rc.bookSlug, now)
      .run();
    if (res?.meta?.changes) inserted = true;
  }
  return inserted;
}

export async function getRegistry(db: any): Promise<RegistryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT character_name, voice_id, voice_name, first_book_slug, source, updated_at
       FROM character_voices ORDER BY character_name`
    )
    .all();
  return (results || []) as RegistryRow[];
}

export async function getAssignmentLog(db: any, limit = 50): Promise<any[]> {
  const { results } = await db
    .prepare(
      `SELECT id, character_name, voice_id, book_slug, action, created_at
       FROM voice_assignment_log ORDER BY id DESC LIMIT ?`
    )
    .bind(limit)
    .all();
  return results || [];
}

// Write the full registry to R2 for books-side consumers.
export async function exportRegistry(db: any, books: any): Promise<void> {
  const rows = await getRegistry(db);
  const characters: Record<string, any> = {};
  for (const r of rows) {
    characters[r.character_name] = {
      voice_id: r.voice_id,
      voice_name: r.voice_name,
      first_book_slug: r.first_book_slug,
      source: r.source,
      updated_at: r.updated_at,
    };
  }
  const payload = {
    updated_at: Math.floor(Date.now() / 1000),
    characters,
  };
  await books.put("cast-registry.json", JSON.stringify(payload, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

// Assign (or change) a character's voice. Writes the registry row, the
// audit log, and refreshes the R2 export. Re-assigning the voice the
// character already has is a no-op.
export async function assignVoice(
  db: any,
  books: any,
  input: { characterName: string; voiceId: string; bookSlug: string }
): Promise<{ row: RegistryRow; action: "assign" | "change" | "noop" }> {
  const characterName = String(input.characterName || "").trim();
  const voice = findGeminiVoice(String(input.voiceId || "").toLowerCase());
  if (!characterName) throw new Error("character_name required");
  if (!voice) throw new Error(`Unknown Gemini voice "${input.voiceId}"`);
  const bookSlug = String(input.bookSlug || "").trim();

  const existing: RegistryRow | null = await db
    .prepare(`SELECT * FROM character_voices WHERE character_name = ?`)
    .bind(characterName)
    .first();
  if (existing && existing.voice_id === voice.id) {
    return { row: existing, action: "noop" };
  }
  const action = existing && existing.voice_id ? "change" : "assign";
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO character_voices
         (character_name, voice_id, voice_name, first_book_slug, source, updated_at)
       VALUES (?, ?, ?, ?, 'admin', ?)
       ON CONFLICT(character_name) DO UPDATE SET
         voice_id = excluded.voice_id,
         voice_name = excluded.voice_name,
         source = 'admin',
         updated_at = excluded.updated_at`
    )
    .bind(characterName, voice.id, voice.name, existing?.first_book_slug || bookSlug || null, now)
    .run();
  await db
    .prepare(
      `INSERT INTO voice_assignment_log (character_name, voice_id, book_slug, action, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(characterName, voice.id, bookSlug || null, action, now)
    .run();
  await exportRegistry(db, books);
  const row: RegistryRow = (await db
    .prepare(`SELECT * FROM character_voices WHERE character_name = ?`)
    .bind(characterName)
    .first()) as RegistryRow;
  return { row, action };
}

// Cast of one book from its bible JSON, tolerant of both bible shapes
// (canonical characters[] and generated protagonist/supportingCast/
// newCharacters), mirroring the summarizer in /api/bibles.ts.
export function bibleCast(data: any): CastCharacter[] {
  const protagonistName = data?.protagonist?.name ?? null;
  const raw =
    Array.isArray(data?.characters) && data.characters.length
      ? data.characters
      : [data?.protagonist, ...(data?.supportingCast ?? []), ...(data?.newCharacters ?? [])].filter(Boolean);
  const seen = new Set<string>();
  const out: CastCharacter[] = [];
  for (const c of raw) {
    const name = String(c?.name ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      species: String(c?.species ?? ""),
      role: protagonistName && name === protagonistName ? "protagonist" : "supporting",
    });
  }
  if (out.length && !out.some((c) => c.role === "protagonist")) out[0].role = "protagonist";
  return out;
}

function trimToSentence(text: string, max = 480): string {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (end > 120 ? cut.slice(0, end + 1) : cut).trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A line of dialogue for a character, pulled from the book's page texts:
// quoted speech attributed to them when we can find it, else the full
// page text that carries their quote, else a narration page naming them.
export function findCharacterLine(pages: string[], name: string): string | null {
  const n = escapeRe(name);
  const saidAfter = new RegExp(`"([^"]{20,320})"\\s*(?:,\\s*)?(?:said|asked|whispered|called|cried)\\s+${n}\\b`);
  const saidBefore = new RegExp(`\\b${n}\\s+(?:said|asked|whispered|called|cried)[,:]?\\s*"([^"]{20,320})"`);
  for (const page of pages) {
    const m = page.match(saidAfter) || page.match(saidBefore);
    if (m) {
      const quote = m[1].trim();
      if (quote.length >= 60) return trimToSentence(quote, 420);
      // Short quote: read the whole page so the audition has context.
      return trimToSentence(page);
    }
  }
  const named = new RegExp(`\\b${n}\\b`);
  for (const page of pages) {
    if (named.test(page)) return trimToSentence(page);
  }
  return null;
}

// The audition line set for a book. Mira keeps her curated snippet set
// (the featured auditions are pre-generated against those exact texts);
// every other book derives its lines from its stored chapter texts.
export async function lineSetForBook(
  books: any,
  slug: string,
  title: string,
  characters: CastCharacter[]
): Promise<CastLine[]> {
  if (slug === "mira-the-heron-and-the-still-water") {
    const mira: any = ((snippetsData as any).books || []).find((b: any) => b.id === "mira");
    if (mira) {
      return mira.snippets.map((s: any) => ({
        id: s.id,
        character: s.character,
        label: s.label,
        text: s.text,
        cacheBook: null,
      }));
    }
  }
  const lines: CastLine[] = [];
  lines.push({
    id: "presents",
    character: "Promo",
    label: "Presents intro",
    text: `Big Brain Shelf presents: ${title}.`,
    cacheBook: slug,
  });
  try {
    const obj = await books.get(`books/${slug}/editor_chapters.json`);
    if (obj) {
      const chapters = JSON.parse(await obj.text());
      const pages: string[] = [];
      for (const ch of chapters || []) {
        for (const p of ch?.pages || []) {
          if (p?.text) pages.push(String(p.text));
        }
      }
      if (pages.length) {
        let narration = pages[0];
        if (narration.length < 200 && pages[1]) narration = narration + " " + pages[1];
        lines.push({
          id: "narrator",
          character: "Narrator",
          label: "Narrator paragraph, Ch. 1",
          text: trimToSentence(narration),
          cacheBook: slug,
        });
        for (const c of characters) {
          const line = findCharacterLine(pages, c.name);
          if (line) {
            lines.push({
              id: c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
              character: c.name,
              label: `${c.name} speaks`,
              text: line,
              cacheBook: slug,
            });
          }
        }
      }
    }
  } catch { /* a book without chapter data still gets its presents line */ }
  return lines;
}
