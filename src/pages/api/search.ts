import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { buildCast, bookCast } from "../../lib/cast-public";
import { loadCastGallery } from "../../lib/cast-gallery";
import {
  searchCatalog,
  bookCandidate,
  audioCandidate,
  castCandidate,
  type SearchCandidate,
} from "../../lib/search";
import { ensurePublicSlugColumn } from "../../lib/public-slugs";
import { semanticAskTheShelf, detectBraintrustBackend } from "../../lib/braintrust";
import { checkRateLimit, clientIp } from "../../lib/rate-limit";

// GET /api/search?q=
//
// The one search service for the storefront. Returns sectioned
// results ({ sections: [{ type, items }] }) in the fixed order Books,
// Cast, Audio, Video. Books and Audio come from the books table
// (Audio = the books that carry an audiobook), Cast from the same
// registry + gallery join the Meet the Cast pages use. Video has no
// data source yet, so its section simply never appears; adding one
// later means feeding searchCatalog() video candidates, nothing else
// changes. Catalog data is public, so responses cache briefly.

// Pull searchable concept terms out of a bible's JSON, tolerating
// every bible shape the factory has produced: concept ladder entries,
// vocab lists, and the big idea line.
function conceptTerms(dataJson: string | null, bigIdea: string | null): string[] {
  const terms: string[] = [];
  if (bigIdea) terms.push(bigIdea);
  if (!dataJson) return terms;
  try {
    const data = JSON.parse(dataJson);
    const ladder = data?.conceptLadder || data?.concept_ladder || [];
    if (Array.isArray(ladder)) {
      for (const rung of ladder) {
        if (typeof rung === "string") terms.push(rung);
        else if (rung && typeof rung === "object") {
          for (const k of ["realConcept", "real_concept", "concept", "term", "title"]) {
            if (typeof rung[k] === "string") terms.push(rung[k]);
          }
        }
      }
    }
    const vocab = data?.vocab || data?.vocabulary || [];
    if (Array.isArray(vocab)) {
      for (const v of vocab) {
        if (typeof v === "string") terms.push(v);
        else if (v && typeof v === "object") {
          for (const k of ["term", "word", "name"]) if (typeof v[k] === "string") terms.push(v[k]);
        }
      }
    }
  } catch { /* malformed bible JSON: title/topic matching still works */ }
  return terms;
}

export const GET: APIRoute = async ({ url }) => {
  const q = (url.searchParams.get("q") || "").slice(0, 80).trim();
  if (!q) return Response.json({ query: q, sections: [] });

  const e = env as any;
  const db = e.DB;
  // Book hrefs are built from public_slug (see lib/public-slugs.ts);
  // make sure the column exists before selecting it below.
  try { await ensurePublicSlugColumn(db); } catch { /* hrefs fall back to internal slugs */ }

  const bookCands: SearchCandidate[] = [];
  const audioCands: SearchCandidate[] = [];
  const castCands: SearchCandidate[] = [];

  // Cast first: book search fields borrow the cast (lead name, cast
  // names and species) so "mira" and "heron" find Mira's book too.
  let members: ReturnType<typeof buildCast> = [];
  try {
    const res = await db
      .prepare(
        `SELECT c.id, c.name, c.species, c.book_slug,
                b.title AS book_title, b.topic AS book_topic, b.picture_book_key,
                b.public_slug AS book_public_slug
           FROM characters c
           JOIN books b ON b.slug = c.book_slug`
      )
      .all();
    const rows: any[] = res.results || res.rows || [];
    const manifest = await loadCastGallery(e.BOOKS);
    members = buildCast(rows, manifest);
    // The protagonist of each book (bookCast is story order) carries
    // the lead flag: inside one book's cast, ties break toward them.
    const leadSlugs = new Set<string>();
    for (const slug of new Set(members.map((m) => m.bookSlug))) {
      const ordered = bookCast(members, slug);
      if (ordered.length) leadSlugs.add(ordered[0].slug);
    }
    for (const m of members) castCands.push(castCandidate(m, { lead: leadSlugs.has(m.slug) }));
  } catch { /* cast unavailable: books and audio still answer */ }

  const castByBook = new Map<string, string[]>();
  const leadByBook = new Map<string, string>();
  for (const slug of new Set(members.map((m) => m.bookSlug))) {
    const ordered = bookCast(members, slug);
    castByBook.set(slug, ordered.map((m) => `${m.name} ${m.species}`));
    if (ordered.length) leadByBook.set(slug, ordered[0].name);
  }

  try {
    const conceptsByBook = new Map<string, string[]>();
    try {
      const bibles = await db.prepare("SELECT book_slug, data, big_idea FROM bibles").all();
      for (const b of (bibles.results || bibles.rows || []) as any[]) {
        conceptsByBook.set(String(b.book_slug), conceptTerms(b.data, b.big_idea));
      }
    } catch { /* bibles unavailable: books match on their own fields */ }

    // Books is a public, purchase-facing section: CG ruled
    // 2026-10-28 that public search shows only published and ready
    // stuff, so the candidate set is status='complete' only,
    // matching what /api/books serves publicly. ready_for_qa books
    // render pages but sell nothing until they publish, so they stay
    // out of Books (and out of Audio, a purchase-intent section for
    // the $1.99 audio format, complete-only for the same reason).
    // Their cast remains findable through the Cast section above:
    // the Meet the Cast roster is deliberately public, workshop
    // books included. searchCatalog() also enforces complete-only
    // for the Books section, so the rule holds even if this query
    // ever widens again.
    const res = await db
      .prepare(
        "SELECT slug, public_slug, title, description, topic, topics, cover_key, audiobook_key, status FROM books WHERE status = 'complete'"
      )
      .all();
    for (const book of (res.results || res.rows || []) as any[]) {
      const lead = leadByBook.get(book.slug) || null;
      const castTerms = castByBook.get(book.slug) || [];
      const concepts = conceptsByBook.get(book.slug) || [];
      bookCands.push(bookCandidate(book, lead, castTerms, concepts));
      if (book.audiobook_key) {
        audioCands.push(audioCandidate(book, lead, castTerms, concepts));
      }
    }
  } catch { /* books unavailable: whatever sections loaded still answer */ }

  const sections = searchCatalog({ books: bookCands, cast: castCands, audio: audioCands }, q);
  // "Ask the Shelf" semantic fallback when natural-language parent queries ("frustrated when losing",
  // "compound interest for a 7-year-old") don't hit exact keyword tokens in D1:
  // N1 (2026-10-31): the semantic path is the expensive one (an embedding
  // pass per request even with the cached document vectors), so it is
  // per-IP rate-limited — an over-limit client still gets its keyword
  // sections, just no semantic matches.
  let semanticMatches: Awaited<ReturnType<typeof semanticAskTheShelf>> = [];
  const wantsSemantic = sections.length === 0 || q.split(/\s+/).length >= 3;
  if (wantsSemantic) {
    const limitCheck = await checkRateLimit(e.DB, `search_semantic:${clientIp(request)}`, 30, 60).catch(() => null);
    if (!limitCheck || limitCheck.ok) {
      semanticMatches = await semanticAskTheShelf(q, e, { limit: 4 });
    }
  }
  return Response.json(
    {
      query: q,
      sections,
      semanticMatches,
      semanticBackend: detectBraintrustBackend(e),
    },
    { headers: { "Cache-Control": "public, max-age=30, s-maxage=60" } }
  );
};
