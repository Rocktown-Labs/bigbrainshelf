import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import {
  ensureCastTables,
  seedRecordedCasts,
  getRegistry,
  getAssignmentLog,
  assignVoice,
  exportRegistry,
  bibleCast,
  lineSetForBook,
  sceneSetForBook,
  sampleSegmentsFor,
  type CastCharacter,
} from "../../../lib/cast-registry";
import { listPublishReadiness, getPublishReadiness } from "../../../lib/publish-readiness";
import { resolveInternalSlug } from "../../../lib/public-slugs";

// Casting registry API for /admin/cast-gemini. Gated by the middleware's
// admin session like every /api/admin route (same posture as the editor
// APIs).
//
// GET                     -> { books, registry, log }
//   books: the finished books, each with its bible cast; registry: every
//   character_voices row; log: recent voice_assignment_log rows.
// GET ?slug=<book>        -> { slug, title, characters, lines, scenes,
//   sample, registry, audio }
//   the cast sheet for one book: audition lines, per-character scenes
//   (redesign S3), the protagonist's free-sample turns, each
//   character's sheet art key, and the book's audio state. The slug
//   may be the internal slug or the public slug.
// POST { character_name, voice_id, book_slug }
//   -> assign/change a character's voice in the registry; refreshes the
//      R2 cast-registry.json export.

async function bookCasts(db: any): Promise<{ slug: string; title: string; publicSlug: string | null; coverKey: string | null; characters: CastCharacter[] }[]> {
  const { results: bookRows } = await db
    .prepare(`SELECT slug, title, public_slug, cover_key FROM books WHERE status != 'failed' ORDER BY title`)
    .all();
  const { results: bibleRows } = await db
    .prepare(`SELECT book_slug, data FROM bibles`)
    .all();
  const castBySlug = new Map<string, CastCharacter[]>();
  for (const r of (bibleRows || []) as any[]) {
    let data: any = null;
    try { data = typeof r.data === "string" ? JSON.parse(r.data) : r.data; } catch { /* no cast */ }
    if (data) castBySlug.set(r.book_slug, bibleCast(data));
  }
  return ((bookRows || []) as any[]).map((b) => ({
    slug: b.slug,
    title: b.title,
    publicSlug: b.public_slug ? String(b.public_slug) : null,
    coverKey: b.cover_key ? String(b.cover_key) : null,
    characters: castBySlug.get(b.slug) || [],
  }));
}

export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const db = e.DB;
  await ensureCastTables(db);
  const seeded = await seedRecordedCasts(db);
  if (seeded) {
    try { await exportRegistry(db, e.BOOKS); } catch { /* export syncs on next change */ }
  }

  const slugParam = (url.searchParams.get("slug") || "").trim();
  if (slugParam) {
    if (!/^[A-Za-z0-9_-]+$/.test(slugParam)) {
      return Response.json({ error: "bad slug" }, { status: 400 });
    }
    // The casting page links with the book's public slug; the registry
    // and line sets key on the internal slug. Resolve through the same
    // helper the public routes use.
    const slug = (await resolveInternalSlug(db, slugParam)) || slugParam;
    const books = await bookCasts(db);
    const book = books.find((b) => b.slug === slug);
    if (!book) return Response.json({ error: "book not found" }, { status: 404 });
    const lines = await lineSetForBook(e.BOOKS, slug, book.title, book.characters);
    const registry = await getRegistry(db);
    // Character sheet art for the casting rows: the characters
    // registry's approved sheet key for this book + name, when one
    // exists (same lookup the crop editor uses).
    const imageByName = new Map<string, string>();
    try {
      const { results: charRows } = await db
        .prepare(`SELECT name, jpg_key FROM characters WHERE book_slug = ?`)
        .bind(slug)
        .all();
      for (const r of (charRows || []) as any[]) {
        if (r?.jpg_key) imageByName.set(String(r.name || "").toLowerCase(), String(r.jpg_key));
      }
    } catch { /* sheet art is a nicety, not a dependency */ }
    const characters = book.characters.map((c) => ({
      ...c,
      image_key: imageByName.get(c.name.toLowerCase()) ?? null,
    }));
    const scenes = await sceneSetForBook(e.BOOKS, slug, book.characters);
    const protagonist = book.characters.find((c) => c.role === "protagonist")?.name ?? null;
    const sample = sampleSegmentsFor(lines, protagonist);
    // This book's audio state for the banner (same shape the overview
    // attaches per book). Best-effort, as in the overview.
    let audio: any = null;
    try {
      const r = await getPublishReadiness(db, e.BOOKS, slug);
      if (r) {
        audio = {
          state: r.state,
          statusLabel: r.statusLabel,
          protagonist: r.protagonist,
          castVoiceName: r.castVoiceName,
          audiobookVoiceName: r.audiobookVoiceName,
          ready: r.ready,
        };
      }
    } catch { /* the cast sheet does not depend on the audio state */ }
    return Response.json({
      slug,
      publicSlug: book.publicSlug,
      title: book.title,
      characters,
      lines,
      scenes,
      sample,
      registry,
      audio,
    });
  }

  // Keep the R2 export present even when the registry was seeded
  // outside this route (e.g. by migration): create it on first load if
  // it is missing.
  try {
    const head = await e.BOOKS.head("cast-registry.json");
    if (!head) await exportRegistry(db, e.BOOKS);
  } catch { /* the export also refreshes on every assignment */ }

  const [books, registry, log] = await Promise.all([
    bookCasts(db),
    getRegistry(db),
    getAssignmentLog(db),
  ]);
  // Per-book audio state (the publish gate's view), so the Casting
  // page can show whether each book's audiobook is a final cast-voice
  // read or still a draft. Best-effort: a readiness failure leaves the
  // books without the audio field rather than breaking the overview.
  try {
    const readiness = await listPublishReadiness(db, e.BOOKS);
    const bySlug = new Map(readiness.map((r) => [r.slug, r]));
    for (const b of books as any[]) {
      const r = bySlug.get(b.slug);
      if (r) {
        b.audio = {
          state: r.state,
          statusLabel: r.statusLabel,
          protagonist: r.protagonist,
          castVoiceName: r.castVoiceName,
          audiobookVoiceName: r.audiobookVoiceName,
          ready: r.ready,
        };
      }
    }
  } catch { /* the cast sheet does not depend on the audio state */ }
  return Response.json({ books, registry, log });
};

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const db = e.DB;
  await ensureCastTables(db);
  await seedRecordedCasts(db);
  const body = await request.json().catch(() => ({}));
  const characterName = String(body?.character_name || "").trim();
  const voiceId = String(body?.voice_id || "").trim();
  const bookSlug = String(body?.book_slug || "").trim();
  if (!characterName || !voiceId) {
    return Response.json({ error: "character_name and voice_id required" }, { status: 400 });
  }
  // Voice exclusivity (CG, 2026-10-31): a voice cast to one
  // character is not available to another. Reuse requires the
  // caller's explicit override (the Casting page's override
  // toggle + confirm); without it the assignment is refused.
  const override = (body as any)?.override === true;
  if (!override) {
    const registry = await getRegistry(db);
    const clash: any = Object.values(registry as any).find(
      (r: any) => r && r.voice_id === voiceId && r.character_name !== characterName
    );
    if (clash) {
      return Response.json(
        { error: `That voice is already cast to ${clash.character_name}. Reusing a cast voice needs the override.` },
        { status: 409 }
      );
    }
  }
  try {
    const { row, action } = await assignVoice(db, e.BOOKS, { characterName, voiceId, bookSlug });
    return Response.json({ ok: true, action, row });
  } catch (err: any) {
    return Response.json({ error: String(err?.message || err) }, { status: 400 });
  }
};
