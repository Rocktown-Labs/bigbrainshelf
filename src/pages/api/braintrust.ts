import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  clusterParentTopicDemand,
  getGenerationCostSummary,
  indexCatalogVectors,
  retrieveCanonContinuity,
  semanticAskTheShelf,
} from "../../lib/braintrust";

export const prerender = false;

// GET /api/braintrust?q=...&mode=ask|canon|demand|cogs
export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const db = e.DB;
  const mode = (url.searchParams.get("mode") || "ask").toLowerCase();
  const q = (url.searchParams.get("q") || "").slice(0, 200).trim();
  const bookSlug = url.searchParams.get("book_slug") || undefined;

  if (mode === "demand") {
    const demand = await clusterParentTopicDemand(db);
    return Response.json({ ok: true, demand });
  }

  if (mode === "cogs") {
    const cogs = await getGenerationCostSummary(db);
    return Response.json({ ok: true, cogs });
  }

  if (mode === "canon") {
    const canon = await retrieveCanonContinuity(db, e, q || "patience and mastery", bookSlug);
    return Response.json({ ok: true, query: q, ...canon });
  }

  if (!q) {
    return Response.json({ ok: true, query: "", matches: [] });
  }

  const matches = await semanticAskTheShelf(db, e, q, {
    namespace: "curriculum",
    limit: 6,
  });
  return Response.json({ ok: true, query: q, matches });
};

// POST /api/braintrust { action: "reindex" }
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const db = e.DB;
  const body: any = await request.json().catch(() => ({}));
  const action = String(body?.action || "reindex");

  if (action === "reindex") {
    const stats = await indexCatalogVectors(db, e);
    return Response.json({ ok: true, ...stats });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
