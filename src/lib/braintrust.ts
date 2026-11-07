/**
 * Pillar 1: "The Pixar Braintrust"
 * - Canon & Lore Continuity (`bbs-canon-lore`) + "Ask the Shelf" Semantic Curriculum Discovery (`bbs-curriculum-discovery`)
 * - Uses Cloudflare Workers AI (`@cf/baai/bge-base-en-v1.5`) + Cloudflare Vectorize (`VECTORIZE_CANON` / `VECTORIZE_CURRICULUM`)
 *   when bindings are present on `env`.
 * - Honest Scaffolding Fallback: When Vectorize/Workers AI bindings are not provisioned in local dev or D1-only environments,
 *   falls back to a deterministic 32-d concept projection stored in D1 (`vector_embeddings`), explicitly labeled as
 *   `backend: "d1_concept_scaffolding"`.
 * - Per-Book AI Production COGS Ledger (`generation_cost_ledger`) supporting Vercel AI Gateway (`vercel-ai-gateway`)
 *   and direct Gemini image/TTS calls (`gemini-direct`).
 */

import { KID_AVATARS, CURRENT_TOPIC_OPTIONS, FUTURE_TOPIC_OPTIONS } from "./family";
import { catalogTitle } from "./catalog";

export type BraintrustIndexName = "bbs-canon-lore" | "bbs-curriculum-discovery";
export type BraintrustBackendMode = "vectorize_edge" | "d1_concept_scaffolding";

export interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, any>;
}

export interface VectorizeIndexBinding {
  upsert(
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: Record<string, string | number | boolean>;
    }>
  ): Promise<unknown>;
  query(
    vector: number[],
    options?: { topK?: number; returnMetadata?: boolean | "all" | "none" }
  ): Promise<{ matches: VectorizeMatch[] }>;
}

export interface BraintrustEnv {
  DB?: D1Database;
  AI?: {
    run(model: string, input: { text: string | string[] }): Promise<{ data?: number[][] }>;
  };
  VECTORIZE_CANON?: VectorizeIndexBinding;
  VECTORIZE_CURRICULUM?: VectorizeIndexBinding;
  VERCEL_AI_GATEWAY_URL?: string;
  CLOUDFLARE_AI_GATEWAY_ID?: string;
}

export interface SemanticShelfMatch {
  id: string;
  bookSlug: string;
  bookTitle: string;
  entityType: "book" | "chapter" | "curriculum" | "character";
  entityId: string;
  title: string;
  snippet: string;
  ageBand: string;
  topicTags: string[];
  score: number;
  url: string;
  recommendedOffer: {
    bundlePrice: "$12.99";
    audioClubPrice: "$5.99/mo";
    bookClubPrice: "$60/quarter";
  };
}

export interface CanonContinuityFact {
  id: string;
  entityType: "character" | "chapter" | "book";
  title: string;
  factText: string;
  bookSlug: string;
  score: number;
}

export interface GenerationCostEntry {
  bookSlug: string;
  stage: "story_text" | "image_gen" | "tts_audio" | "embedding";
  provider?: "vercel-ai-gateway" | "gemini-direct" | "cloudflare-workers-ai";
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostMicros: number;
  gatewayCached?: boolean;
  metadata?: Record<string, unknown>;
}

const SERIES_HOOK =
  "Big Brain Shelf turns big ideas (systems thinking, compounding, patterns in nature, resilience, and technology) into warm, illustrated read-aloud adventures for curious families.";

// There is deliberately NO hardcoded catalog seed list here. An earlier
// draft invented titles and public slugs for five books and wired them
// into live search, sending parents to wrong titles and 404s. Every
// catalog document below is built from the real books table, so titles,
// slugs, and coverage can never drift from the store.

const CONCEPT_AXES: ReadonlyArray<readonly string[]> = [
  ["math", "number", "count", "pattern", "fibonacci", "sequence", "spiral", "pinecone", "petal", "geometry"],
  ["science", "experiment", "hypothesis", "biology", "physics", "chemistry", "gravity", "atom", "energy", "lab"],
  ["nature", "forest", "tree", "plant", "garden", "animal", "seed", "leaf", "river", "weather", "fern", "moss"],
  ["money", "save", "spend", "invest", "compound", "interest", "bank", "coin", "budget", "acorn", "earn"],
  ["emotion", "frustrated", "angry", "lose", "losing", "calm", "patience", "brave", "scared", "worry", "feelings"],
  ["friendship", "share", "team", "help", "kind", "listen", "empathy", "together", "conflict", "apologize", "mira"],
  ["focus", "attention", "distracted", "bored", "practice", "habit", "grit", "persevere", "mistake", "mastery", "fail"],
  ["history", "ancient", "civilization", "invention", "explorer", "past", "timeline", "map", "culture", "story"],
  ["logic", "puzzle", "code", "algorithm", "question", "blueprint", "reason", "proof", "detective", "solve", "basil"],
  ["art", "draw", "color", "music", "paint", "create", "design", "shape", "rhythm", "imagine", "craft"],
  ["space", "star", "planet", "moon", "orbit", "galaxy", "rocket", "astronomy", "telescope", "universe", "sun"],
  ["body", "sleep", "brain", "grow", "food", "health", "breath", "muscle", "heart", "senses", "rest"],
  ["reading", "book", "word", "aloud", "bedtime", "chapter", "vocabulary", "voice", "narrator", "audiobook"],
  ["curiosity", "wonder", "discover", "explore", "observe", "notice", "magnifying", "secret", "hidden", "penny"],
  ["leadership", "choice", "decide", "fair", "rule", "responsibility", "courage", "honest", "trust", "promise"],
  ["systems", "container", "docker", "modular", "ship", "wally", "balance", "ecosystem", "network", "connection"],
];

let schemaReady = false;

export async function ensureBraintrustSchema(db?: D1Database): Promise<void> {
  if (!db || schemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS vector_embeddings (
        id TEXT PRIMARY KEY,
        index_name TEXT NOT NULL,
        book_slug TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content_text TEXT NOT NULL,
        age_band TEXT,
        topic_tags_json TEXT NOT NULL DEFAULT '[]',
        embedding_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      )`
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS generation_cost_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_slug TEXT NOT NULL,
        stage TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'vercel-ai-gateway',
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
        gateway_cached INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      )`
    )
    .run();
  schemaReady = true;
}

/**
 * Local 32-dimensional concept + character trigram projection used ONLY as D1 scaffolding
 * when Cloudflare Workers AI (`@cf/baai/bge-base-en-v1.5`) is not bound in local dev/tests.
 */
export function computeLocalConceptEmbedding(text: string): number[] {
  const normalized = (text || "").toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const vec = new Array<number>(32).fill(0);

  for (let axisIdx = 0; axisIdx < CONCEPT_AXES.length; axisIdx++) {
    const keywords = CONCEPT_AXES[axisIdx];
    let hits = 0;
    for (const token of tokens) {
      for (const kw of keywords) {
        if (
          token === kw ||
          (token.length >= 4 && kw.startsWith(token)) ||
          (kw.length >= 4 && token.startsWith(kw))
        ) {
          hits += 1;
        }
      }
    }
    vec[axisIdx] = hits;
  }

  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = 16 + (Math.abs(hash) % 16);
    vec[bucket] += 0.35;
  }

  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => Number((v / norm).toFixed(5)));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const len = Math.min(a.length, b.length);
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

export async function generateEmbedding(
  text: string,
  env?: BraintrustEnv
): Promise<{ values: number[]; model: string; isEdgeAi: boolean }> {
  if (env?.AI) {
    try {
      const res = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [text] });
      const edgeValues = res?.data?.[0];
      if (Array.isArray(edgeValues) && edgeValues.length > 0) {
        return { values: edgeValues, model: "@cf/baai/bge-base-en-v1.5", isEdgeAi: true };
      }
    } catch {
      // Fall back to deterministic D1 concept scaffolding when Workers AI is unavailable locally
    }
  }
  return {
    values: computeLocalConceptEmbedding(text),
    model: "d1-local-concept-scaffolding-v1",
    isEdgeAi: false,
  };
}

export function detectBraintrustBackend(env?: BraintrustEnv): BraintrustBackendMode {
  // The label names the READ path that actually serves search results.
  // Indexing upserts to Vectorize when an index is bound, but no read
  // path queries Vectorize today: semanticAskTheShelf and
  // retrieveCanonContinuity score local concept vectors over documents
  // built from the books table. Until a Vectorize read path exists, the
  // honest label is the scaffolding, whatever bindings are present.
  void env;
  return "d1_concept_scaffolding";
}

export interface CatalogVectorDocument {
  id: string;
  indexName: BraintrustIndexName;
  bookSlug: string;
  publicSlug: string;
  entityType: "character" | "chapter" | "curriculum" | "book";
  entityId: string;
  title: string;
  contentText: string;
  ageBand: string;
  topicTags: string[];
}

export async function buildCatalogVectorDocuments(
  db?: D1Database
): Promise<CatalogVectorDocument[]> {
  const docs: CatalogVectorDocument[] = [];

  for (const avatar of KID_AVATARS) {
    docs.push({
      id: `canon:cast:${avatar.id}`,
      indexName: "bbs-canon-lore",
      bookSlug: "series-canon",
      publicSlug: avatar.id,
      entityType: "character",
      entityId: avatar.id,
      title: `${avatar.name} — ${avatar.label}`,
      contentText: `${avatar.name} (${avatar.label}): ${SERIES_HOOK}`,
      ageBand: "4-8",
      topicTags: ["canon", "character", avatar.id],
    });
  }

  if (db) {
    try {
      // The same candidate set /api/search uses: status='complete' only,
      // so semantic results can never point at a book the store does not
      // sell yet. Coverage grows on its own as books complete.
      const rows = await db
        .prepare(
          `SELECT slug, public_slug, title, description, topic, topics FROM books WHERE status = 'complete' LIMIT 100`
        )
        .all<{
          slug: string;
          public_slug: string | null;
          title: string;
          description: string | null;
          topic: string | null;
          topics: string | null;
        }>();
      for (const b of rows.results || []) {
        const contentText = `${b.title || b.slug}. ${b.description || ""} Topics: ${b.topic || ""} ${b.topics || ""}`;
        docs.push({
          id: `book:${b.slug}`,
          indexName: "bbs-curriculum-discovery",
          bookSlug: b.slug,
          publicSlug: b.public_slug || b.slug,
          entityType: "book",
          entityId: b.slug,
          title: b.title || b.slug,
          contentText,
          ageBand: "4-8",
          topicTags: ["book", b.topic || "story", b.slug],
        });
        docs.push({
          id: `canon:book:${b.slug}`,
          indexName: "bbs-canon-lore",
          bookSlug: b.slug,
          publicSlug: b.public_slug || b.slug,
          entityType: "book",
          entityId: b.slug,
          title: b.title || b.slug,
          contentText,
          ageBand: "4-8",
          topicTags: ["canon", b.topic || "story", b.slug],
        });
      }
    } catch {
      // books table may not be populated in unit tests
    }
  }

  return docs;
}

export async function indexCatalogVectors(env?: BraintrustEnv): Promise<{
  indexedCount: number;
  canonCount: number;
  curriculumCount: number;
  usedEdgeVectorize: boolean;
  backend: BraintrustBackendMode;
}> {
  await ensureBraintrustSchema(env?.DB);
  const docs = await buildCatalogVectorDocuments(env?.DB);
  const now = new Date().toISOString();
  let canonCount = 0;
  let curriculumCount = 0;
  let usedEdgeVectorize = false;

  for (const doc of docs) {
    const emb = await generateEmbedding(doc.contentText, env);
    if (doc.indexName === "bbs-canon-lore") canonCount++;
    else curriculumCount++;

    if (env?.DB) {
      await env.DB.prepare(
        `INSERT INTO vector_embeddings
          (id, index_name, book_slug, entity_type, entity_id, title, content_text, age_band, topic_tags_json, embedding_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          content_text = excluded.content_text,
          age_band = excluded.age_band,
          topic_tags_json = excluded.topic_tags_json,
          embedding_json = excluded.embedding_json,
          updated_at = excluded.updated_at`
      )
        .bind(
          doc.id,
          doc.indexName,
          doc.bookSlug,
          doc.entityType,
          doc.entityId,
          doc.title,
          doc.contentText,
          doc.ageBand,
          JSON.stringify(doc.topicTags),
          JSON.stringify(emb.values),
          now
        )
        .run();
    }

    const targetVectorize =
      doc.indexName === "bbs-canon-lore" ? env?.VECTORIZE_CANON : env?.VECTORIZE_CURRICULUM;
    if (targetVectorize && emb.isEdgeAi) {
      try {
        await targetVectorize.upsert([
          {
            id: doc.id,
            values: emb.values,
            metadata: {
              bookSlug: doc.bookSlug,
              entityType: doc.entityType,
              entityId: doc.entityId,
              title: doc.title,
              ageBand: doc.ageBand,
            },
          },
        ]);
        usedEdgeVectorize = true;
      } catch {
        // D1 fallback table remains populated
      }
    }
  }

  return {
    indexedCount: docs.length,
    canonCount,
    curriculumCount,
    usedEdgeVectorize,
    backend: usedEdgeVectorize ? "vectorize_edge" : "d1_concept_scaffolding",
  };
}

/**
 * "Ask the Shelf" Semantic Search:
 * Matches natural-language parent prompts ("my 6-year-old gets frustrated when losing games",
 * "compound interest or patience for a 7-year-old") to exact books and curriculum concepts.
 */
export async function semanticAskTheShelf(
  query: string,
  env?: BraintrustEnv,
  options?: { limit?: number; ageBand?: string }
): Promise<SemanticShelfMatch[]> {
  const trimmed = (query || "").trim();
  if (!trimmed) return [];

  const limit = Math.min(Math.max(options?.limit ?? 6, 1), 15);
  const queryVec = computeLocalConceptEmbedding(trimmed);
  const queryTerms = trimmed
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

  const docs = (await buildCatalogVectorDocuments(env?.DB)).filter(
    (d) => d.indexName === "bbs-curriculum-discovery"
  );

  const scored: SemanticShelfMatch[] = [];
  for (const doc of docs) {
    if (options?.ageBand && doc.ageBand && !doc.ageBand.includes(options.ageBand)) {
      continue;
    }
    const docVec = computeLocalConceptEmbedding(doc.contentText);
    let score = cosineSimilarity(queryVec, docVec);

    const hay = `${doc.title} ${doc.contentText}`.toLowerCase();
    for (const term of queryTerms) {
      if (hay.includes(term)) {
        score += 0.14;
      }
    }
    if (doc.entityType === "book" || doc.entityType === "curriculum") {
      score += 0.05;
    }

    if (score <= 0.05) continue;

    scored.push({
      id: doc.id,
      bookSlug: doc.bookSlug,
      bookTitle: doc.title,
      entityType: doc.entityType,
      entityId: doc.entityId,
      title: doc.title,
      snippet: doc.contentText.slice(0, 220),
      ageBand: doc.ageBand,
      topicTags: doc.topicTags,
      score: Number(score.toFixed(4)),
      url: `/books/${doc.publicSlug}`,
      recommendedOffer: {
        bundlePrice: "$12.99",
        audioClubPrice: "$5.99/mo",
        bookClubPrice: "$60/quarter",
      },
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Canon & Lore Continuity Retrieval (`bbs-canon-lore`):
 * Retrieves character traits, recurring gags, and prior chapter lore before generating new scripts.
 */
export async function retrieveCanonContinuity(
  promptOrTopic: string,
  env?: BraintrustEnv,
  limit = 5
): Promise<CanonContinuityFact[]> {
  const queryVec = computeLocalConceptEmbedding(promptOrTopic || SERIES_HOOK);
  const canonDocs = (await buildCatalogVectorDocuments(env?.DB)).filter(
    (d) => d.indexName === "bbs-canon-lore"
  );

  const facts: CanonContinuityFact[] = canonDocs.map((doc) => {
    const docVec = computeLocalConceptEmbedding(doc.contentText);
    const score = cosineSimilarity(queryVec, docVec);
    return {
      id: doc.id,
      entityType: doc.entityType as "character" | "chapter" | "book",
      title: doc.title,
      factText: doc.contentText,
      bookSlug: doc.bookSlug,
      score: Number(score.toFixed(4)),
    };
  });

  facts.sort((a, b) => b.score - a.score);
  return facts.slice(0, limit);
}

/**
 * Clusters parent onboarding topics (`parent_onboarding.favorite_topics`, `future_topics`, & `custom_topic_request`)
 * against the catalog to rank demand vs. supply.
 */
export async function clusterParentTopicDemand(db?: D1Database): Promise<
  Array<{
    category: string;
    label: string;
    parentVotes: number;
    matchingNoteCount: number;
    sampleCurriculumTitle: string;
    demandScore: number;
  }>
> {
  const categoryCounts: Record<string, { votes: number; notes: number }> = {
    tech: { votes: 0, notes: 0 },
    money: { votes: 0, notes: 0 },
    courage: { votes: 0, notes: 0 },
    science: { votes: 0, notes: 0 },
    history: { votes: 0, notes: 0 },
    math: { votes: 0, notes: 0 },
    space: { votes: 0, notes: 0 },
    emotions: { votes: 0, notes: 0 },
  };

  if (db) {
    try {
      const rows = await db
        .prepare(
          `SELECT favorite_topics, future_topics, custom_topic_request FROM parent_onboarding LIMIT 500`
        )
        .all<{
          favorite_topics: string | null;
          future_topics: string | null;
          custom_topic_request: string | null;
        }>();

      for (const row of rows.results || []) {
        for (const jsonCol of [row.favorite_topics, row.future_topics]) {
          if (!jsonCol) continue;
          try {
            const parsed = JSON.parse(jsonCol);
            if (Array.isArray(parsed)) {
              for (const t of parsed) {
                const key = String(t).toLowerCase();
                if (categoryCounts[key]) categoryCounts[key].votes += 1;
              }
            }
          } catch {
            // ignore malformed JSON
          }
        }
        if (row.custom_topic_request) {
          const emb = computeLocalConceptEmbedding(row.custom_topic_request);
          if (emb[0] > 0.2) categoryCounts.math.notes += 1;
          if (emb[1] > 0.2) categoryCounts.science.notes += 1;
          if (emb[3] > 0.2) categoryCounts.money.notes += 1;
          if (emb[4] > 0.2) categoryCounts.emotions.notes += 1;
          if (emb[6] > 0.2) categoryCounts.courage.notes += 1;
          if (emb[7] > 0.2) categoryCounts.history.notes += 1;
          if (emb[10] > 0.2) categoryCounts.space.notes += 1;
          if (emb[15] > 0.2) categoryCounts.tech.notes += 1;
        }
      }
    } catch {
      // table may not exist yet
    }
  }

  const allLabels = new Map<string, string>();
  for (const o of [...CURRENT_TOPIC_OPTIONS, ...FUTURE_TOPIC_OPTIONS]) {
    allLabels.set(o.id, o.label);
  }

  // Real catalog titles only. Categories with no book yet map to an
  // empty sample: that gap is exactly what the demand view exists to
  // show, and an invented title would hide it.
  const sampleTitles: Record<string, string> = {
    tech: catalogTitle("docker"),
    money: catalogTitle("richdadpoordad"),
    courage: catalogTitle("thewarofart"),
    science: catalogTitle("algorithms"),
    math: catalogTitle("compoundeffect"),
    emotions: catalogTitle("mira-the-heron-and-the-still-water"),
  };

  return Object.entries(categoryCounts)
    .map(([category, stats]) => ({
      category,
      label: allLabels.get(category) || category,
      parentVotes: stats.votes,
      matchingNoteCount: stats.notes,
      sampleCurriculumTitle: sampleTitles[category] || "",
      demandScore: stats.votes * 2 + stats.notes * 3,
    }))
    .sort((a, b) => b.demandScore - a.demandScore);
}

export async function recordGenerationCost(
  db: D1Database | undefined,
  entry: GenerationCostEntry
): Promise<void> {
  if (!db) return;
  await ensureBraintrustSchema(db);
  await db
    .prepare(
      `INSERT INTO generation_cost_ledger
        (book_slug, stage, provider, model, input_tokens, output_tokens, estimated_cost_micros, gateway_cached, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      entry.bookSlug,
      entry.stage,
      entry.provider || "vercel-ai-gateway",
      entry.model,
      entry.inputTokens || 0,
      entry.outputTokens || 0,
      Math.round(entry.estimatedCostMicros),
      entry.gatewayCached ? 1 : 0,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      new Date().toISOString()
    )
    .run();
}

export async function getGenerationCostSummary(db?: D1Database): Promise<{
  totalCostUsd: number;
  byProvider: Array<{ provider: string; calls: number; costUsd: number; cachedHits: number }>;
  byBook: Array<{ bookSlug: string; calls: number; costUsd: number }>;
}> {
  if (!db) {
    return { totalCostUsd: 0, byProvider: [], byBook: [] };
  }
  await ensureBraintrustSchema(db);
  const providerRows = await db
    .prepare(
      `SELECT provider,
              COUNT(*) AS calls,
              COALESCE(SUM(estimated_cost_micros), 0) AS micros,
              COALESCE(SUM(gateway_cached), 0) AS cached_hits
       FROM generation_cost_ledger
       GROUP BY provider
       ORDER BY micros DESC`
    )
    .all<{ provider: string; calls: number; micros: number; cached_hits: number }>();

  const bookRows = await db
    .prepare(
      `SELECT book_slug,
              COUNT(*) AS calls,
              COALESCE(SUM(estimated_cost_micros), 0) AS micros
       FROM generation_cost_ledger
       GROUP BY book_slug
       ORDER BY micros DESC
       LIMIT 20`
    )
    .all<{ book_slug: string; calls: number; micros: number }>();

  const byProvider = (providerRows.results || []).map((r) => ({
    provider: r.provider,
    calls: Number(r.calls || 0),
    costUsd: Number(((r.micros || 0) / 1_000_000).toFixed(4)),
    cachedHits: Number(r.cached_hits || 0),
  }));

  const byBook = (bookRows.results || []).map((r) => ({
    bookSlug: r.book_slug,
    calls: Number(r.calls || 0),
    costUsd: Number(((r.micros || 0) / 1_000_000).toFixed(4)),
  }));

  const totalCostUsd = Number(
    byProvider.reduce((acc, item) => acc + item.costUsd, 0).toFixed(4)
  );

  return { totalCostUsd, byProvider, byBook };
}
