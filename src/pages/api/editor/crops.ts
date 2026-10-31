import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import {
  getCropsManifest, saveCropsManifest, cropImagePng, makeTag,
  nextPoseNumber, actionSlug, type CropEntry,
} from '../../../lib/crops';
import { nameKey } from '../../../lib/character-sheets';

// Pose crops (Crop Mode). Admin-gated by the middleware like every
// /api/editor route. The factory reads the manifest + crop files this
// route writes (books/{slug}/crops.json, books/{slug}/crops/{tag}.png)
// and conditions page generation on single-pose crops instead of the
// full multi-pose sheets.
//
// GET    /api/editor/crops?slug= -> { characters, crops, coverage }
// POST   /api/editor/crops { slug, character, action, bbox }
//        -> crops the region server-side from the character's sheet,
//           stores the PNG, appends the manifest entry
// DELETE /api/editor/crops { slug, tag } -> removes crop + entry

import { adminMediaUrl } from '../../../lib/media';

function badSlug(slug: string) {
  return !/^[A-Za-z0-9_-]+$/.test(slug);
}

interface BookCharacter {
  name: string;
  species: string;
  sheetKey: string | null;
  sheetKind: "color" | "line" | null;
}

async function bookCharacters(e: any, slug: string): Promise<BookCharacter[]> {
  // The book's cast comes from its bible in R2 (canonical characters[],
  // with the generated-shape fallback folded in).
  let chars: any[] = [];
  try {
    const obj = await e.BOOKS.get(`books/${slug}/bible.json`);
    if (obj) {
      const bible = JSON.parse(await obj.text());
      if (Array.isArray(bible?.characters) && bible.characters.length) {
        chars = bible.characters;
      } else {
        if (bible?.protagonist) chars.push(bible.protagonist);
        if (Array.isArray(bible?.supportingCast)) chars.push(...bible.supportingCast);
      }
    }
  } catch { /* no bible readable: empty cast */ }
  const out: BookCharacter[] = [];
  for (const c of chars) {
    const name = String(c?.name ?? "").trim();
    if (!name) continue;
    const nk = nameKey(name);
    let sheetKey: string | null = null;
    let sheetKind: "color" | "line" | null = null;
    try {
      const row: any = await e.DB.prepare(
        "SELECT jpg_key, line_jpg_key FROM characters WHERE book_slug=? AND lower(name)=lower(?)"
      ).bind(slug, name).first();
      if (row?.jpg_key && (await e.BOOKS.head(String(row.jpg_key)))) {
        sheetKey = String(row.jpg_key); sheetKind = "color";
      } else if (row?.line_jpg_key && (await e.BOOKS.head(String(row.line_jpg_key)))) {
        sheetKey = String(row.line_jpg_key); sheetKind = "line";
      }
    } catch { /* registry unavailable: legacy key below */ }
    if (!sheetKey) {
      const legacy = `library/characters/${slug}/${nk}-sheet.jpg`;
      if (await e.BOOKS.head(legacy)) { sheetKey = legacy; sheetKind = "color"; }
    }
    out.push({ name, species: String(c?.species ?? ""), sheetKey, sheetKind });
  }
  return out;
}

function publicEntry(c: CropEntry) {
  return { ...c, url: adminMediaUrl(c.key) };
}

export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const slug = (url.searchParams.get('slug') || '').trim();
  if (!slug || badSlug(slug)) {
    return Response.json({ error: 'slug required' }, { status: 400 });
  }
  const characters = await bookCharacters(e, slug);
  const crops = await getCropsManifest(e.BOOKS, slug);
  const tagged = new Set(crops.map((c) => c.character.toLowerCase()));
  return Response.json({
    slug,
    characters: characters.map((c) => ({
      ...c,
      sheetUrl: c.sheetKey ? adminMediaUrl(c.sheetKey) : null,
      tagged: tagged.has(c.name.toLowerCase()),
    })),
    crops: crops.map(publicEntry),
    coverage: {
      total: characters.length,
      tagged: characters.filter((c) => tagged.has(c.name.toLowerCase())).length,
      untagged: characters.filter((c) => !tagged.has(c.name.toLowerCase())).map((c) => c.name),
    },
  });
};

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const b = await request.json().catch(() => ({}));
  const slug = String(b.slug || '').trim();
  const character = String(b.character || '').trim();
  const action = actionSlug(String(b.action || ''));
  const bbox = b.bbox;
  if (!slug || badSlug(slug)) return Response.json({ error: 'slug required' }, { status: 400 });
  if (!character) return Response.json({ error: 'character required' }, { status: 400 });
  if (!action) return Response.json({ error: 'an action is required (e.g. standing, flying, megaphone)' }, { status: 400 });
  if (
    !bbox || ![bbox.x, bbox.y, bbox.w, bbox.h].every((v: any) => typeof v === 'number' && Number.isFinite(v)) ||
    bbox.w <= 0 || bbox.h <= 0
  ) {
    return Response.json({ error: 'bbox {x, y, w, h} as fractions is required' }, { status: 400 });
  }

  const characters = await bookCharacters(e, slug);
  const ch = characters.find((c) => c.name.toLowerCase() === character.toLowerCase());
  if (!ch) return Response.json({ error: `no character '${character}' in this book's bible` }, { status: 404 });
  if (!ch.sheetKey) return Response.json({ error: `no sheet on file for ${ch.name}; approve a sheet first` }, { status: 409 });

  const obj = await e.BOOKS.get(ch.sheetKey);
  if (!obj) return Response.json({ error: 'sheet bytes missing in R2' }, { status: 404 });
  const sheetBytes = new Uint8Array(await obj.arrayBuffer());

  let cropped;
  try {
    cropped = cropImagePng(sheetBytes, bbox);
  } catch (err: any) {
    return Response.json({ error: `crop failed: ${String(err?.message || err)}` }, { status: 422 });
  }

  const crops = await getCropsManifest(e.BOOKS, slug);
  const poseNum = nextPoseNumber(crops, ch.name);
  const tag = makeTag(ch.name, poseNum, action);
  if (crops.some((c) => c.tag === tag)) {
    return Response.json({ error: `tag ${tag} already exists; delete it first or use another action` }, { status: 409 });
  }
  const key = `books/${slug}/crops/${tag}.png`;
  await e.BOOKS.put(key, cropped.png, { httpMetadata: { contentType: 'image/png' } });
  const entry: CropEntry = {
    tag,
    character: ch.name,
    action,
    source: 'sheet',
    bbox: { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h },
    createdAt: Math.floor(Date.now() / 1000),
    key,
    sheetKey: ch.sheetKey,
  };
  crops.push(entry);
  await saveCropsManifest(e.BOOKS, slug, crops);
  return Response.json({ ok: true, crop: publicEntry(entry), px: cropped.px, sheetSize: cropped.sheetSize });
};

export const DELETE: APIRoute = async ({ request }) => {
  const e = env as any;
  const b = await request.json().catch(() => ({}));
  const slug = String(b.slug || '').trim();
  const tag = String(b.tag || '').trim().toLowerCase();
  if (!slug || badSlug(slug) || !tag) {
    return Response.json({ error: 'slug and tag required' }, { status: 400 });
  }
  const crops = await getCropsManifest(e.BOOKS, slug);
  const entry = crops.find((c) => c.tag === tag);
  if (!entry) return Response.json({ error: `no crop tagged ${tag}` }, { status: 404 });
  await e.BOOKS.delete(entry.key);
  await saveCropsManifest(e.BOOKS, slug, crops.filter((c) => c.tag !== tag));
  return Response.json({ ok: true, deleted: tag });
};
