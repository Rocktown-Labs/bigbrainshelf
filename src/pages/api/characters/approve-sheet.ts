import type { APIRoute } from 'astro';

const FACTORY = 'https://kidsbook-factory.rocktown-labs.workers.dev';

// Character studio proxy: approve a pending sheet. The factory copies
// it to the canonical key and upserts the characters registry row the
// build pipeline reads its reference sheets from.
export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const slug = String(body?.slug ?? '').trim();
  const name = String(body?.name ?? '').trim();
  const kind = body?.kind === 'line' ? 'line' : 'color';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || !name) {
    return Response.json({ error: 'slug and name are required' }, { status: 400 });
  }
  try {
    const res = await fetch(`${FACTORY}/book/${encodeURIComponent(slug)}/character-sheet/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, kind }),
    });
    const data = await res.json().catch(() => ({}));
    return Response.json(data, { status: res.status });
  } catch (e: any) {
    return Response.json({ error: `factory unreachable: ${e?.message ?? e}` }, { status: 502 });
  }
};
