// Audiobook helpers for the admin player (/admin/audiobooks).
//
// Storage layout in the BOOKS R2 bucket, all derived from the book's
// books.audiobook_key in D1 (the chaptered M4B buyers receive):
//   {dir}/audiobook.m4b        the M4B itself (audiobook_key)
//   {dir}/audio/intro.mp3      the "Big Brain Shelf presents" opening
//   {dir}/audio/ch{n}.mp3      per-chapter MP3s, n = 1..MAX_CHAPTER (playback)
//   {dir}/audio/outro.mp3      the closing ("The End")
//   {dir}/audiobook.mp3        full-book MP3 (playback, when present)
// Playback is MP3-first: the <audio> tag plays AAC in an M4B wrapper
// only where the platform ships the codec, while MP3 plays everywhere.
// The M4B stays a download (it is the file with embedded chapter
// markers); the MP3 set carries the same introduction and closing as
// their own tracks, so the players open and close the same way.
//
// Chapter titles and durations live in src/data/audiobooks.json, keyed
// by slug, harvested from each book's generation report when its
// audiobook is generated: an "intro" entry, a "chapters" list, and an
// "outro" entry per book. Anything missing falls back gracefully:
// "Chapter N" labels and durations learned from the audio element.

import audiobookData from "../data/audiobooks.json";

export const MAX_CHAPTER = 30;

interface ChapterMeta {
  title?: string;
  duration?: number;
}
interface BookMeta {
  intro?: ChapterMeta;
  chapters?: ChapterMeta[];
  outro?: ChapterMeta;
}

const DATA = audiobookData as Record<string, BookMeta>;

export function audiobookMeta(slug: string): BookMeta {
  return DATA[slug] || {};
}

/** Directory part of an audiobook key: "books/mira-the-heron-and-the-still-water/audiobook.m4b" -> "books/mira-the-heron-and-the-still-water". */
export function audiobookDir(audiobookKey: string): string {
  const i = audiobookKey.lastIndexOf("/");
  return i > 0 ? audiobookKey.slice(0, i) : "";
}

export function chapterAudioKey(audiobookKey: string, n: number): string {
  return `${audiobookDir(audiobookKey)}/audio/ch${n}.mp3`;
}

export function introAudioKey(audiobookKey: string): string {
  return `${audiobookDir(audiobookKey)}/audio/intro.mp3`;
}

export function outroAudioKey(audiobookKey: string): string {
  return `${audiobookDir(audiobookKey)}/audio/outro.mp3`;
}

export type EdgeKind = "intro" | "outro";

/**
 * Title + duration for the opening/closing track from
 * src/data/audiobooks.json, with the canonical fallbacks: the intro
 * is always "Introduction" and the outro "The End", matching the
 * section titles the generator stamps into the M4B chapter markers.
 */
export function edgeTrackMeta(
  slug: string,
  kind: EdgeKind
): { title: string; duration: number | null } {
  const m = audiobookMeta(slug)[kind];
  const fallback = kind === "intro" ? "Introduction" : "The End";
  const title =
    typeof m?.title === "string" && m.title.trim() ? m.title.trim() : fallback;
  const duration =
    typeof m?.duration === "number" && m.duration > 0 ? m.duration : null;
  return { title, duration };
}

// ---- Voice stamps -----------------------------------------------------
// Every generated audiobook carries a sidecar next to its files:
//   {dir}/audiobook-meta.json   { voiceId, engine, generatedAt }
// written by kidsbook-video/audiobook_gen.py at generation time (and
// backfilled for the 2026-10-27/28 slate from audiobook-costs.jsonl).
// voiceId is the identifier the generator actually used: a Gemini
// studio voice name ("Kore") or an Extended Voice Library id
// ("en-us-enzo"). The publish gate compares it, normalized, against
// the cast registry's voice for the book's protagonist.

export interface AudiobookVoiceStamp {
  voiceId: string;
  engine: string | null;
  generatedAt: string | null;
}

export function audiobookMetaKey(audiobookKey: string): string {
  return `${audiobookDir(audiobookKey)}/audiobook-meta.json`;
}

/** Parse a stamp from an object or a JSON string; null when unusable. */
export function parseVoiceStamp(raw: unknown): AudiobookVoiceStamp | null {
  let v: any = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== "object") return null;
  const voiceId = typeof v.voiceId === "string" ? v.voiceId.trim() : "";
  if (!voiceId) return null;
  return {
    voiceId,
    engine: typeof v.engine === "string" && v.engine.trim() ? v.engine.trim() : null,
    generatedAt:
      typeof v.generatedAt === "string" && v.generatedAt.trim() ? v.generatedAt.trim() : null,
  };
}

/** Read a book's voice stamp from the BOOKS bucket; null when absent. */
export async function readVoiceStamp(
  books: any,
  audiobookKey: string | null | undefined
): Promise<AudiobookVoiceStamp | null> {
  if (!audiobookKey || !books || typeof books.get !== "function") return null;
  try {
    const obj = await books.get(audiobookMetaKey(audiobookKey));
    if (!obj) return null;
    return parseVoiceStamp(await obj.text());
  } catch {
    return null;
  }
}

export function fullBookMp3Key(audiobookKey: string): string {
  return `${audiobookDir(audiobookKey)}/audiobook.mp3`;
}

/** Chapter number from a raw route/query value; only whole 1..12 pass. */
export function parseChapterParam(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_CHAPTER ? n : null;
}

export type TrackRef =
  | { kind: "full" }
  | { kind: "m4b" }
  | { kind: "intro" }
  | { kind: "outro" }
  | { kind: "chapter"; n: number };

/** Track segment of the audiobook routes: "full" | "m4b" | "intro" | "outro" | "ch{n}". */
export function parseTrackParam(raw: unknown): TrackRef | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "full") return { kind: "full" };
  if (s === "m4b") return { kind: "m4b" };
  if (s === "intro") return { kind: "intro" };
  if (s === "outro") return { kind: "outro" };
  const m = /^ch(\d+)$/.exec(s);
  if (m) {
    const n = parseChapterParam(m[1]);
    if (n !== null) return { kind: "chapter", n };
  }
  return null;
}

export function trackKey(audiobookKey: string, track: TrackRef): string {
  if (track.kind === "full") return fullBookMp3Key(audiobookKey);
  if (track.kind === "m4b") return audiobookKey;
  if (track.kind === "intro") return introAudioKey(audiobookKey);
  if (track.kind === "outro") return outroAudioKey(audiobookKey);
  return chapterAudioKey(audiobookKey, track.n);
}

export function trackContentType(track: TrackRef): string {
  return track.kind === "m4b" ? "audio/mp4" : "audio/mpeg";
}

export function chapterTitle(slug: string, n: number): string | null {
  const t = audiobookMeta(slug).chapters?.[n - 1]?.title;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

/** "Chapter 3" or "Chapter 3: The Morning Path" when the title is known. */
export function chapterLabel(slug: string, n: number): string {
  const t = chapterTitle(slug, n);
  return t ? `Chapter ${n}: ${t}` : `Chapter ${n}`;
}

export function chapterDuration(slug: string, n: number): number | null {
  const d = audiobookMeta(slug).chapters?.[n - 1]?.duration;
  return typeof d === "number" && d > 0 ? d : null;
}

/** Seconds -> "17:11" (or "1:02:03" past an hour). */
export function formatClock(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const rr = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

export type RangeParse =
  | { kind: "none" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; start: number; end: number };

/**
 * Parse a single-range Range header against an object size.
 * Malformed or multi-range headers come back "none" (serve the whole
 * file, which is what the spec allows); a well-formed range that
 * cannot be satisfied comes back "unsatisfiable" (answer 416).
 */
export function parseRangeHeader(header: string | null | undefined, size: number): RangeParse {
  if (!header) return { kind: "none" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { kind: "none" };
  const [, startRaw, endRaw] = m;
  if (startRaw === "" && endRaw === "") return { kind: "none" };
  if (size <= 0) return { kind: "unsatisfiable" };
  if (startRaw === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: "unsatisfiable" };
    if (suffix >= size) return { kind: "range", start: 0, end: size - 1 };
    return { kind: "range", start: size - suffix, end: size - 1 };
  }
  const start = Number(startRaw);
  if (start >= size) return { kind: "unsatisfiable" };
  if (endRaw === "") return { kind: "range", start, end: size - 1 };
  const end = Number(endRaw);
  if (end < start) return { kind: "unsatisfiable" };
  return { kind: "range", start, end: Math.min(end, size - 1) };
}

// ---- Server-side inspection (D1 + R2 heads), shared by the pages ----

export interface AudiobookBookRow {
  slug: string;
  title: string;
  status?: string;
  cover_key?: string | null;
  audiobook_key: string;
}

export interface PlayerTrack {
  id: string; // "full" | "intro" | "ch{n}" | "outro"
  label: string;
  detail: string | null;
  url: string;
  duration: number | null; // seconds, when known from data
  // Story chapter number for chapter tracks; null for the intro,
  // the outro, and the full-book file. Players use it to sync the
  // chapter chips and the page scroll with whatever is playing.
  chapter: number | null;
}

export interface AudiobookInspection {
  book: AudiobookBookRow;
  m4b: { size: number } | null;
  full: PlayerTrack | null;
  intro: PlayerTrack | null;
  chapters: PlayerTrack[];
  outro: PlayerTrack | null;
  // The chapters-mode playlist in listening order: the introduction,
  // the chapters, then the closing. `chapters` stays chapter-pure
  // for counting and chip mapping; players play `tracks`.
  tracks: PlayerTrack[];
  // The voice stamp beside the audiobook files, when one was written.
  voiceStamp: AudiobookVoiceStamp | null;
}

/**
 * Head the M4B, the full-book MP3, the intro/outro MP3s, and ch1..ch12
 * in R2 and report what actually exists, so the player only ever
 * lists playable tracks.
 * Track URLs are built under basePath, which defaults to the admin
 * streaming route; the customer reader passes its library route so
 * the same inspection serves both players.
 */
export async function inspectAudiobook(
  e: any,
  book: AudiobookBookRow,
  basePath?: string
): Promise<AudiobookInspection> {
  const key = book.audiobook_key;
  const base = basePath || `/api/admin/audiobook/${book.slug}`;
  let m4bHead: any = null;
  let fullHead: any = null;
  let voiceStamp: AudiobookVoiceStamp | null = null;
  let hasIntro = false;
  let hasOutro = false;
  const presentChapters = new Set<number>();

  if (typeof e?.BOOKS?.list === "function") {
    const prefix = `${audiobookDir(key)}/audio/`;
    const listAudio = async () => {
      const names = new Set<string>();
      let cursor: string | undefined;
      try {
        do {
          const page = await e.BOOKS.list(cursor ? { prefix, cursor } : { prefix });
          for (const obj of page?.objects || []) {
            if (obj?.key) names.add(String(obj.key));
          }
          cursor = page?.truncated ? page.cursor : undefined;
        } while (cursor);
      } catch { /* degrade to whatever was listed */ }
      return names;
    };
    const [m4b, full, stamp, audioKeys] = await Promise.all([
      e.BOOKS.head(key).catch(() => null),
      e.BOOKS.head(fullBookMp3Key(key)).catch(() => null),
      readVoiceStamp(e.BOOKS, key),
      listAudio(),
    ]);
    m4bHead = m4b;
    fullHead = full;
    voiceStamp = stamp;
    hasIntro = audioKeys.has(introAudioKey(key));
    hasOutro = audioKeys.has(outroAudioKey(key));
    for (let n = 1; n <= MAX_CHAPTER; n++) {
      if (audioKeys.has(chapterAudioKey(key, n))) presentChapters.add(n);
    }
  } else {
    const [m4b, full, stamp, introHead, outroHead, chapterHeads] = await Promise.all([
      e.BOOKS.head(key).catch(() => null),
      e.BOOKS.head(fullBookMp3Key(key)).catch(() => null),
      readVoiceStamp(e.BOOKS, key),
      e.BOOKS.head(introAudioKey(key)).catch(() => null),
      e.BOOKS.head(outroAudioKey(key)).catch(() => null),
      Promise.all(
        Array.from({ length: MAX_CHAPTER }, (_, i) =>
          e.BOOKS.head(chapterAudioKey(key, i + 1)).catch(() => null)
        )
      ),
    ]);
    m4bHead = m4b;
    fullHead = full;
    voiceStamp = stamp;
    hasIntro = !!introHead;
    hasOutro = !!outroHead;
    chapterHeads.forEach((h: any, i: number) => {
      if (h) presentChapters.add(i + 1);
    });
  }

  const chapters: PlayerTrack[] = [];
  for (let n = 1; n <= MAX_CHAPTER; n++) {
    if (!presentChapters.has(n)) continue;
    chapters.push({
      id: `ch${n}`,
      label: chapterLabel(book.slug, n),
      detail: null,
      url: `${base}/ch${n}`,
      duration: chapterDuration(book.slug, n),
      chapter: n,
    });
  }

  const introHead = hasIntro;
  const outroHead = hasOutro;

  const edgeTrack = (kind: EdgeKind, head: any): PlayerTrack | null => {
    if (!head) return null;
    const meta = edgeTrackMeta(book.slug, kind);
    return {
      id: kind,
      label: meta.title,
      detail: null,
      url: `${base}/${kind}`,
      duration: meta.duration,
      chapter: null,
    };
  };
  const intro = edgeTrack("intro", introHead);
  const outro = edgeTrack("outro", outroHead);
  const tracks: PlayerTrack[] = [
    ...(intro ? [intro] : []),
    ...chapters,
    ...(outro ? [outro] : []),
  ];

  let full: PlayerTrack | null = null;
  if (fullHead) {
    // The full-book MP3 is the same sequence joined into one file:
    // introduction, chapters, closing. Its honest total is the
    // tracks sum, edges included.
    const total = tracks.reduce((sum, c) => sum + (c.duration || 0), 0);
    full = {
      id: "full",
      label: "Full book",
      detail: "Every chapter in one file",
      url: `${base}/full`,
      duration: total > 0 ? total : null,
      chapter: null,
    };
  }

  return {
    book,
    m4b: m4bHead ? { size: m4bHead.size } : null,
    full,
    intro,
    chapters,
    outro,
    tracks,
    voiceStamp,
  };
}

// ---- Shared streaming ---------------------------------------------------
// One implementation behind both streaming routes (admin and customer
// library) so range/seek behavior can never drift between them.
// Range requests are honored with R2 range reads: a satisfiable Range
// answers 206 with Content-Range, an unsatisfiable one answers 416.
// The M4B is served only when allowDownload is set (the admin route);
// the customer route streams MP3 only and keeps the M4B a download.

export async function serveAudiobookTrack(args: {
  books: any;
  audiobookKey: string;
  slug: string;
  // Public (title-derived) base for the M4B download filename. The
  // saved file must never carry the internal slug; callers that can
  // resolve the book pass downloadBaseName(book). Falls back to slug
  // only when a caller cannot (no such caller serves downloads).
  filenameBase?: string;
  track: TrackRef;
  method: string;
  rangeHeader: string | null;
  allowDownload?: boolean;
}): Promise<Response> {
  const { books, audiobookKey, slug, track } = args;
  if (track.kind === "m4b" && !args.allowDownload) {
    return Response.json(
      { error: "That file is a download, not a stream." },
      { status: 404 }
    );
  }
  const key = trackKey(audiobookKey, track);
  const head = await books.head(key).catch(() => null);
  if (!head) {
    return Response.json({ error: "Audiobook file not found." }, { status: 404 });
  }
  const size = head.size;

  const headers = new Headers({
    "Content-Type": trackContentType(track),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  });
  if (track.kind === "m4b") {
    headers.set(
      "Content-Disposition",
      `attachment; filename="${args.filenameBase || slug}-audiobook.m4b"`
    );
  }

  if (args.method === "HEAD") {
    headers.set("Content-Length", String(size));
    return new Response(null, { status: 200, headers });
  }

  const range = parseRangeHeader(args.rangeHeader, size);
  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range.kind === "range") {
    const length = range.end - range.start + 1;
    const obj = await books
      .get(key, { range: { offset: range.start, length } })
      .catch(() => null);
    if (!obj) {
      return Response.json({ error: "Audiobook file not found." }, { status: 404 });
    }
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }

  const obj = await books.get(key).catch(() => null);
  if (!obj) {
    return Response.json({ error: "Audiobook file not found." }, { status: 404 });
  }
  headers.set("Content-Length", String(size));
  return new Response(obj.body, { status: 200, headers });
}

export interface AudiobookProbe {
  chapterCount: number;
  hasIntro: boolean;
  hasOutro: boolean;
  hasChapter1: boolean;
  // Sum of the known durations of the tracks that exist, edges
  // included: the same "honest total" inspectAudiobook reports.
  runtimeSecs: number;
}

// Lightweight existence probe for the public audio pages. Uses a single
// R2 list() over `{dir}/audio/` when available (1 R2 call per book
// instead of 2 + N sequential head() calls) with a fallback to head()
// for minimal mock buckets, and caches the resulting probe in Cloudflare's
// edge cache (caches.default) for 5 minutes so cold/signed-in /audiobooks
// renders don't stall on repeated R2 probes.
export async function probeAudiobook(e: any, book: AudiobookBookRow): Promise<AudiobookProbe> {
  const key = book.audiobook_key;
  const cache: Cache | null =
    typeof caches !== "undefined" && (caches as any).default ? (caches as any).default : null;
  const cacheUrl = `https://cache.bigbrainshelf.internal/probe-audiobook/${encodeURIComponent(book.slug)}?k=${encodeURIComponent(key)}`;
  if (cache) {
    try {
      const hit = await cache.match(cacheUrl);
      if (hit) return (await hit.json()) as AudiobookProbe;
    } catch { /* fall through to live R2 probe */ }
  }

  let hasIntro = false;
  let hasOutro = false;
  let chapterCount = 0;

  if (typeof e?.BOOKS?.list === "function") {
    const dir = audiobookDir(key);
    const prefix = `${dir}/audio/`;
    const names = new Set<string>();
    let cursor: string | undefined;
    try {
      do {
        const page = await e.BOOKS.list(cursor ? { prefix, cursor } : { prefix });
        for (const obj of page?.objects || []) {
          if (obj?.key) names.add(String(obj.key));
        }
        cursor = page?.truncated ? page.cursor : undefined;
      } while (cursor);
    } catch { /* fall through with whatever was collected */ }
    hasIntro = names.has(introAudioKey(key));
    hasOutro = names.has(outroAudioKey(key));
    for (let n = 1; n <= MAX_CHAPTER; n++) {
      if (!names.has(chapterAudioKey(key, n))) break;
      chapterCount = n;
    }
  } else {
    const [introHead, outroHead] = await Promise.all([
      e.BOOKS.head(introAudioKey(key)).catch(() => null),
      e.BOOKS.head(outroAudioKey(key)).catch(() => null),
    ]);
    hasIntro = !!introHead;
    hasOutro = !!outroHead;
    for (let n = 1; n <= MAX_CHAPTER; n++) {
      const h = await e.BOOKS.head(chapterAudioKey(key, n)).catch(() => null);
      if (!h) break;
      chapterCount = n;
    }
  }

  let runtimeSecs = 0;
  if (hasIntro) runtimeSecs += edgeTrackMeta(book.slug, "intro").duration || 0;
  for (let n = 1; n <= chapterCount; n++) runtimeSecs += chapterDuration(book.slug, n) || 0;
  if (hasOutro) runtimeSecs += edgeTrackMeta(book.slug, "outro").duration || 0;
  const result: AudiobookProbe = {
    chapterCount,
    hasIntro,
    hasOutro,
    hasChapter1: chapterCount >= 1,
    runtimeSecs,
  };
  if (cache && chapterCount > 0) {
    try {
      await cache.put(
        cacheUrl,
        new Response(JSON.stringify(result), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=300",
          },
        })
      );
    } catch { /* non-fatal */ }
  }
  return result;
}
