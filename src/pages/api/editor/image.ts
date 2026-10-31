import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

// GET /api/editor/image?key=docker/S1-page-0.jpg -> proxies the R2 image
// same-origin so canvas PNG export is never CORS-tainted. Reads the
// BOOKS binding directly (the bucket's public r2.dev domain is
// disabled). Admin-gated by the middleware like every /api/editor
// route.
export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const key = url.searchParams.get('key') || '';
  if (!/^[A-Za-z0-9/_.-]+\.jpg$/.test(key) || key.includes('..')) {
    return new Response('Bad key', { status: 400 });
  }
  const obj = await e.BOOKS.get(key).catch(() => null);
  if (!obj) return new Response('Image not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
};
