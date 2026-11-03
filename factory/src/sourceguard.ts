// Source dedup guard: one source book, one adaptation, ever (CG,
// 2026-10-28). If a new build's source matches an existing book's
// source, the build is refused BEFORE any model call or generation,
// with a message naming the book that already adapts it.
//
// Where source identity lives in this factory (verified 2026-10-28):
// there is no single source column. Legacy books identify their source
// through a scatter of records, so the registry is harvested at check
// time from all of them:
//   - characters.source in D1, when it is a citation of the form
//     "Title (Author)" (designpatterns, iwillteach, mastery carry one;
//     other books store 'original' / 'cover' / role text there, which
//     is ignored: only parenthesized citations are harvested)
//   - books/{slug}/book_info.json: title, plus the stamped
//     sourceTitle / sourceKey / sourceTitleChecked fields this guard
//     writes on every passed build going forward
//   - the D1 books row title (the kids' title; a new intake reusing an
//     existing book's title verbatim is still a collision worth
//     blocking for review)
//   - LEGACY_SOURCE_SEED below: slug-encoded source titles for the
//     pre-guard catalog (the slug IS the concatenated title for these)
// Regen / repair / colorize of an existing book are never guarded:
// callers exclude the target slug, and a book always matches itself.

export interface SourceIdentity {
  title: string; // normalized title (lowercase, no punctuation, no leading article)
  surname?: string; // normalized author surname, when one could be parsed
  key: string; // title + "|" + surname (surname omitted when unknown)
  tokens: string[]; // normalized title word tokens (set semantics)
}

export interface KnownSource extends SourceIdentity {
  slug: string;
  rawTitle: string; // the identity string as found, for messages
  via: string; // where the registry found it
}

export interface SourceMatch {
  duplicate: boolean;
  confidence?: "exact" | "fuzzy";
  matchedSlug?: string;
  matchedTitle?: string; // source title as stored for the matched book
  matchedBookTitle?: string; // the existing book's (kids') title in D1
  via?: string;
  candidateKey?: string;
}

export interface SourceGuardEnv {
  BOOKS: R2Bucket;
  DB: D1Database;
}

// ------------------------------------------------------------------
// Pure matching (no env; unit-tested by tools/sourceguard-test.ts)

const ARTICLES = new Set(["the", "a", "an"]);

function cleanToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Parse an author out of the forms our citations and intakes use:
// "Title (Author Names)", "Title by Author Names". Returns the title
// part and the author's surname (last name token), when parseable.
export function parseAuthor(raw: string): { titlePart: string; surname?: string } {
  let s = String(raw ?? "").trim();
  let authorPart: string | undefined;
  const paren = s.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (paren && paren[2].trim()) {
    s = paren[1].trim();
    authorPart = paren[2].trim();
  } else {
    const by = s.match(/^(.*?)\s+\bby\s+([A-Za-z][A-Za-z .,'-]*)$/i);
    if (by) {
      s = by[1].trim();
      authorPart = by[2].trim();
    }
  }
  let surname: string | undefined;
  if (authorPart) {
    const toks = authorPart
      .replace(/,/g, " ")
      .split(/\s+/)
      .map(cleanToken)
      .filter((t) => t && t !== "and");
    if (toks.length && toks.length <= 6) surname = toks[toks.length - 1];
  }
  return { titlePart: s, surname };
}

export function normalizeTitle(raw: string): string {
  let s = String(raw ?? "").toLowerCase();
  s = s.replace(/&/g, " and ");
  s = s.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const toks = s.split(" ").filter(Boolean);
  if (toks.length > 1 && ARTICLES.has(toks[0])) toks.shift();
  return toks.join(" ");
}

// Parse any identity string ("I Will Teach You to Be Rich (Ramit
// Sethi)", "Docker: Up & Running", "Mastery") into a SourceIdentity.
export function parseSourceIdentity(raw: string): SourceIdentity | null {
  const { titlePart, surname } = parseAuthor(String(raw ?? ""));
  const title = normalizeTitle(titlePart);
  if (!title) return null;
  const tokens = [...new Set(title.split(" ").filter(Boolean))];
  return { title, surname, key: surname ? `${title}|${surname}` : title, tokens };
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function isContained(a: string[], b: string[]): boolean {
  const A = new Set(a);
  const B = new Set(b);
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

// Compare a candidate identity against the known registry. Fail
// closed: exact canonical match, high token overlap (Jaccard >= 0.8),
// or title containment all count as duplicates. An author-surname
// conflict (both sides name different authors) vetoes a match: same
// title, different book ("Mastery" by Greene vs by anyone else).
export function matchIdentity(
  candidate: SourceIdentity,
  known: KnownSource[]
): SourceMatch {
  let fuzzy: (KnownSource & { score: number }) | null = null;
  for (const k of known) {
    if (candidate.surname && k.surname && candidate.surname !== k.surname) continue;
    if (candidate.title === k.title) {
      return {
        duplicate: true,
        confidence: "exact",
        matchedSlug: k.slug,
        matchedTitle: k.rawTitle,
        via: k.via,
        candidateKey: candidate.key,
      };
    }
    const score = jaccard(candidate.tokens, k.tokens);
    let hit = score >= 0.8;
    if (!hit && isContained(candidate.tokens, k.tokens)) {
      const small = Math.min(candidate.tokens.length, k.tokens.length);
      const big = Math.max(candidate.tokens.length, k.tokens.length);
      // "Algorithms" inside "Introduction to Algorithms", "Docker"
      // inside "Docker: Up & Running": containment counts, but a lone
      // short word ("Art" in "The War of Art") is not enough.
      const single =
        small === 1
          ? candidate.tokens.length <= k.tokens.length
            ? candidate.tokens[0]
            : k.tokens[0]
          : "";
      hit = small >= 2 || (single.length >= 5 && big <= 4);
    }
    if (hit && (!fuzzy || score > fuzzy.score)) fuzzy = { ...k, score };
  }
  if (fuzzy) {
    return {
      duplicate: true,
      confidence: "fuzzy",
      matchedSlug: fuzzy.slug,
      matchedTitle: fuzzy.rawTitle,
      via: fuzzy.via,
      candidateKey: candidate.key,
    };
  }
  return { duplicate: false, candidateKey: candidate.key };
}

export function duplicateMessage(candidateRaw: string, m: SourceMatch): string {
  const book = m.matchedBookTitle
    ? `'${m.matchedBookTitle}' (${m.matchedSlug})`
    : `the book '${m.matchedSlug}'`;
  return (
    `Source already adapted: '${candidateRaw}' is already adapted as ${book}. ` +
    `One source book gets one adaptation; refusing to build a duplicate.`
  );
}

// ------------------------------------------------------------------
// Registry (env-backed)

// Slug-encoded source titles for the pre-guard catalog: for these
// books the slug is the source title concatenated, and no citation
// was ever recorded in characters.source. New books never need a
// seed: the guard stamps book_info on every passed build.
const LEGACY_SOURCE_SEED: Record<string, string> = {
  richdadpoordad: "Rich Dad Poor Dad (Robert Kiyosaki)",
  thewarofart: "The War of Art (Steven Pressfield)",
  compoundeffect: "The Compound Effect (Darren Hardy)",
  motivationmanifesto: "The Motivation Manifesto (Brendon Burchard)",
  docker: "Docker: Up & Running (Sean Kane and Karl Matthias)",
};

async function r2GetJson(BOOKS: R2Bucket, key: string): Promise<any | null> {
  try {
    const o = await BOOKS.get(key);
    if (!o) return null;
    return JSON.parse(await o.text());
  } catch {
    return null;
  }
}

// Build the known-sources registry from the live catalog. Cheap
// enough to run per check (one D1 query + one small R2 read per book).
export async function loadKnownSources(env: SourceGuardEnv): Promise<KnownSource[]> {
  const out: KnownSource[] = [];
  const seen = new Set<string>();
  const add = (slug: string, raw: string, via: string) => {
    const id = parseSourceIdentity(raw);
    if (!id) return;
    const dedupe = `${slug}::${id.key}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push({ ...id, slug, rawTitle: String(raw).trim(), via });
  };

  let slugs: string[] = [];
  try {
    const rows: any = await env.DB.prepare("SELECT slug, title FROM books").all();
    for (const r of (rows?.results ?? []) as any[]) {
      const slug = String(r.slug ?? "");
      if (!slug) continue;
      slugs.push(slug);
      if (r.title) add(slug, String(r.title), "books.title");
    }
  } catch (e: any) {
    console.log(`source guard: books query failed: ${e?.message ?? e}`);
  }

  // Character citations: only "Title (Author)" shaped values count.
  try {
    const rows: any = await env.DB.prepare(
      "SELECT DISTINCT book_slug, source FROM characters WHERE source LIKE '%(%'"
    ).all();
    for (const r of (rows?.results ?? []) as any[]) {
      const slug = String(r.book_slug ?? "");
      const src = String(r.source ?? "");
      if (slug && src) {
        if (!slugs.includes(slug)) slugs.push(slug);
        add(slug, src, "characters.source");
      }
    }
  } catch (e: any) {
    console.log(`source guard: characters query failed: ${e?.message ?? e}`);
  }

  for (const slug of slugs) {
    const info = await r2GetJson(env.BOOKS, `books/${slug}/book_info.json`);
    if (info) {
      if (typeof info.sourceTitle === "string") add(slug, info.sourceTitle, "book_info.sourceTitle");
      if (typeof info.sourceTitleChecked === "string")
        add(slug, info.sourceTitleChecked, "book_info.sourceTitleChecked");
      if (typeof info.title === "string") add(slug, info.title, "book_info.title");
    }
    const seed = LEGACY_SOURCE_SEED[slug];
    if (seed) add(slug, seed, "legacy-seed");
  }
  return out;
}

// Check one candidate identity string against the registry.
// excludeSlug removes a book's own entries (a book always matches
// itself; rebuilds and existing-book operations are never blocked).
export async function checkSourceDuplicate(
  env: SourceGuardEnv,
  candidateRaw: string,
  opts: { excludeSlug?: string } = {}
): Promise<SourceMatch> {
  const candidate = parseSourceIdentity(candidateRaw);
  if (!candidate) return { duplicate: false };
  const known = (await loadKnownSources(env)).filter(
    (k) => !opts.excludeSlug || k.slug !== opts.excludeSlug
  );
  const m = matchIdentity(candidate, known);
  if (m.duplicate && m.matchedSlug) {
    try {
      const row: any = await env.DB.prepare("SELECT title FROM books WHERE slug=?")
        .bind(m.matchedSlug)
        .first();
      if (row?.title) m.matchedBookTitle = String(row.title);
    } catch { /* message falls back to the slug */ }
  }
  return m;
}
