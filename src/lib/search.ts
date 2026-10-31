// Sectioned site search: one service behind GET /api/search, built to
// scale by section. Books, Cast and Audio have live sources today;
// Video is a defined section type with a renderer on the client and no
// data source yet, so it simply never appears until videos exist.
//
// The matching core is pure (no D1 / R2 access) so it is unit-tested
// in tests/search.test.ts; the API route only loads catalog rows,
// turns them into candidates, and hands them here.
//
// Item shape is uniform across sections so a new section plugs in
// without UI changes:
//   { type, title, subtitle, imageUrl, href, meta }

import { coverDerivative } from "./derivatives";

export type SearchSectionType = "books" | "cast" | "audio" | "video";

export interface SearchItem {
  type: SearchSectionType;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  href: string;
  meta: Record<string, string>;
}

export interface SearchSection {
  type: SearchSectionType;
  items: SearchItem[];
}

/** One searchable record: the public item plus its weighted fields. */
export interface SearchCandidate {
  item: SearchItem;
  fields: { text: string; weight: number }[];
}

/** Section order is CG's: Books, Cast, Audio, Video. Change here only. */
export const SECTION_ORDER: SearchSectionType[] = ["books", "cast", "audio", "video"];

export const SECTION_LIMITS: Record<SearchSectionType, number> = {
  books: 8,
  cast: 8,
  audio: 4,
  video: 4,
};

export const SECTION_LABELS: Record<SearchSectionType, string> = {
  books: "Books",
  cast: "Cast",
  audio: "Audio",
  video: "Video",
};

export function normalizeText(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(query: string): string[] {
  const n = normalizeText(query);
  return n ? n.split(" ").filter(Boolean) : [];
}

// Score one query token against one field: exact beats prefix beats
// word-prefix beats substring, scaled by the field's weight.
function tokenFieldScore(token: string, fieldNorm: string): number {
  if (!token || !fieldNorm) return 0;
  if (fieldNorm === token) return 100;
  if (fieldNorm.startsWith(token)) return 80;
  const words = fieldNorm.split(" ");
  for (const w of words) if (w.startsWith(token)) return 70;
  if (fieldNorm.includes(token)) return 45;
  return 0;
}

// ---- Natural-language layer (keyword intelligence, not embeddings) ----
//
// Two pragmatic fixes so queries like "book about money" work:
//
// 1. STOPWORDS: filler tokens ("book", "about", "the", "find me"…)
//    are dropped before matching. Under AND semantics a filler token
//    that appears in no field would otherwise zero out every result.
//    If the query is ALL stopwords, there is nothing to search for.
// 2. CONCEPT CLUSTERS: a token also matches through its cluster
//    mates, at a discount, so "saving" finds the Money shelf and
//    "brave" finds the Courage shelf. Clusters are grounded in the
//    catalog's real vocabulary (the books table's topic/topics values
//    and bible big-idea words): money = saving, investing, money
//    habits, compounding, conscious spending; tech = algorithms,
//    design patterns, docker, containers; courage = mastery,
//    practice, mentorship, resistance, freedom, integrity. Words
//    that appear in no catalog field are not in any cluster.
export const STOPWORDS = new Set([
  "a", "an", "the", "about", "for", "me", "my", "i", "we", "you",
  "book", "books", "story", "stories", "find", "show", "get", "give",
  "please", "looking", "look", "want", "wants", "need", "needs",
  "something", "anything", "that", "this", "with", "of", "on", "in",
  "is", "are", "it", "its", "to", "and", "or", "kid", "kids", "child",
  "children", "read", "reads",
]);

const CONCEPT_CLUSTERS: string[][] = [
  // Money shelf (richdadpoordad: saving, investing, money-habits;
  // compoundeffect: compounding; iwillteach: conscious spending,
  // investing). Deliberately NOT here: "habits" (a topics word on a
  // Courage book too, so it cannot mark the Money shelf), "earn"
  // (substring-matches "learns" in half the catalog), and "coin"
  // (an algorithms chapter title wears it as a metaphor).
  ["money", "saving", "savings", "save", "spending", "spend", "investing", "invest", "investment", "compounding", "compound", "wealth", "rich", "budget", "bank"],
  // Tech shelf (algorithms; design patterns: strategy, observer,
  // decorator; docker: containers).
  ["tech", "technology", "coding", "code", "computer", "computers", "programming", "software", "algorithms", "algorithm", "docker", "containers", "container", "patterns", "pattern", "design", "strategy", "observer", "decorator"],
  // Courage shelf (practice, mentorship; freedom, integrity;
  // resistance, showing up).
  ["courage", "brave", "bravery", "afraid", "fear", "fears", "mastery", "practice", "practicing", "patience", "patient", "mentor", "mentorship", "resistance", "freedom", "integrity", "confidence", "perseverance", "persistence"],
  // Habits cross both Money and Courage in the catalog data
  // ("habits, choices"; "habits, showing-up").
  ["habit", "choices", "choice", "routine", "routines", "daily", "consistency", "automation"],
];

const CLUSTER_OF = new Map<string, string[]>();
for (const cluster of CONCEPT_CLUSTERS) {
  for (const word of cluster) if (!CLUSTER_OF.has(word)) CLUSTER_OF.set(word, cluster);
}

/** Synonym hits count for less than the word the visitor typed. */
export const SYNONYM_DISCOUNT = 0.85;

/**
 * Turn a raw query into token groups: stopwords removed, and each
 * surviving token grouped with its concept-cluster mates. A group
 * matches when ANY of its tokens hits a field; the typed token is
 * always first in its group.
 */
export function queryTokenGroups(query: string): string[][] {
  const tokens = tokenize(query).filter((t) => !STOPWORDS.has(t));
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    const cluster = CLUSTER_OF.get(token);
    groups.push(cluster ? [token, ...cluster.filter((w) => w !== token)] : [token]);
  }
  return groups;
}

export interface CandidateScore {
  score: number;
  /** Fields hit by the visitor's own typed words (not synonyms):
   *  the first tiebreak. For "money", Penny's book carries the word
   *  in its label, topics and big idea; Maisie's only in its label,
   *  so Penny is the better answer even at equal score. */
  typedHits: number;
  /** How many fields the query hit at all, synonyms included: the
   *  second tiebreak. */
  fieldHits: number;
}

/**
 * Score a candidate against query token groups. AND semantics across
 * groups: every group must hit at least one field, so "mira heron"
 * narrows instead of broadening. Within a group the best token wins,
 * with cluster mates discounted by SYNONYM_DISCOUNT. Returns a zero
 * score for no match.
 */
export function scoreCandidate(candidate: SearchCandidate, groups: string[][]): CandidateScore {
  if (!groups.length) return { score: 0, typedHits: 0, fieldHits: 0 };
  const fields = candidate.fields.map((f) => ({ norm: normalizeText(f.text), weight: f.weight }));
  let total = 0;
  const hitFields = new Set<number>();
  const typedFields = new Set<number>();
  for (const group of groups) {
    let best = 0;
    fields.forEach((f, fi) => {
      group.forEach((token, ti) => {
        const raw = tokenFieldScore(token, f.norm);
        if (raw > 0) {
          hitFields.add(fi);
          if (ti === 0) typedFields.add(fi);
        }
        const s = raw * f.weight * (ti === 0 ? 1 : SYNONYM_DISCOUNT);
        if (s > best) best = s;
      });
    });
    if (best === 0) return { score: 0, typedHits: 0, fieldHits: 0 };
    total += best;
  }
  return { score: total, typedHits: typedFields.size, fieldHits: hitFields.size };
}

export interface SearchCatalog {
  books?: SearchCandidate[];
  cast?: SearchCandidate[];
  audio?: SearchCandidate[];
  video?: SearchCandidate[];
}

/** A book's cast rides on the book's own match: when a query hits a
 *  book, its cast members get this share of the book's score added,
 *  so "the book's own people" outrank an incidental species or
 *  substring hit from another book's cast. */
export const CAST_BOOK_BOOST = 0.35;
/** The protagonist's nudge: breaks ties inside one book's cast
 *  toward the lead. Far smaller than any real relevance gap (a name
 *  match is worth hundreds), so it only ever reorders equals. */
export const CAST_LEAD_BONUS = 5;

/**
 * Run a query over the catalog and assemble the sections in
 * SECTION_ORDER, omitting any section with no matches. Within a
 * section: score descending, then field-hit count, then title,
 * capped at the section limit.
 */
export function searchCatalog(catalog: SearchCatalog, query: string): SearchSection[] {
  const groups = queryTokenGroups(query);
  if (!groups.length) return [];

  const scoreSection = (type: SearchSectionType) => {
    const scored: { item: SearchItem; score: number; typedHits: number; fieldHits: number }[] = [];
    for (const c of catalog[type] || []) {
      // Public Books results are published books only (CG ruling,
      // 2026-10-28): a candidate whose book is not status complete
      // never enters the Books section, however well it matches, and
      // earns its cast no book boost either. The API route already
      // loads complete-only rows; this pins the rule in the tested
      // core too. Cast is deliberately unaffected: the Meet the Cast
      // roster is public in its own right, workshop books included,
      // so a not-yet-published book's people stay findable there.
      if (type === "books" && c.item.meta.status && c.item.meta.status !== "complete") continue;
      const s = scoreCandidate(c, groups);
      if (s.score > 0) scored.push({ item: c.item, score: s.score, typedHits: s.typedHits, fieldHits: s.fieldHits });
    }
    return scored;
  };
  const byRank = (a: { score: number; typedHits: number; fieldHits: number; item: SearchItem }, b: { score: number; typedHits: number; fieldHits: number; item: SearchItem }) =>
    b.score - a.score || b.typedHits - a.typedHits || b.fieldHits - a.fieldHits || a.item.title.localeCompare(b.item.title);

  // Books first: their scores drive the cast boost below.
  const bookScored = scoreSection("books");
  const bestBookScore = new Map<string, number>();
  for (const s of bookScored) {
    const slug = s.item.meta.slug;
    if (slug && (bestBookScore.get(slug) ?? 0) < s.score) bestBookScore.set(slug, s.score);
  }

  const sections: SearchSection[] = [];
  for (const type of SECTION_ORDER) {
    let scored = type === "books" ? bookScored : scoreSection(type);
    if (type === "cast") {
      scored = scored.map((s) => {
        const bookScore = bestBookScore.get(s.item.meta.bookSlug || "");
        let score = s.score;
        if (bookScore) score += Math.min(bookScore, 200) * CAST_BOOK_BOOST;
        if (s.item.meta.lead === "1") score += CAST_LEAD_BONUS;
        return { ...s, score };
      });
    }
    scored.sort(byRank);
    const items = scored.slice(0, SECTION_LIMITS[type]).map((s) => s.item);
    if (items.length) sections.push({ type, items });
  }
  return sections;
}

// ---- Candidate builders (used by the API route) ----

const TOPIC_LABELS: Record<string, string> = { tech: "Tech", money: "Money", courage: "Courage" };

export function topicLabel(topic: string | null | undefined): string {
  return TOPIC_LABELS[String(topic || "tech")] || "Tech";
}

export interface BookRowLike {
  slug: string;
  public_slug?: string | null;
  title: string;
  description?: string | null;
  topic?: string | null;
  topics?: string | null;
  cover_key?: string | null;
  audiobook_key?: string | null;
  status?: string | null;
}

/** Cover display URL on the hotlink-guarded media host (the bucket's
 * r2.dev domain is disabled; see lib/media.ts). */
import { mediaUrl } from "./media";
import { bookHref } from "./public-slugs";

export function coverUrl(coverKey: string | null | undefined): string | null {
  return mediaUrl(coverKey);
}

// Search results are thumbnails: prefer the right-sized WebP cover
// derivative when one exists for the book (see lib/derivatives.ts).
export function coverThumbUrl(book: BookRowLike): string | null {
  return coverDerivative(book.slug, "card", book.cover_key) || coverUrl(book.cover_key);
}

export function bookCandidate(
  book: BookRowLike,
  leadName: string | null,
  castTerms: string[],
  conceptTerms: string[]
): SearchCandidate {
  const label = topicLabel(book.topic);
  const fields = [
    { text: book.title, weight: 3 },
    { text: leadName || "", weight: 2.5 },
    { text: castTerms.join(" "), weight: 1.5 },
    { text: (book.topics || "").split(",").join(" "), weight: 2 },
    { text: label, weight: 1.5 },
    { text: conceptTerms.join(" "), weight: 1.25 },
    { text: book.description || "", weight: 0.75 },
  ];
  return {
    item: {
      type: "books",
      title: book.title,
      subtitle: leadName ? `${label} · starring ${leadName}` : `${label} shelf`,
      imageUrl: coverThumbUrl(book),
      // Public links carry the title-based public slug, never the
      // internal (source-derived) one; meta.slug stays internal
      // because the cast boost keys on it.
      href: bookHref(book),
      meta: { slug: book.slug, topic: String(book.topic || "tech"), status: String(book.status || "complete") },
    },
    fields,
  };
}

export function audioCandidate(
  book: BookRowLike,
  leadName: string | null,
  castTerms: string[],
  conceptTerms: string[]
): SearchCandidate {
  const base = bookCandidate(book, leadName, castTerms, conceptTerms);
  return {
    item: {
      type: "audio",
      title: book.title,
      subtitle: "Audiobook · the full story, read aloud",
      imageUrl: coverThumbUrl(book),
      href: `${bookHref(book)}?format=audio`,
      meta: { slug: book.slug, format: "audiobook" },
    },
    fields: [...base.fields, { text: "audiobook audio listen read aloud", weight: 1 }],
  };
}

export interface CastMemberLike {
  slug: string;
  name: string;
  species: string;
  role: string;
  bookSlug: string;
  bookTitle: string;
  topic: string;
  portrait: string | null;
  portraitCard?: string | null;
}

export function castCandidate(member: CastMemberLike, opts?: { lead?: boolean }): SearchCandidate {
  return {
    item: {
      type: "cast",
      title: member.name,
      subtitle: member.role ? `${member.role} · ${member.bookTitle}` : member.bookTitle,
      imageUrl: member.portraitCard || member.portrait,
      href: `/meet-the-cast/${member.slug}`,
      meta: {
        bookSlug: member.bookSlug,
        bookTitle: member.bookTitle,
        topic: member.topic,
        // The compact dropdown card shows the role alone (the full
        // subtitle is too long at card width); the lead flag drives
        // the protagonist tiebreak in searchCatalog.
        role: member.role || "",
        lead: opts?.lead ? "1" : "0",
      },
    },
    fields: [
      { text: member.name, weight: 3 },
      { text: member.species, weight: 2 },
      { text: member.role, weight: 1.5 },
      { text: member.bookTitle, weight: 1.5 },
      // The shelf word itself ("money", "tech", "courage") so a
      // shelf query surfaces that shelf's people too.
      { text: member.topic, weight: 1 },
    ],
  };
}
