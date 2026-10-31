import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ url, locals }) => {
  const db = env.DB;
  const bookId = url.searchParams.get('bookId');
  let query = 'SELECT * FROM chapters';
  if (bookId) query += ` WHERE book_id = '${bookId}'`;
  query += ' ORDER BY story_chapter';
  const { results } = await db.prepare(query).all();
  return Response.json(results);
};
