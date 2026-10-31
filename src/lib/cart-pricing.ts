// Canonical cart resolution: which stored cart entries are
// purchasable, and at what price. The cart scripts inlined in the
// .astro pages (slide-over sheets, /cart) carry the same rules in
// plain script form because the raw Workers deploy serves those
// inline scripts as-is; keep the two in step. The test suite pins
// this module and asserts the inline copies carry the same markers.
//
// The rule that matters most: availability reads the has_* flags
// when the row carries them (the public /api/books projection) and
// falls back to the raw *_key columns when it does not (the admin
// full-row shape). A reader that only knew one shape silently
// priced the other shape's audio and gift set items at 0.

import { AUDIO_PRICE_CENTS, GIFT_SET_PRICE_CENTS } from "./offers";

export interface CartItem {
  slug: string;
  format: string;
}

// Stored carts may hold legacy bare slug strings (treated as
// digital) and, from older writers, duplicate slug + format pairs.
// Normalization is the same everywhere it happens: strings become
// digital entries, slugless entries drop, duplicates collapse to
// the first entry, so the badge, the sheet, and the cart page all
// count one identical cart.
export function normalizeCartItems(raw: unknown): CartItem[] {
  const seen = new Set<string>();
  const out: CartItem[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    const it: any = typeof x === "string" ? { slug: x, format: "digital" } : x;
    if (!it || !it.slug) continue;
    const item: CartItem = { slug: String(it.slug), format: String(it.format || "digital") };
    const k = item.slug + ":" + item.format;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export function bookFlag(book: any, flag: string, key: string): boolean {
  if (!book) return false;
  return book[flag] !== undefined ? !!book[flag] : !!book[key];
}

// Price in cents for one cart entry against one catalog row, or 0
// when the entry is not purchasable (unknown book, format the book
// cannot sell, unset price). `upgrades` maps slug -> digital cents
// for the signed-in audiobook owner's unlock price; it only ever
// applies to the digital format.
export function cartItemPriceCents(
  book: any,
  item: CartItem,
  upgrades?: Record<string, number>,
): number {
  if (!book) return 0;
  if (item.format === "printed") return Math.round(Number(book.price_print || 0));
  if (item.format === "giftset") {
    return bookFlag(book, "has_picture_book", "picture_book_key") &&
      bookFlag(book, "has_coloring_book", "coloring_book_key")
      ? GIFT_SET_PRICE_CENTS
      : 0;
  }
  if (item.format === "audio") {
    return bookFlag(book, "has_audiobook", "audiobook_key") ? AUDIO_PRICE_CENTS : 0;
  }
  if (
    item.format === "digital" &&
    upgrades &&
    Object.prototype.hasOwnProperty.call(upgrades, item.slug)
  ) {
    return upgrades[item.slug];
  }
  return Math.round(Number(book.price || 0));
}

export function purchasableCartItems(
  items: CartItem[],
  bySlug: Record<string, any>,
  upgrades?: Record<string, number>,
): CartItem[] {
  return items.filter((it) => cartItemPriceCents(bySlug[it.slug], it, upgrades) > 0);
}
