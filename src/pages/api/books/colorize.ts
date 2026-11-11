import type { APIRoute } from 'astro';
import { env } from "cloudflare:workers";

const FACTORY = 'https://kidsbook-factory.rocktown-labs.workers.dev';

// Start the factory's Colorize process for a finished book: it colors
// the book's own line pages into a separate full-color edition PDF.
// The base book is never touched.
export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const slug = String(body?.slug ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return Response.json({ error: 'a valid book slug is required' }, { status: 400 });
  }
  // A published book's frozen release is never casually
  // re-colorized (CG, 2026-11-11): the admin buttons disable
  // themselves, and this guard enforces the same rule for any
  // caller. Fails closed: if the publish state cannot be read,
  // colorize does not start.
  try {
    const release = await (env as any).DB.prepare('SELECT id FROM publish_releases WHERE book_slug = ? LIMIT 1').bind(slug).first();
    if (release) {
      return Response.json({ ok: false, error: 'This book is published. Colorize is off for published books.' }, { status: 409 });
    }
  } catch {
    return Response.json({ ok: false, error: 'Publish state could not be verified, so colorize was not started.' }, { status: 503 });
  }
  try {
    const res = await fetch(`${FACTORY}/book/${encodeURIComponent(slug)}/colorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: !!body?.force }),
    });
    const data = await res.json().catch(() => ({}));
    return Response.json(data, { status: res.status });
  } catch (e: any) {
    return Response.json({ error: `factory unreachable: ${e?.message ?? e}` }, { status: 502 });
  }
};
