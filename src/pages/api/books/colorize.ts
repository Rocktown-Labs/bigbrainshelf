import type { APIRoute } from 'astro';

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
