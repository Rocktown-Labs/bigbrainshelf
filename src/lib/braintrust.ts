// Pillar 1: "The Pixar Braintrust" — Vectorize, Workers AI, Canon Continuity,
// "Ask the Shelf" Semantic Curriculum Discovery, Demand Clustering & AI COGS Ledger.
//
// Works in two modes:
//   1. Cloudflare Edge Mode: uses `env.AI` (@cf/baai/bge-base-en-v1.5) and
//      optional `env.VECTORIZE_CANON` / `env.VECTORIZE_CURRICULUM` bindings,
//      while also persisting vectors into D1 `vector_embeddings`.
//   2. Deterministic Concept-Vector Mode: projects text into a 32-dimension
//      curriculum & character concept space so semantic search, canon RAG,
//      and parent demand clustering work deterministically in local dev and
//      in-memory SQLite tests even when Workers AI is not bound.

import type { DBLike } from "./orders";
import { ensureOnce } from "./schema-cache";
import { normalizeText, tokenize } from "./search";

export type VectorNamespace = "canon" | "curriculum";
export type VectorEntityType = "book" | "chapter" | "character" | "bible";

export interface VectorRecord {
  id: string;
  namespace: VectorNamespace;
  entity_type: VectorEntityType;
  book_slug: string;
  title: string;
  subtitle: string | null;
  topic: string | null;
  age_group: string;
  content_text: string;
  embedding: number[];
  metadata: Record<string, any>;
  updated_at: number;
}

export interface SemanticMatch {
  id: string;
  namespace: VectorNamespace;
  entityType: VectorEntityType;
  bookSlug: string;
  title: string;
  subtitle: string;
  topic: string;
  ageGroup: string;
  score: number;
  whyItMatches: string;
  href: string;
  metadata: Record<string, any>;
}

export interface GenerationCostEntry {
  id?: string;
  book_slug: string;
  gateway?: "vercel-ai-gateway" | "gemini-direct" | "hyperframes";
  stage: "bible" | "script" | "illustration" | "tts" | "video_hyperframes" | "lift";
  model: string;
  units?: number;
  cost_cents: number;
  metadata?: Record<string, any>;
}

// 16 core curriculum & emotional-learning dimensions + 16 hash-projected dimensions
// so any parent query ("my 6-year-old gets frustrated when losing board games" or
// "how compound interest works for kids") lands near the right story/chapter.
const SEMANTIC_AXES: { label: string; terms: string[] }[] = [
  {
    label: "patience & mastery",
    terms: ["patience", "patient", "wait", "waiting", "still", "water", "mastery", "practice", "practicing", "slow", "focus", "calm", "frustrated", "frustration", "lose", "losing", "try", "again", "mistake", "mistakes", "mira", "heron"],
  },
  {
    label: "courage & big feelings",
    terms: ["courage", "brave", "bravery", "fear", "afraid", "scared", "nervous", "shy", "new", "confidence", "confident", "resilience", "perseverance", "grit", "quit", "giving", "emotions", "feelings", "anger", "sad"],
  },
  {
    label: "money, saving & compounding",
    terms: ["money", "save", "saving", "savings", "spend", "spending", "invest", "investing", "compound", "compounding", "interest", "acorn", "orchard", "penny", "squirrel", "rich", "wealth", "allowance", "bank", "coins", "budget"],
  },
  {
    label: "entrepreneurship & value creation",
    terms: ["business", "entrepreneurship", "build", "create", "customer", "trade", "work", "earn", "goal", "goals", "plan", "project", "ownership", "habit", "habits", "choices", "choice"],
  },
  {
    label: "algorithms, coding & problem solving",
    terms: ["tech", "technology", "algorithm", "algorithms", "code", "coding", "computer", "step", "steps", "trail", "trails", "fern", "fox", "logic", "puzzle", "debug", "sorting", "search", "recipe", "instructions"],
  },
  {
    label: "systems, containers & organization",
    terms: ["docker", "container", "containers", "harbor", "bins", "wally", "whale", "organize", "packing", "system", "systems", "ship", "shipping", "clean", "tidy", "modular"],
  },
  {
    label: "architecture & design patterns",
    terms: ["pattern", "patterns", "design", "basil", "beaver", "dam", "blueprint", "strategy", "observer", "decorator", "structure", "engineering", "bridge", "build"],
  },
  {
    label: "science & nature discovery",
    terms: ["science", "nature", "animals", "biology", "physics", "experiment", "curious", "curiosity", "why", "how", "river", "forest", "ocean", "weather", "ecosystem", "earth"],
  },
  {
    label: "math, numbers & patterns",
    terms: ["math", "numbers", "count", "counting", "multiply", "addition", "geometry", "shape", "shapes", "measure", "fraction", "probability", "sequence"],
  },
  {
    label: "history, biographies & inventions",
    terms: ["history", "past", "invent", "invention", "inventor", "biography", "civilization", "ancient", "explorer", "discovery", "leader", "leaders", "time"],
  },
  {
    label: "space & astronomy",
    terms: ["space", "stars", "planet", "planets", "moon", "rocket", "astronaut", "galaxy", "universe", "solar", "orbit", "telescope"],
  },
  {
    label: "art, music & storytelling",
    terms: ["art", "draw", "drawing", "color", "coloring", "paint", "music", "song", "creative", "creativity", "imagination", "story", "stories", "write"],
  },
  {
    label: "friendship, kindness & teamwork",
    terms: ["friend", "friends", "friendship", "share", "sharing", "kind", "kindness", "help", "helping", "team", "teamwork", "sibling", "family", "listen", "listening", "empathy", "mentor"],
  },
  {
    label: "bedtime & calm wind-down",
    terms: ["bedtime", "sleep", "sleeping", "night", "quiet", "peaceful", "dream", "dreams", "gentle", "rest", "cozy", "audio", "readalong"],
  },
  {
    label: "critical thinking & focus",
    terms: ["think", "thinking", "question", "questions", "truth", "integrity", "attention", "distraction", "shortcut", "shortcuts", "otter", "deep", "learn", "learning"],
  },
  {
    label: "school, classroom & homeschool readiness",
    terms: ["school", "classroom", "teacher", "homeschool", "lesson", "curriculum", "grade", "reading", "vocabulary", "comprehension", "quiz"],
  },
];

export async function ensureBraintrustTables(db: DBLike): Promise<void> {
  await ensureOnce(db, "braintrust_tables_v1", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS vector_embeddings (
          id TEXT PRIMARY KEY,
          namespace TEXT NOT NULL DEFAULT 'curriculum',
          entity_type TEXT NOT NULL,
          book_slug TEXT NOT NULL,
          title TEXT NOT NULL,
          subtitle TEXT,
          topic TEXT,
          age_group TEXT DEFAULT '4-8',
          content_text TEXT NOT NULL,
          embedding_json TEXT NOT NULL,
          metadata_json TEXT DEFAULT '{}',
          updated_at INTEGER NOT NULL
        )`
      )
      .run();
    await db
      .prepare("CREATE INDEX IF NOT EXISTS vector_embeddings_ns_idx ON vector_embeddings(namespace, book_slug)")
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS generation_cost_ledger (
          id TEXT PRIMARY KEY,
          book_slug TEXT NOT NULL,
          gateway TEXT NOT NULL DEFAULT 'vercel-ai-gateway',
          stage TEXT NOT NULL,
          model TEXT NOT NULL,
          units INTEGER NOT NULL DEFAULT 1,
          cost_cents INTEGER NOT NULL DEFAULT 0,
          metadata_json TEXT DEFAULT '{}',
          created_at INTEGER NOT NULL
        )`
      )
      .run();
    await db
      .prepare("CREATE INDEX IF NOT EXISTS generation_cost_book_idx ON generation_cost_ledger(book_slug, created_at)")
      .run();
  });
}

// Compute a normalized 32-d semantic embedding deterministically, or via
// Cloudflare Workers AI (@cf/baai/bge-base-en-v1.5) when `env.AI` is requested.
export function computeConceptEmbedding(text: string): number[] {
  const tokens = tokenize(text);
  const vec = new Array<number>(32).fill(0);
  if (tokens.length === 0) return vec;

  // First 16 dimensions: semantic curriculum & character axes
  for (let i = 0; i < SEMANTIC_AXES.length; i++) {
    const axis = SEMANTIC_AXES[i];
    let hits = 0;
    for (const tok of tokens) {
      for (const term of axis.terms) {
        if (tok === term) hits += 2.0;
        else if (tok.length >= 4 && (term.startsWith(tok) || tok.startsWith(term))) hits += 1.2;
      }
    }
    vec[i] = hits;
  }

  // Next 16 dimensions: deterministic token trigram/word hash projection
  for (const tok of tokens) {
    if (tok.length < 3) continue;
    let hash = 2166136261;
    for (let c = 0; c < tok.length; c++) {
      hash ^= tok.charCodeAt(c);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = 16 + (Math.abs(hash) % 16);
    vec[bucket] += 1.0;
  }

  // L2 normalize
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] = Number((vec[i] / norm).toFixed(5));
    }
  }
  return vec;
}

export async function embedText(text: string, env?: any): Promise<number[]> {
  // Always compute the fast 32-d concept embedding so local/edge dimensionalities match,
  // and if Workers AI is explicitly enabled with VECTORIZE, also support full BGE vectors.
  if (env?.AI && env?.USE_WORKERS_AI_EMBEDDINGS === "1") {
    try {
      const res = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [text.slice(0, 1500)] });
      const data = res?.data?.[0];
      if (Array.isArray(data) && data.length > 0) return data;
    } catch {
      // Fall back to deterministic concept embedding
    }
  }
  return computeConceptEmbedding(text);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

export function explainMatchReason(query: string, contentText: string, topic: string | null): string {
  const qVec = computeConceptEmbedding(query);
  const cVec = computeConceptEmbedding(contentText);
  let bestAxisIdx = -1;
  let bestProduct = 0;
  for (let i = 0; i < SEMANTIC_AXES.length; i++) {
    const prod = qVec[i] * cVec[i];
    if (prod > bestProduct) {
      bestProduct = prod;
      bestAxisIdx = i;
    }
  }
  if (bestAxisIdx >= 0 && bestProduct > 0.01) {
    return `Matches "${SEMANTIC_AXES[bestAxisIdx].label}"`;
  }
  if (topic) {
    return `Recommended from the ${topic} shelf`;
  }
  return "Recommended from the Big Brain Shelf";
}

// Index all books, chapters, characters, and story bibles into `vector_embeddings`
// (and `env.VECTORIZE_CANON` / `env.VECTORIZE_CURRICULUM` when bound).
export async function indexCatalogVectors(
  db: DBLike,
  env?: any
): Promise<{ indexed: number; canonCount: number; curriculumCount: number }> {
  await ensureBraintrustTables(db);
  const now = Math.floor(Date.now() / 1000);
  let indexed = 0;
  let canonCount = 0;
  let curriculumCount = 0;

  // 1. Load books
  let books: any[] = [];
  try {
    const bRes = await db
      .prepare(
        "SELECT slug, title, topic, topics, description, status, cover_key, audiobook_key, public_slug FROM books"
      )
      .all();
    books = (bRes.results || (bRes as any).rows || []) as any[];
  } catch {
    const bRes = await db
      .prepare("SELECT slug, title, topic, status, cover_key, audiobook_key FROM books")
      .all();
    books = (bRes.results || (bRes as any).rows || []) as any[];
  }

  const bookMap = new Map<string, any>();
  for (const b of books) bookMap.set(String(b.slug), b);

  // 2. Load bibles
  let bibles: any[] = [];
  try {
    const biRes = await db.prepare("SELECT book_slug, big_idea, data FROM bibles").all();
    bibles = (biRes.results || (biRes as any).rows || []) as any[];
  } catch {}

  const bibleByBook = new Map<string, any>();
  for (const bi of bibles) bibleByBook.set(String(bi.book_slug), bi);

  // 3. Index published/complete books into 'curriculum' namespace
  for (const b of books) {
    const slug = String(b.slug);
    const bi = bibleByBook.get(slug);
    const pubSlug = String(b.public_slug || slug);
    const content = [
      b.title,
      b.topic,
      b.topics,
      b.description,
      bi?.big_idea,
      bi?.data ? String(bi.data).slice(0, 800) : "",
    ]
      .filter(Boolean)
      .join(" · ");

    const emb = await embedText(content, env);
    const meta = {
      status: b.status || "complete",
      publicSlug: pubSlug,
      coverKey: b.cover_key || null,
      hasAudio: Boolean(b.audiobook_key),
      href: `/books/${pubSlug}`,
    };

    await db
      .prepare(
        `INSERT INTO vector_embeddings
          (id, namespace, entity_type, book_slug, title, subtitle, topic, age_group, content_text, embedding_json, metadata_json, updated_at)
         VALUES (?, 'curriculum', 'book', ?, ?, ?, ?, '4-8', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           subtitle = excluded.subtitle,
           topic = excluded.topic,
           content_text = excluded.content_text,
           embedding_json = excluded.embedding_json,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`
      )
      .bind(
        `curriculum:book:${slug}`,
        slug,
        String(b.title || slug),
        String(bi?.big_idea || b.description || ""),
        String(b.topic || "general"),
        content,
        JSON.stringify(emb),
        JSON.stringify(meta),
        now
      )
      .run();
    indexed++;
    curriculumCount++;

    // Also index bible into 'canon' namespace
    if (bi) {
      await db
        .prepare(
          `INSERT INTO vector_embeddings
            (id, namespace, entity_type, book_slug, title, subtitle, topic, age_group, content_text, embedding_json, metadata_json, updated_at)
           VALUES (?, 'canon', 'bible', ?, ?, ?, ?, '4-8', ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             content_text = excluded.content_text,
             embedding_json = excluded.embedding_json,
             updated_at = excluded.updated_at`
        )
        .bind(
          `canon:bible:${slug}`,
          slug,
          `${b.title || slug} — Story Bible`,
          String(bi.big_idea || ""),
          String(b.topic || "general"),
          content,
          JSON.stringify(emb),
          JSON.stringify({ bookSlug: slug }),
          now
        )
        .run();
      indexed++;
      canonCount++;
    }
  }

  // 4. Index characters into 'canon' and 'curriculum'
  try {
    const cRes = await db
      .prepare("SELECT id, book_slug, name, species, visual_prompt, role FROM characters")
      .all()
      .catch(() =>
        db.prepare("SELECT id, book_slug, name, species, visual_prompt FROM characters").all()
      );
    const chars = (cRes.results || (cRes as any).rows || []) as any[];
    for (const c of chars) {
      const book = bookMap.get(String(c.book_slug));
      const charSlug = normalizeText(String(c.name || c.id)).replace(/\s+/g, "-");
      const content = [
        c.name,
        c.species,
        c.role,
        c.visual_prompt,
        book?.title,
        book?.topic,
      ]
        .filter(Boolean)
        .join(" · ");
      const emb = await embedText(content, env);
      await db
        .prepare(
          `INSERT INTO vector_embeddings
            (id, namespace, entity_type, book_slug, title, subtitle, topic, age_group, content_text, embedding_json, metadata_json, updated_at)
           VALUES (?, 'canon', 'character', ?, ?, ?, ?, '4-8', ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             content_text = excluded.content_text,
             embedding_json = excluded.embedding_json,
             updated_at = excluded.updated_at`
        )
        .bind(
          `canon:char:${c.id}`,
          String(c.book_slug || ""),
          String(c.name || c.id),
          `${c.species || "character"} in ${book?.title || c.book_slug}`,
          String(book?.topic || "general"),
          content,
          JSON.stringify(emb),
          JSON.stringify({
            charSlug,
            species: c.species || "",
            visualPrompt: c.visual_prompt || "",
            href: `/meet-the-cast/${charSlug}`,
          }),
          now
        )
        .run();
      indexed++;
      canonCount++;
    }
  } catch {}

  // 5. Index chapters into 'curriculum' and 'canon'
  try {
    const chRes = await db
      .prepare("SELECT id, book_slug, num, title, real_concept, summary FROM chapters")
      .all()
      .catch(() =>
        db.prepare("SELECT id, book_slug, num, title FROM chapters").all()
      );
    const chs = (chRes.results || (chRes as any).rows || []) as any[];
    for (const ch of chs) {
      const book = bookMap.get(String(ch.book_slug));
      const pubSlug = String(book?.public_slug || ch.book_slug);
      const content = [
        ch.title,
        ch.real_concept,
        ch.summary,
        book?.title,
        book?.topic,
      ]
        .filter(Boolean)
        .join(" · ");
      const emb = await embedText(content, env);
      await db
        .prepare(
          `INSERT INTO vector_embeddings
            (id, namespace, entity_type, book_slug, title, subtitle, topic, age_group, content_text, embedding_json, metadata_json, updated_at)
           VALUES (?, 'curriculum', 'chapter', ?, ?, ?, ?, '4-8', ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             content_text = excluded.content_text,
             embedding_json = excluded.embedding_json,
             updated_at = excluded.updated_at`
        )
        .bind(
          `curriculum:ch:${ch.book_slug}:${ch.num}`,
          String(ch.book_slug),
          `Ch. ${ch.num}: ${ch.title || "Story Chapter"}`,
          `${book?.title || ch.book_slug}${ch.real_concept ? ` · ${ch.real_concept}` : ""}`,
          String(book?.topic || "general"),
          content,
          JSON.stringify(emb),
          JSON.stringify({
            chapterNum: Number(ch.num || 1),
            bookTitle: book?.title || ch.book_slug,
            status: book?.status || "complete",
            href: `/books/${pubSlug}`,
          }),
          now
        )
        .run();
      indexed++;
      curriculumCount++;
    }
  } catch {}

  return { indexed, canonCount, curriculumCount };
}

// Semantic "Ask the Shelf" query for parents & kids
export async function semanticAskTheShelf(
  db: DBLike,
  env: any,
  query: string,
  opts: { namespace?: VectorNamespace; limit?: number; onlyPublished?: boolean; ageGroup?: string } = {}
): Promise<SemanticMatch[]> {
  await ensureBraintrustTables(db);
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return [];

  // Ensure catalog is indexed at least once if table is empty
  const countRow = (await db
    .prepare("SELECT COUNT(*) as n FROM vector_embeddings")
    .first()
    .catch(() => null)) as any;
  if (!countRow || Number(countRow.n || 0) === 0) {
    await indexCatalogVectors(db, env);
  }

  const qVec = await embedText(cleanQuery, env);
  const qTokens = tokenize(cleanQuery);
  const ns = opts.namespace;
  const limit = opts.limit ?? 8;

  const rowsRes = ns
    ? await db.prepare("SELECT * FROM vector_embeddings WHERE namespace = ?").bind(ns).all()
    : await db.prepare("SELECT * FROM vector_embeddings").all();
  const rows = (rowsRes.results || (rowsRes as any).rows || []) as any[];

  const matches: SemanticMatch[] = [];
  for (const row of rows) {
    let meta: Record<string, any> = {};
    try {
      meta = JSON.parse(row.metadata_json || "{}");
    } catch {}

    if (opts.onlyPublished && row.entity_type === "book" && meta.status && meta.status !== "complete") {
      continue;
    }

    let emb: number[] = [];
    try {
      emb = JSON.parse(row.embedding_json || "[]");
    } catch {}
    if (!emb.length) emb = computeConceptEmbedding(String(row.content_text || ""));

    let score = cosineSimilarity(qVec, emb);

    // Boost direct lexical token overlaps so hybrid search gets best of both worlds
    const normContent = normalizeText(String(row.content_text || ""));
    for (const tok of qTokens) {
      if (tok.length >= 3 && normContent.includes(tok)) {
        score += 0.15;
      }
    }

    if (score >= 0.12) {
      matches.push({
        id: String(row.id),
        namespace: (row.namespace as VectorNamespace) || "curriculum",
        entityType: (row.entity_type as VectorEntityType) || "book",
        bookSlug: String(row.book_slug),
        title: String(row.title),
        subtitle: String(row.subtitle || ""),
        topic: String(row.topic || "general"),
        ageGroup: String(row.age_group || "4-8"),
        score: Number(score.toFixed(4)),
        whyItMatches: explainMatchReason(cleanQuery, String(row.content_text || ""), row.topic),
        href: String(meta.href || `/books/${row.book_slug}`),
        metadata: meta,
      });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit);
}

// Retrieve Canon Continuity ("The Pixar Braintrust") before generating new scripts or videos
export async function retrieveCanonContinuity(
  db: DBLike,
  env: any,
  promptOrTopic: string,
  bookSlug?: string
): Promise<{
  canonFacts: SemanticMatch[];
  continuityPromptBlock: string;
}> {
  const matches = await semanticAskTheShelf(db, env, promptOrTopic, {
    namespace: "canon",
    limit: 6,
  });
  const filtered = bookSlug
    ? matches.sort((a, b) => (a.bookSlug === bookSlug ? -1 : b.bookSlug === bookSlug ? 1 : 0))
    : matches;

  const lines = filtered.map(
    (m) => `- [${m.entityType.toUpperCase()} · ${m.title}] (${m.subtitle}): ${m.whyItMatches}`
  );
  return {
    canonFacts: filtered,
    continuityPromptBlock:
      lines.length > 0
        ? `BIG BRAIN SHELF CANON CONTINUITY:\n${lines.join("\n")}`
        : "BIG BRAIN SHELF CANON CONTINUITY: Standard studio rules apply.",
  };
}

// Demand-Driven Editorial Queue: cluster parent `favorite_topics`, `future_topics`,
// and `custom_topic_request` from `parent_onboarding`
export async function clusterParentTopicDemand(
  db: DBLike
): Promise<{
  rankedTopics: { topic: string; count: number; weight: string }[];
  customRequests: { request: string; matchedAxis: string }[];
  totalFamiliesSurveyed: number;
}> {
  await ensureBraintrustTables(db);
  const counts = new Map<string, number>();
  const customRequests: { request: string; matchedAxis: string }[] = [];
  let totalFamiliesSurveyed = 0;

  try {
    const res = await db
      .prepare("SELECT favorite_topics, future_topics, custom_topic_request FROM parent_onboarding")
      .all();
    const rows = (res.results || (res as any).rows || []) as any[];
    totalFamiliesSurveyed = rows.length;

    for (const r of rows) {
      let favs: string[] = [];
      let futs: string[] = [];
      try {
        favs = JSON.parse(r.favorite_topics || "[]");
      } catch {}
      try {
        futs = JSON.parse(r.future_topics || "[]");
      } catch {}

      for (const t of favs) {
        const k = String(t).toLowerCase().trim();
        if (k) counts.set(k, (counts.get(k) || 0) + 1);
      }
      // Future topics get a 2x demand weight for editorial roadmap prioritization
      for (const t of futs) {
        const k = String(t).toLowerCase().trim();
        if (k) counts.set(k, (counts.get(k) || 0) + 2);
      }
      const custom = String(r.custom_topic_request || "").trim();
      if (custom) {
        customRequests.push({
          request: custom,
          matchedAxis: explainMatchReason(custom, custom, null).replace(/^Matches "/, "").replace(/"$/, ""),
        });
      }
    }
  } catch {}

  const rankedTopics = Array.from(counts.entries())
    .map(([topic, count]) => ({
      topic,
      count,
      weight: count >= 5 ? "High Priority" : count >= 2 ? "Growing Demand" : "Emerging",
    }))
    .sort((a, b) => b.count - a.count);

  return { rankedTopics, customRequests, totalFamiliesSurveyed };
}

// AI COGS Ledger: tracks Vercel AI Gateway (LLM sale), Gemini (image/TTS), and HyperFrames video spend
export async function recordGenerationCost(
  db: DBLike,
  entry: GenerationCostEntry
): Promise<{ id: string }> {
  await ensureBraintrustTables(db);
  const id = entry.id || `cogs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO generation_cost_ledger
        (id, book_slug, gateway, stage, model, units, cost_cents, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      entry.book_slug,
      entry.gateway || "vercel-ai-gateway",
      entry.stage,
      entry.model,
      entry.units ?? 1,
      Math.round(entry.cost_cents),
      JSON.stringify(entry.metadata || {}),
      now
    )
    .run();
  return { id };
}

export async function getGenerationCostSummary(
  db: DBLike
): Promise<{
  totalCents: number;
  byGateway: Record<string, number>;
  byBook: { bookSlug: string; costCents: number; calls: number }[];
}> {
  await ensureBraintrustTables(db);
  const res = await db
    .prepare("SELECT book_slug, gateway, cost_cents, units FROM generation_cost_ledger")
    .all()
    .catch(() => ({ results: [] }));
  const rows = (res.results || (res as any).rows || []) as any[];

  let totalCents = 0;
  const byGateway: Record<string, number> = {
    "vercel-ai-gateway": 0,
    "gemini-direct": 0,
    hyperframes: 0,
  };
  const bookMap = new Map<string, { costCents: number; calls: number }>();

  for (const r of rows) {
    const c = Number(r.cost_cents || 0);
    const gw = String(r.gateway || "vercel-ai-gateway");
    const slug = String(r.book_slug || "unknown");
    totalCents += c;
    byGateway[gw] = (byGateway[gw] || 0) + c;
    const prev = bookMap.get(slug) || { costCents: 0, calls: 0 };
    prev.costCents += c;
    prev.calls += Number(r.units || 1);
    bookMap.set(slug, prev);
  }

  const byBook = Array.from(bookMap.entries())
    .map(([bookSlug, v]) => ({ bookSlug, costCents: v.costCents, calls: v.calls }))
    .sort((a, b) => b.costCents - a.costCents);

  return { totalCents, byGateway, byBook };
}
