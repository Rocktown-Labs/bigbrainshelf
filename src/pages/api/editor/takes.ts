import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import {
  getBookVersions, listPageTakes, applyPageTake, applyBookVersion, getPdfStaleness,
} from '../../../lib/takes';

// Page takes over the factory archive (books/{slug}/archive/v{n}/ +
// versions.json). Admin-gated by the middleware like every /api/editor
// route.
//
// Safety contract (src/lib/takes.ts): every apply snapshots the live
// files it is about to overwrite into a new "takes" archive version
// BEFORE copying. A snapshot failure throws, the apply aborts, and
// this route answers 500 with the reason — nothing was overwritten.
//
// GET  /api/editor/takes?slug=                     -> { versions, picks, pdfStale }
// GET  /api/editor/takes?slug=&chapterNum=&pageIndex= -> { liveKey, liveSize, takes }
// POST /api/editor/takes { slug, chapterNum, pageIndex, version }
//      -> apply one page's take (snapshot first, copies bytes over the
//         live key plus the version's color twin when present, clears
//         the page's approval, records the pick)
// POST /api/editor/takes { slug, version, wholeBook: true }
//      -> apply a whole-book version across every page in the snapshot

import { adminMediaUrl } from '../../../lib/media';

function badSlug(slug: string) {
  return !/^[A-Za-z0-9_-]+$/.test(slug);
}

export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const slug = (url.searchParams.get('slug') || '').trim();
  if (!slug || badSlug(slug)) {
    return Response.json({ error: 'slug required' }, { status: 400 });
  }
  const chapterNum = parseInt(url.searchParams.get('chapterNum') || '', 10);
  const pageIndex = parseInt(url.searchParams.get('pageIndex') || '', 10);

  if (Number.isInteger(chapterNum) && chapterNum >= 1 && Number.isInteger(pageIndex) && pageIndex >= 0) {
    const r = await listPageTakes(e.BOOKS, slug, chapterNum, pageIndex);
    return Response.json(r);
  }

  const versions = await getBookVersions(e.BOOKS, slug);
  let picks: any[] = [];
  try {
    const { results } = await e.DB.prepare(
      `SELECT chapter_num, page_index, version, applied_at, twin_applied, twin_note FROM page_takes
       WHERE book_slug = ? ORDER BY id DESC LIMIT 500`
    ).bind(slug).all();
    picks = (results || []).map((r: any) => ({
      chapterNum: r.chapter_num, pageIndex: r.page_index,
      version: r.version, appliedAt: r.applied_at,
      twinApplied: r.twin_applied === 1 || r.twin_applied === true,
      twinNote: r.twin_note ?? null,
    }));
  } catch {
    try {
      const { results } = await e.DB.prepare(
        `SELECT chapter_num, page_index, version, applied_at FROM page_takes
         WHERE book_slug = ? ORDER BY id DESC LIMIT 500`
      ).bind(slug).all();
      picks = (results || []).map((r: any) => ({
        chapterNum: r.chapter_num, pageIndex: r.page_index,
        version: r.version, appliedAt: r.applied_at,
        twinApplied: false, twinNote: null,
      }));
    } catch { picks = []; }
  }
  const pdfStale = await getPdfStaleness(e.BOOKS, e.DB, slug).catch(() => null);
  return Response.json({ versions, picks, pdfStale });
};

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const b = await request.json().catch(() => ({}));
  const slug = String(b.slug || '').trim();
  const version = parseInt(b.version, 10);
  if (!slug || badSlug(slug) || !Number.isInteger(version) || version < 1) {
    return Response.json({ error: 'slug and integer version required' }, { status: 400 });
  }

  if (b.wholeBook === true) {
    const versions = await getBookVersions(e.BOOKS, slug);
    if (!versions.some((v) => v.version === version)) {
      return Response.json({ error: `version ${version} not in the archive manifest` }, { status: 404 });
    }
    let summary;
    try {
      summary = await applyBookVersion(e.BOOKS, e.DB, slug, version);
    } catch (err: any) {
      // Snapshot-before-apply aborted (or a copy failed mid-load): the
      // pre-load snapshot, when one was created, is itself a take.
      return Response.json(
        { error: `Loading v${version} was stopped: ${String(err?.message || err)}` },
        { status: 500 },
      );
    }
    if (summary.applied === 0) {
      return Response.json({ error: 'no pages in that version could be applied', ...summary }, { status: 404 });
    }
    return Response.json({ ok: true, ...summary });
  }

  const chapterNum = parseInt(b.chapterNum, 10);
  const pageIndex = parseInt(b.pageIndex, 10);
  if (!(chapterNum >= 1) || !(pageIndex >= 0)) {
    return Response.json({ error: 'chapterNum and pageIndex required' }, { status: 400 });
  }
  let r;
  try {
    r = await applyPageTake(e.BOOKS, e.DB, slug, chapterNum, pageIndex, version);
  } catch (err: any) {
    return Response.json(
      { error: `Applying that take was stopped: ${String(err?.message || err)}` },
      { status: 500 },
    );
  }
  if (!r) {
    return Response.json({ error: `no take of v${version} exists for this page` }, { status: 404 });
  }
  return Response.json({
    ok: true,
    image: `${adminMediaUrl(r.liveKey)}&v=${Date.now()}`,
    liveKey: r.liveKey,
    size: r.size,
    twinApplied: r.twinApplied,
    twinNote: r.twinNote,
    snapshotVersion: r.snapshotVersion,
  });
};
