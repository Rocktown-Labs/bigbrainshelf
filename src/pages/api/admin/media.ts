import { createHash } from 'node:crypto';
import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { isSafeMediaKey, serveR2Object } from "../../../lib/media";

// Admin media gateway. GET|HEAD /api/admin/media?key=<bucket key>
//
// Every admin surface that used to hand the browser a public r2.dev
// URL (Story Review pages, editor takes/crops, cast gallery editor,
// versions.json, book videos) now points here instead. The middleware
// gates /api/* behind the admin session and the locals.user check is
// defense in depth, the same pattern as the other admin APIs. Any
// bucket key may be served to the signed-in admin (traversal-proofed
// by isSafeMediaKey); nothing here is reachable anonymously. Range
// streaming (206/416) comes from serveR2Object in lib/media.ts.

async function handle({ request, url, locals }: any) {
  if (!(locals as any)?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const e = env as any;
  const key = String(url.searchParams.get("key") || "");
  if (!isSafeMediaKey(key)) {
    return Response.json({ error: "Bad key" }, { status: 400 });
  }
  const expected = url.searchParams.get('sha256');
  if (expected !== null) {
    if (!/^[a-f0-9]{64}$/.test(expected)) return Response.json({ error: 'Bad artifact identity' }, { status: 400 });
    const obj = await e.BOOKS.get(key);
    if (!obj) return Response.json({ error: 'Reviewed artifact is missing. Reload the book.' }, { status: 409 });
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      return Response.json({ error: 'Reviewed artifact changed. Reload the book.' }, { status: 409 });
    return new Response(request.method === 'HEAD' ? null : bytes, { headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store',
    } });
  }
  return serveR2Object({
    books: e.BOOKS,
    key,
    method: request.method,
    rangeHeader: request.headers.get("Range"),
  });
}

export const GET: APIRoute = handle;
export const HEAD: APIRoute = handle;
