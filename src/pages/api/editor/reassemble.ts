import type { APIRoute } from 'astro';

const FACTORY = 'https://kidsbook-factory.rocktown-labs.workers.dev';

// Ask the factory to reassemble a book's PDFs from its current pages
// (the ReassembleWorkflow: never generates art, so this is free and
// safe to offer from the QC viewer when page marks stop saving
// because the assembled PDFs no longer match the pages on screen).
// The factory refuses books whose back-cover art is missing rather
// than generating it here; that refusal is relayed as-is.
// Admin tier by default under the route policy, like every other
// /api/editor route.
export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const slug = String(body?.book_slug ?? body?.slug ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return Response.json({ error: 'a valid book slug is required' }, { status: 400 });
  }
  try {
    const res = await fetch(`${FACTORY}/book/${slug}/reassemble`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    return Response.json(data, { status: res.status });
  } catch (e: any) {
    return Response.json({ error: `factory unreachable: ${e?.message ?? e}` }, { status: 502 });
  }
};
