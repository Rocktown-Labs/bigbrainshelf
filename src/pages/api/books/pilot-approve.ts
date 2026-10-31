import type { APIRoute } from 'astro';

const FACTORY = 'https://kidsbook-factory.rocktown-labs.workers.dev';

// Release a build parked at the chapter-1 pilot gate: the factory
// drew chapter 1 as a sample and is waiting at stage
// awaiting_pilot_approval. Approving tells it to build the rest.
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
    const res = await fetch(`${FACTORY}/book/${encodeURIComponent(slug)}/pilot-approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    return Response.json(data, { status: res.status });
  } catch (e: any) {
    return Response.json({ error: `factory unreachable: ${e?.message ?? e}` }, { status: 502 });
  }
};
