import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
  const db = env.DB;
  const { results } = await db.prepare('SELECT * FROM characters').all();
  return Response.json(results);
};
