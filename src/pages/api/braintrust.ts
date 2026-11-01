import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  semanticAskTheShelf,
  retrieveCanonContinuity,
  indexCatalogVectors,
  clusterParentTopicDemand,
  getGenerationCostSummary,
  recordGenerationCost,
  detectBraintrustBackend,
} from "../../lib/braintrust";
import { getEffectiveSession } from "../../lib/auth";

export const prerender = false;

/**
 * GET /api/braintrust?q=...&mode=ask|canon|demand|cogs
 * - Publicly supports `mode=ask` ("Ask the Shelf" natural-language parent discovery)
 *   and `mode=canon` (Canon & Lore continuity facts).
 * - Reports `backend: "vectorize_edge" | "d1_concept_scaffolding"` honestly.
 */
export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const mode = (url.searchParams.get("mode") || "ask").toLowerCase();
  const q = (url.searchParams.get("q") || "").trim();
  const ageBand = url.searchParams.get("ageBand") || undefined;
  const backend = detectBraintrustBackend(e);

  if (mode === "canon") {
    const facts = await retrieveCanonContinuity(q || "Fern Pip Bramble Whispering Woods", e, 6);
    return Response.json({ ok: true, mode: "canon", backend, query: q, facts });
  }

  if (mode === "demand") {
    const demand = await clusterParentTopicDemand(e.DB);
    return Response.json({ ok: true, mode: "demand", backend, demand });
  }

  if (mode === "cogs") {
    const cogs = await getGenerationCostSummary(e.DB);
    return Response.json({ ok: true, mode: "cogs", backend, cogs });
  }

  const matches = await semanticAskTheShelf(
    q || "patterns in nature and patience for a 6 year old",
    e,
    { limit: 6, ageBand }
  );
  return Response.json({ ok: true, mode: "ask", backend, query: q, matches });
};

/**
 * POST /api/braintrust
 * Admin-authenticated indexing (`action: "index"`) or AI generation COGS logging (`action: "log_cost"`).
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const session = await getEffectiveSession(request, locals, e.DB);
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, any>;
  const action = String(body.action || "index");

  if (action === "log_cost") {
    await recordGenerationCost(e.DB, {
      bookSlug: String(body.bookSlug || "fern-counts-the-forest"),
      stage: body.stage || "story_text",
      provider: body.provider || "vercel-ai-gateway",
      model: String(body.model || "google/gemini-2.5-pro"),
      inputTokens: Number(body.inputTokens || 0),
      outputTokens: Number(body.outputTokens || 0),
      estimatedCostMicros: Number(body.estimatedCostMicros || 0),
      gatewayCached: Boolean(body.gatewayCached),
      metadata: body.metadata,
    });
    const summary = await getGenerationCostSummary(e.DB);
    return Response.json({ ok: true, summary });
  }

  const result = await indexCatalogVectors(e);
  return Response.json({ ok: true, ...result });
};
