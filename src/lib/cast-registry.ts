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

/* ---------- scenes (redesign S3, 2026-11-03) ----------
 * A scene is one stored page parsed into speaking turns: narration
 * segments (speaker "Narrator", read in the protagonist's voice) and
 * dialogue segments attributed to a cast member by the same said-after /
 * said-before patterns findCharacterLine uses. Scene auditions play the
 * turns in order, so a supporting character is heard in context against
 * the locked cast voices instead of as an isolated line. */

export interface CastSceneSegment {
  speaker: string; // a character name, or "Narrator"
  text: string;
}

export interface CastScene {
  id: string;
  label: string;
  chapter: number;
  segments: CastSceneSegment[];
}

const SPEECH_VERBS =
  "said|asked|whispered|called|cried|murmured|replied|answered|shouted|laughed|purred|growled|sang|hissed|barked";

// Who speaks a quoted span, from the narration touching it. The text
// AFTER the quote is the stronger signal ("...", said Mira), then the
// text before it (Mira said, "..."). Returns null when neither names a
// cast member.
function attributeQuote(before: string, after: string, names: string[]): string | null {
  const afterHead = after.slice(0, 160);
  const beforeTail = before.slice(-160);
  for (const name of names) {
    const n = escapeRe(name);
    if (
      new RegExp(`^[\\s,;:]*?(?:${SPEECH_VERBS})\\s+${n}\\b`, "i").test(afterHead) ||
      new RegExp(`^[\\s,;:]*?${n}\\s+(?:${SPEECH_VERBS})\\b`, "i").test(afterHead)
    ) {
      return name;
    }
  }
  for (const name of names) {
    const n = escapeRe(name);
    if (
      new RegExp(`\\b${n}\\s+(?:${SPEECH_VERBS})[,:]?\\s*$`, "i").test(beforeTail) ||
      new RegExp(`(?:${SPEECH_VERBS})\\s+${n}[,:]?\\s*$`, "i").test(beforeTail)
    ) {
      return name;
    }
  }
  return null;
}

// Remove an attribution phrase ("said Mira.", "Mira said,") from the
// edge of a narration chunk so it is never read aloud as narration.
function stripAttribution(chunk: string, names: string[], edge: "start" | "end"): string {
  const alt = names.map(escapeRe).join("|");
  if (!alt) return chunk;
  if (edge === "start") {
    return chunk
      .replace(new RegExp(`^[\\s,;:]*?(?:${alt})\\s+(?:${SPEECH_VERBS})\\b[.,;:]?\\s*`, "i"), "")
      .replace(new RegExp(`^[\\s,;:]*?(?:${SPEECH_VERBS})\\s+(?:${alt})\\b[.,;:]?\\s*`, "i"), "");
  }
  return chunk
    .replace(new RegExp(`[\\s,]*?(?:${alt})\\s+(?:${SPEECH_VERBS})[,:]?\\s*$`, "i"), "")
    .replace(new RegExp(`[\\s,]*(?:${SPEECH_VERBS})\\s+(?:${alt})[,:]?\\s*$`, "i"), "");
}

// Parse one page of story text into speaking turns. Quotes no cast
// member claims fold into the narration around them.
export function parsePageSegments(pageText: string, names: string[]): CastSceneSegment[] {
  const text = String(pageText || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const chunks: { quote: boolean; value: string }[] = [];
  const re = /"([^"]{1,900})"/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) chunks.push({ quote: false, value: text.slice(last, m.index) });
    chunks.push({ quote: true, value: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) chunks.push({ quote: false, value: text.slice(last) });

  const speakers: (string | null)[] = chunks.map((c) => (c.quote ? null : "Narrator"));
  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i].quote) continue;
    const before = i > 0 && !chunks[i - 1].quote ? chunks[i - 1].value : "";
    const after = i + 1 < chunks.length && !chunks[i + 1].quote ? chunks[i + 1].value : "";
    const speaker = attributeQuote(before, after, names);
    speakers[i] = speaker;
    if (speaker) {
      // The attribution phrase belongs to this quote, not to the
      // narration: cut it from whichever edge of the neighbor named it.
      if (after && attributeQuote("", after, names) === speaker) {
        chunks[i + 1].value = stripAttribution(chunks[i + 1].value, names, "start");
      } else if (before) {
        chunks[i - 1].value = stripAttribution(chunks[i - 1].value, names, "end");
      }
    }
  }
  // Continuation: a quote separated from an attributed quote only by
  // its (now stripped) attribution phrase is the same speaker talking
  // on: "...," said Dell. "Staring at the water."
  for (let i = 2; i < chunks.length; i++) {
    if (!chunks[i].quote || speakers[i]) continue;
    if (!chunks[i - 2].quote || !speakers[i - 2]) continue;
    if (chunks[i - 1].quote) continue;
    if (chunks[i - 1].value.replace(/[^A-Za-z0-9]/g, "").length === 0) {
      speakers[i] = speakers[i - 2];
    }
  }

  const segments: CastSceneSegment[] = [];
  const push = (speaker: string, raw: string) => {
    const t = raw.replace(/\s+/g, " ").trim();
    if (t.replace(/[^A-Za-z0-9]/g, "").length < 2) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.speaker === speaker) {
      prev.text = trimToSentence(prev.text + " " + t, 460);
      return;
    }
    segments.push({ speaker, text: trimToSentence(t, 460) });
  };
  chunks.forEach((c, i) => {
    if (!c.quote) push("Narrator", c.value);
    else if (speakers[i]) push(speakers[i] as string, c.value);
    else push("Narrator", c.value);
  });
  return segments.slice(0, 10);
}

// One scene per supporting character: the earliest page where they
// speak alongside someone else (narration counts), else the earliest
// page where they speak at all. The protagonist auditions through the
// free sample instead, so she gets no scene.
export async function sceneSetForBook(
  books: any,
  slug: string,
  characters: CastCharacter[]
): Promise<Record<string, CastScene>> {
  const scenes: Record<string, CastScene> = {};
  const names = characters.map((c) => c.name);
  if (!names.length || !books || typeof books.get !== "function") return scenes;
  try {
    const obj = await books.get(`books/${slug}/editor_chapters.json`);
    if (!obj) return scenes;
    const chapters = JSON.parse(await obj.text());
    const shared: Record<string, CastScene> = {};
    const solo: Record<string, CastScene> = {};
    (chapters || []).forEach((ch: any, ci: number) => {
      const chapterNo = Number(ch?.num) || ci + 1;
      const title = String(ch?.title || "").trim();
      const label =
        `Chapter ${chapterNo} scene` +
        (title && title.toLowerCase() !== `chapter ${chapterNo}` ? `: ${title}` : "");
      (ch?.pages || []).forEach((p: any, pi: number) => {
        if (!p?.text) return;
        const segments = parsePageSegments(String(p.text), names);
        if (segments.length < 2) return;
        const speakers = new Set(segments.map((s) => s.speaker));
        for (const c of characters) {
          if (c.role === "protagonist") continue;
          if (!segments.some((s) => s.speaker === c.name)) continue;
          const scene: CastScene = {
            id: `s${chapterNo}p${pi + 1}`,
            label,
            chapter: chapterNo,
            segments,
          };
          if ([...speakers].some((s) => s !== c.name)) {
            if (!shared[c.name]) shared[c.name] = scene;
          } else if (!solo[c.name]) {
            solo[c.name] = scene;
          }
        }
      });
    });
    for (const c of characters) {
      if (c.role === "protagonist") continue;
      const scene = shared[c.name] || solo[c.name];
      if (scene) scenes[c.name] = scene;
    }
  } catch { /* a book without usable chapter text simply has no scenes */ }
  return scenes;
}

// The protagonist's free sample as speaking turns: the presents intro
// and the Chapter 1 narration (both in her voice, as narrator) plus her
// own first line. Built from the book's line set so Mira's curated
// snippets and the derived sets share one shape.
export function sampleSegmentsFor(lines: CastLine[], protagonistName: string | null): CastSceneSegment[] {
  const out: CastSceneSegment[] = [];
  const presents = lines.find((l) => l.id === "presents");
  const narrator = lines.find((l) => l.id === "narrator");
  const own = protagonistName ? lines.find((l) => l.character === protagonistName) : null;
  if (presents) out.push({ speaker: "Narrator", text: presents.text });
  if (narrator) out.push({ speaker: "Narrator", text: narrator.text });
  if (own && protagonistName) out.push({ speaker: protagonistName, text: own.text });
  return out;
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
