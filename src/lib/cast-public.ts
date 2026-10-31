// Shared cast model for the public Meet the Cast pages: joins the D1
// characters registry with the pose-gallery manifest (src/data/
// cast-gallery.json, produced by scripts/extract-cast-poses.py) and the
// public overview copy in cast-overviews.ts.
import { CAST_OVERVIEWS, CAST_BIOS, BOOK_CAST_ORDER } from "./cast-overviews";
import { nameKey } from "./character-sheets";
import {
  bakedManifest,
  versioned,
  focalFor,
  type GalleryManifest,
  type GalleryFocal,
  type GalleryPoseMeta,
} from "./cast-gallery";
import { castDerivatives } from "./derivatives";
import { mediaUrl } from "./media";

export type { GalleryFocal };
export { objectPosition } from "./cast-gallery";

export const TOPIC_LABELS: Record<string, string> = {
  tech: "Tech",
  money: "Money",
  courage: "Courage",
};

// Soft hero tints per shelf, in the site's navy/orange family.
export const TOPIC_TINTS: Record<string, string> = {
  Tech: "#e7eef8",
  Money: "#fdf0dc",
  Courage: "#fde8e2",
  default: "#fdf6ec",
};

export interface CastMember {
  slug: string;
  name: string;
  species: string;
  bookSlug: string;
  /** The book's title-based public slug (lib/public-slugs.ts): the
   *  only slug a public "see the book" link may carry. Falls back to
   *  bookSlug while the book has no public slug minted. */
  bookPublicSlug: string;
  bookTitle: string;
  topic: string;
  workshop: boolean;
  role: string;
  blurb: string;
  bio: [string, string] | null;
  fun: string;
  portrait: string | null;
  poses: string[];
  /** Right-sized WebP derivatives of portrait/poses for card and tile
   * contexts (null when none match the current gallery version);
   * portrait/poses stay the full-size originals for hero/lightbox. */
  portraitCard: string | null;
  portraitHero: string | null;
  poseThumbs: (string | null)[];
  /** Focal point of the starred (portrait) pose; drives every
   * object-cover frame that shows the portrait. */
  portraitFocal: GalleryFocal;
  /** Per-pose focal points, parallel to poses. */
  poseFocals: GalleryFocal[];
  /** Per-pose action tags (slug form, e.g. "carrying"), parallel to
   * poses; null where a pose carries no tag. Public captions show the
   * action instead of a pose number. */
  poseActions: (string | null)[];
}

interface GalleryEntry {
  name: string;
  bookSlug: string;
  portrait: string;
  poses: string[];
  poseCount: number;
  v?: number;
  portraitIndex?: number;
  poseMeta?: GalleryPoseMeta[];
}

export function galleryEntry(
  slug: string,
  manifest: GalleryManifest = bakedManifest()
): GalleryEntry | null {
  return (manifest.characters[slug] as GalleryEntry) || null;
}

// Build the full cast from D1 character rows (joined with their books).
// A character appears when it has gallery art; the workshop book
// (iwillteach, no picture book yet) is included and flagged. Pass the
// runtime manifest (loadCastGallery) so admin crop edits show up
// without a deploy; it defaults to the baked copy.
export function buildCast(rows: any[], manifest: GalleryManifest = bakedManifest()): CastMember[] {
  const GALLERY = manifest.characters as Record<string, GalleryEntry>;
  const members: CastMember[] = [];
  for (const row of rows) {
    const slug = nameKey(String(row.name));
    const entry = GALLERY[slug];
    if (!entry) continue;
    const key = `${String(row.book_slug)}:${String(row.name)}`;
    const overview = CAST_OVERVIEWS[key];
    const bio = CAST_BIOS[key];
    const deriv = castDerivatives(slug, entry.v);
    members.push({
      slug,
      name: String(row.name),
      species: String(row.species),
      bookSlug: String(row.book_slug),
      bookPublicSlug: String(row.book_public_slug || row.book_slug),
      bookTitle: String(row.book_title),
      topic: TOPIC_LABELS[String(row.book_topic || "tech")] || "Tech",
      workshop: !row.picture_book_key,
      role: overview?.role || "",
      blurb: overview?.blurb || "",
      bio: bio?.bio || null,
      fun: bio?.fun || "",
      portrait: versioned(mediaUrl(entry.portrait) || entry.portrait, entry.v),
      poses: (entry.poses || []).map((u) => versioned(mediaUrl(u) || u, entry.v)),
      portraitCard: deriv?.portraitCard || null,
      portraitHero: deriv?.portraitHero || null,
      poseThumbs: (entry.poses || []).map((_, i) => deriv?.poseThumbs[i] || null),
      portraitFocal: focalFor(entry, entry.portraitIndex ?? 0),
      poseFocals: (entry.poses || []).map((_, i) => focalFor(entry, i)),
      poseActions: (entry.poses || []).map((_, i) => entry.poseMeta?.[i]?.action || null),
    });
  }
  return members;
}

// Members of one book in story order (protagonist first).
export function bookCast(members: CastMember[], bookSlug: string): CastMember[] {
  const inBook = members.filter((m) => m.bookSlug === bookSlug);
  const order = BOOK_CAST_ORDER[bookSlug] || [];
  return inBook.sort((a, b) => {
    const ia = order.indexOf(a.name);
    const ib = order.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

export interface BookGroup {
  bookSlug: string;
  bookPublicSlug: string;
  bookTitle: string;
  topic: string;
  workshop: boolean;
  members: CastMember[];
}

// Book groups for the index: published books by title, workshop last.
export function bookGroups(members: CastMember[]): BookGroup[] {
  const slugs: string[] = [];
  for (const m of members) if (!slugs.includes(m.bookSlug)) slugs.push(m.bookSlug);
  const groups = slugs.map((slug) => {
    const cast = bookCast(members, slug);
    return {
      bookSlug: slug,
      bookPublicSlug: cast[0].bookPublicSlug,
      bookTitle: cast[0].bookTitle,
      topic: cast[0].topic,
      workshop: cast[0].workshop,
      members: cast,
    };
  });
  return groups.sort((a, b) => {
    if (a.workshop !== b.workshop) return a.workshop ? 1 : -1;
    return a.bookTitle.localeCompare(b.bookTitle);
  });
}
