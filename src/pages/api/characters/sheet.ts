import type { APIRoute } from 'astro';

const FACTORY = 'https://kidsbook-factory.rocktown-labs.workers.dev';

// Character studio proxy: generate a pending character sheet in the
// factory (gateway-drawn from the visual text, verbatim). Nothing uses
// the sheet until it is approved via /api/characters/approve-sheet.
export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const slug = String(body?.slug ?? '').trim();
  const name = String(body?.name ?? '').trim();
  const visual = String(body?.visual ?? '').trim();
  const kind = body?.kind === 'line' ? 'line' : 'color';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || !name || !visual) {
    return Response.json({ error: 'slug, name and visual are required' }, { status: 400 });
  }
  try {
    const res = await fetch(`${FACTORY}/book/${encodeURIComponent(slug)}/character-sheet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, visual, kind }),
    });
    const data = await res.json().catch(() => ({}));
    return Response.json(data, { status: res.status });
  } catch (e: any) {
    return Response.json({ error: `factory unreachable: ${e?.message ?? e}` }, { status: 502 });
  }
};
