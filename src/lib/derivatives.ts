// Right-sized WebP derivatives for the heaviest public imagery.
//
// The zone is on the Free plan, where Cloudflare Image Transformations
// and Polish are not available (image_resizing is plan-gated), so the
// store serves locally generated derivatives from R2 instead: same art,
// resized to display size and re-encoded as WebP (the cast PNGs are
// photographic content stored as PNG at ~230KB for a 330px image; the
// WebP twin is ~11KB). Originals stay in place and are still used for
// lightbox / detail / download paths.
//
// The map (src/data/image-derivatives.json, mirrored to R2 as
// image-derivatives.json) is produced by
// ~/workspace/factory-ops/image-derivatives/gen_derivatives.py. Cast
// entries are stamped with the gallery version `v` they were generated
// from and are IGNORED the moment the editor bumps that version, so a
// crop edit can never be masked by a stale derivative: pages fall back
// to the original art until derivatives are regenerated. Cover entries
// are keyed by book slug; regenerating derivatives after a cover swap
// is part of the same script run. The guard that the run happened:
// factory-ops/image-derivatives/audit_derivatives.py compares this
// map against live R2 cover bytes and fails loud on any drift (the
// Nov 2026 rename pass replaced three covers, skipped the regen, and
// stale sizes pinned the retired art until it was caught by eye).

import baked from "../data/image-derivatives.json";
// Derivative URLs are served from the hotlink-guarded media host
// (media.bigbrainshelf.com, the bbs-media worker): foreign-referer
// embeds get the JUST BUY IT deterrent card instead of the art.
// Original display files (cast poses, covers) are served from the
// media host too; the bucket's r2.dev domain is disabled.
import { MEDIA_PUBLIC } from "./media";
export { MEDIA_PUBLIC };

interface CastDeriv {
  v?: number;
  portraitCard?: string;
  portraitHero?: string;
  poses?: string[];
}

interface CoverDeriv {
  card?: string;
  hero?: string;
  sourceBytes?: number;
  cardBytes?: number;
}

interface DerivativesMap {
  cast?: Record<string, CastDeriv>;
  covers?: Record<string, CoverDeriv>;
}

const MAP = baked as unknown as DerivativesMap;

export function castDerivatives(
  slug: string,
  v: number | undefined
): { portraitCard: string | null; portraitHero: string | null; poseThumbs: (string | null)[] } | null {
  const d = MAP.cast?.[slug];
  if (!d || (d.v ?? null) !== (v ?? null)) return null;
  // Derivatives are served immutable, so the gallery version rides in
  // the query string as the cache-buster, same convention as the
  // original art (see versioned() in cast-gallery.ts).
  const q = v ? `?v=${v}` : "";
  return {
    portraitCard: d.portraitCard ? `${MEDIA_PUBLIC}${d.portraitCard}${q}` : null,
    portraitHero: d.portraitHero ? `${MEDIA_PUBLIC}${d.portraitHero}${q}` : null,
    poseThumbs: (d.poses || []).map((k) => (k ? `${MEDIA_PUBLIC}${k}${q}` : null)),
  };
}

export function coverDerivative(
  slug: string,
  kind: "card" | "hero",
  coverKey?: string | null
): string | null {
  // Derivatives were generated from the standard titled cover; never
  // substitute for a book carrying some other cover file.
  if (coverKey !== undefined && coverKey !== null && !coverKey.endsWith("cover-titled.jpg")) return null;
  const d = MAP.covers?.[slug];
  const key = d?.[kind];
  if (!key) return null;
  // The version is the cache-buster, and the media host serves these
  // URLs immutable, so it must track the derivative's own bytes: card
  // derivatives are versioned by cardBytes (a quality-only regen —
  // 2026-10-30, q82 -> q60 — changes the derivative but not the
  // source, and sourceBytes would have kept the old URL, and the old
  // bytes, alive forever). Hero derivatives keep the sourceBytes
  // version: a replaced cover almost always changes byte size, and
  // regeneration restamps it.
  const v = kind === "card" && d?.cardBytes ? d.cardBytes : d?.sourceBytes;
  return v ? `${MEDIA_PUBLIC}${key}?v=${v}` : `${MEDIA_PUBLIC}${key}`;
}
