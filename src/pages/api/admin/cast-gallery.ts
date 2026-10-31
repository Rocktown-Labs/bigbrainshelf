import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import {
  loadCastGallery, saveCharacterGallery, restoreCharacterGallery,
  latestBackup, validBoxes, versioned, normalizePoseMeta, mirrorGalleryTags,
  listPoseHistory, restorePoseVersion,
  type GalleryEntry, type PoseEditPayload,
} from '../../../lib/cast-gallery';
import { decodePngBase64 } from '../../../lib/lift-jobs';
import { adminMediaUrl } from '../../../lib/media';
import { ACTION_SUGGESTIONS } from '../../../lib/crops';

// Meet the Cast gallery crop editor. Admin-gated by the middleware
// like every non-allowlisted /api route.
//
// GET  /api/admin/cast-gallery            -> { characters: [...] }
// GET  /api/admin/cast-gallery?slug=juno  -> { character: {...}, backup }
// POST /api/admin/cast-gallery { slug, boxes, portraitIndex,
//        poseMeta?, keepOrder? }
//      -> back up the current gallery, re-crop every pose from the
//         sheet server-side, bump the manifest version (public pages
//         pick it up runtime-side). Without keepOrder the poses are
//         renumbered in reading order (original behavior); with it the
//         editor's explicit pose order is kept. poseMeta carries each
//         pose's action tag + focal point; tagged poses are mirrored
//         into the home book's factory crops manifest.
// POST /api/admin/cast-gallery { slug, restore: true }
//      -> restore the newest backup wholesale
// GET  /api/admin/cast-gallery?slug=X&history=1&poseIndex=N
//      -> { versions: [...] } recent saved versions of one pose slot
// POST /api/admin/cast-gallery { slug, restorePose: { poseIndex, ts } }
//      -> roll that one pose back to a chosen backup version; the
//         current gallery is snapshotted first, so it can be undone

function badSlug(slug: string) {
  return !/^[a-z0-9-]+$/.test(slug);
}

function publicEntry(slug: string, entry: GalleryEntry) {
  return {
    slug,
    name: entry.name,
    bookSlug: entry.bookSlug,
    sheetKey: entry.sheetKey,
    sheetUrl: entry.sheetKey ? adminMediaUrl(entry.sheetKey) : null,
    sheetSize: entry.sheetSize || null,
    boxes: entry.boxes || [],
    portraitIndex: entry.portraitIndex ?? 0,
    poseMeta: normalizePoseMeta(entry.poseMeta, entry.poseCount || 0),
    poseCount: entry.poseCount || 0,
    portrait: versioned(adminMediaUrl(entry.portrait) || entry.portrait, entry.v),
    poses: (entry.poses || []).map((u) => versioned(adminMediaUrl(u) || u, entry.v)),
    v: entry.v || 1,
  };
}

export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const manifest = await loadCastGallery(e.BOOKS);
  const slug = (url.searchParams.get('slug') || '').trim();
  if (!slug) {
    const characters = Object.entries(manifest.characters)
      .map(([s, entry]) => ({
        slug: s,
        name: entry.name,
        bookSlug: entry.bookSlug,
        poseCount: entry.poseCount || 0,
        hasBoxes: Array.isArray(entry.boxes) && entry.boxes.length > 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return Response.json({ characters });
  }
  if (badSlug(slug)) return Response.json({ error: 'bad slug' }, { status: 400 });
  const entry = manifest.characters[slug];
  if (!entry) return Response.json({ error: `no gallery entry for '${slug}'` }, { status: 404 });
  if (url.searchParams.get('history') === '1') {
    const poseIndex = Number(url.searchParams.get('poseIndex'));
    if (!Number.isInteger(poseIndex) || poseIndex < 0) {
      return Response.json({ error: 'poseIndex required' }, { status: 400 });
    }
    try {
      // The history panel shows the newest few; the editor's Undo
      // lift scan asks for more so it can find the newest version
      // whose pose was not lifted, however many saves came after.
      const rawLimit = Number(url.searchParams.get('limit'));
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(50, rawLimit) : 6;
      const versions = await listPoseHistory(e.BOOKS, slug, poseIndex, limit);
      return Response.json({ versions });
    } catch (err: any) {
      return Response.json({ error: String(err?.message || err) }, { status: 422 });
    }
  }
  const backupTs = await latestBackup(e.BOOKS, slug);
  return Response.json({
    character: publicEntry(slug, entry),
    backup: backupTs ? { ts: backupTs } : null,
    actions: ACTION_SUGGESTIONS,
  });
};

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const b = await request.json().catch(() => ({}));
  const slug = String(b.slug || '').trim();
  if (!slug || badSlug(slug)) return Response.json({ error: 'slug required' }, { status: 400 });

  try {
    if (b.restore === true) {
      const { entry, backupTs } = await restoreCharacterGallery(e.BOOKS, slug);
      const backup = await latestBackup(e.BOOKS, slug);
      return Response.json({
        ok: true,
        restoredFrom: backupTs,
        character: publicEntry(slug, entry),
        backup: backup ? { ts: backup } : null,
      });
    }

    if (b.restorePose && typeof b.restorePose === 'object') {
      const poseIndex = Number(b.restorePose.poseIndex);
      const ts = Number(b.restorePose.ts);
      if (!Number.isInteger(poseIndex) || poseIndex < 0 || !Number.isInteger(ts) || ts <= 0) {
        return Response.json({ error: 'restorePose needs a poseIndex and a backup timestamp' }, { status: 400 });
      }
      const { entry, restoredFrom, snapshotTs } = await restorePoseVersion(e.BOOKS, slug, poseIndex, ts);
      const backup = snapshotTs ?? (await latestBackup(e.BOOKS, slug));
      return Response.json({
        ok: true,
        restoredFrom,
        snapshotTs,
        character: publicEntry(slug, entry),
        backup: backup ? { ts: backup } : null,
      });
    }

    const boxes = validBoxes(b.boxes);
    if (!boxes) {
      return Response.json(
        { error: 'boxes must be 1-12 regions {x, y, w, h} as fractions, each at least 0.01 wide/tall' },
        { status: 400 }
      );
    }
    const portraitIndex = Number.isInteger(b.portraitIndex)
      ? Math.max(0, Math.min(boxes.length - 1, b.portraitIndex))
      : 0;
    // Erase edits arrive as base64 PNGs keyed by pose index. A bad
    // payload is a client bug; refuse the whole save rather than
    // silently dropping someone's painting.
    let poseEdits: PoseEditPayload[] | undefined;
    if (b.poseEdits !== undefined) {
      if (!Array.isArray(b.poseEdits)) {
        return Response.json({ error: 'poseEdits must be an array' }, { status: 400 });
      }
      poseEdits = [];
      for (const raw of b.poseEdits) {
        const index = Number(raw?.index);
        const png = decodePngBase64(raw?.pngBase64);
        if (!Number.isInteger(index) || index < 0 || index >= boxes.length || !png) {
          return Response.json(
            { error: 'each pose edit needs a valid pose index and a base64 PNG (<=10MB)' },
            { status: 400 }
          );
        }
        poseEdits.push({ index, png, eraseInfo: raw?.eraseInfo, shape: raw?.shape === true });
      }
    }
    const { entry, backupTs } = await saveCharacterGallery(
      e.BOOKS,
      slug,
      boxes,
      portraitIndex,
      { poseMeta: b.poseMeta, keepOrder: b.keepOrder === true, poseEdits }
    );
    // Tagged poses feed the factory's crop conditioning. A mirror
    // failure never fails the gallery save; it is reported instead.
    let mirror = null;
    let mirrorError = null;
    try {
      mirror = await mirrorGalleryTags(e.BOOKS, slug, entry);
    } catch (err: any) {
      mirrorError = String(err?.message || err);
    }
    return Response.json({
      ok: true,
      backupTs,
      character: publicEntry(slug, entry),
      backup: { ts: backupTs },
      mirror,
      mirrorError,
    });
  } catch (err: any) {
    return Response.json({ error: String(err?.message || err) }, { status: 422 });
  }
};
