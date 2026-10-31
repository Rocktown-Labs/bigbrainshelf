import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";

// GET /api/settings -> { factory_url }
export const GET: APIRoute = async () => {
  const db = (env as any).DB;
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'factory_url'").first();
  return Response.json({ factory_url: row?.value || "" });
};

// POST /api/settings { factory_url } -> save
export const POST: APIRoute = async ({ request }) => {
  const db = (env as any).DB;
  const body = await request.json().catch(() => ({}));
  const url = String(body.factory_url || "").trim().replace(/\/+$/, "");
  await db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('factory_url', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(url, Date.now()).run();
  return Response.json({ factory_url: url });
};
