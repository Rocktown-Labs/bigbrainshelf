import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

const FACTORY = 'https://kidsbook-factory.rocktown-labs.workers.dev';

// Cast + ladder summary from a bible's data JSON, tolerant of both bible
// shapes: canonical (characters[], inline ladder fields) and generated
// (protagonist/supportingCast/newCharacters, metaphorBank).
function summarize(data: any) {
  const castRaw =
    Array.isArray(data?.characters) && data.characters.length
      ? data.characters
      : [data?.protagonist, ...(data?.supportingCast ?? []), ...(data?.newCharacters ?? [])].filter(Boolean);
  const cast = castRaw.map((c: any) => ({ name: c?.name ?? '', species: c?.species ?? '' })).filter((c: any) => c.name);
  const bank = new Map<string, string>(
    (data?.metaphorBank ?? []).map((m: any) => [String(m?.storyChapter ?? ''), String(m?.metaphor ?? '')])
  );
  const ladder = (data?.conceptLadder ?? []).map((e: any) => {
    const ch = String(e?.storyChapter ?? e?.chapter ?? '');
    return { ch, title: e?.title ?? '', metaphor: e?.metaphor || bank.get(ch) || '' };
  });
  return { cast, ladder, chapters: ladder.length };
}

async function gateFor(slug: string): Promise<{ ok: boolean; reasons: string[] } | null> {
  try {
    const r = await fetch(`${FACTORY}/book/${encodeURIComponent(slug)}/gate`, {
      method: 'POST',
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return { ok: !!j.ok, reasons: Array.isArray(j.reasons) ? j.reasons : [] };
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ url, locals }) => {
  const db = env.DB;
  const slug = url.searchParams.get('slug');
  if (slug) {
    const row: any = await db
      .prepare('SELECT id, book_slug, book_title, big_idea, setting, data FROM bibles WHERE book_slug = ? ORDER BY created_at DESC LIMIT 1')
      .bind(slug)
      .first();
    if (!row) return Response.json({ error: 'no bible for slug' }, { status: 404 });
    return Response.json(row);
  }
  const { results } = await db
    .prepare('SELECT id, book_slug, book_title, big_idea, setting, data FROM bibles')
    .all();
  const out = await Promise.all(
    (results as any[]).map(async (r) => {
      let data: any = null;
      try { data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data; } catch { /* summary stays empty */ }
      const { data: _omit, ...meta } = r;
      return { ...meta, summary: summarize(data), gate: r.book_slug ? await gateFor(r.book_slug) : null };
    })
  );
  return Response.json(out);
};

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await request.json();
  const db = env.DB;
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.prepare(
    'INSERT INTO bibles (id, book_slug, book_title, big_idea, setting, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, body.bookSlug, body.bookTitle, body.bigIdea, body.setting, JSON.stringify(body.data), now, now).run();
  return Response.json({ id });
};
