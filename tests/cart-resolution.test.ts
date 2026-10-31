// Cart resolution regression tests. The bug these pin (CG, live,
// 2026-10-28): an admin-signed-in shopper added the audiobook
// format on a book page; the header badge said 1, but the cart
// sheet said "Nothing in your cart is available for purchase yet."
// Root cause: the sheet resolves items against GET /api/books,
// whose ADMIN shape is a full row (raw *_key columns, no has_*
// booleans) while the PUBLIC shape is a projection (has_* booleans,
// no keys). The sheet's price logic read only the flags, so audio
// and gift set priced at 0 for admin sessions and were filtered
// out, while the badge counted raw localStorage entries.
//
// The fix is pinned at three layers:
//   1. withAvailabilityFlags gives full rows the has_* booleans, so
//      both /api/books shapes satisfy one availability contract.
//   2. The canonical resolver in src/lib/cart-pricing.ts reads the
//      flag when present and the raw key otherwise, dedupes the
//      stored cart, and prices all four formats.
//   3. Wiring assertions: the one shared cart store carries the
//      flag fallback and dedupe, the badge paints the purchasable
//      count, and every surface wires into the store and its
//      bbs:cart-changed signal instead of keeping a private copy.
// Run with: bun tests/cart-resolution.test.ts
import { readFileSync } from "node:fs";
import { withAvailabilityFlags } from "../src/lib/books-public";
import {
  normalizeCartItems,
  cartItemPriceCents,
  purchasableCartItems,
} from "../src/lib/cart-pricing";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

// The two catalog shapes for the same complete book (Mira).
const publicRow: any = {
  slug: "mastery", price: 899, price_print: 2000,
  has_audiobook: true, has_picture_book: true, has_coloring_book: true,
};
const adminRow: any = {
  slug: "mastery", price: 899, price_print: 2000,
  audiobook_key: "books/mastery/audiobook.m4b",
  picture_book_key: "books/mastery/picture-book.pdf",
  coloring_book_key: "books/mastery/coloring-book.pdf",
};
// A complete book with an audiobook but no coloring book, both shapes.
const publicNoColor: any = {
  slug: "nocolor", price: 899, price_print: 2000,
  has_audiobook: true, has_picture_book: true, has_coloring_book: false,
};
const adminNoColor: any = {
  slug: "nocolor", price: 899, price_print: 2000,
  audiobook_key: "books/nocolor/audiobook.m4b",
  picture_book_key: "books/nocolor/picture-book.pdf",
  coloring_book_key: null,
};
// A complete book with no audiobook at all.
const publicNoAudio: any = {
  slug: "silent", price: 899, price_print: 2000,
  has_audiobook: false, has_picture_book: true, has_coloring_book: true,
};

// --- Layer 1: withAvailabilityFlags --------------------------------
{
  const stamped = withAvailabilityFlags({ ...adminRow });
  assert(stamped.has_audiobook === true, "admin row gains has_audiobook from audiobook_key");
  assert(stamped.has_picture_book === true, "admin row gains has_picture_book from picture_book_key");
  assert(stamped.has_coloring_book === true, "admin row gains has_coloring_book from coloring_book_key");
  assert(stamped.audiobook_key === "books/mastery/audiobook.m4b", "admin row keeps its raw keys for admin consumers");

  const stampedNull = withAvailabilityFlags({ ...adminNoColor });
  assert(stampedNull.has_coloring_book === false, "null coloring_book_key stamps has_coloring_book=false");
  assert(stampedNull.has_audiobook === true, "present audiobook_key stamps has_audiobook=true");

  const untouched = withAvailabilityFlags({ ...publicRow });
  assert(untouched.has_audiobook === true && !("audiobook_key" in untouched), "public row passes through unchanged");

  const bare = withAvailabilityFlags({ slug: "bare" });
  assert(!("has_audiobook" in bare), "a row with neither flags nor keys is left alone");
}

// --- Layer 2: canonical resolver over both shapes ------------------
const EXPECTED: Record<string, number> = { digital: 899, printed: 2000, giftset: 2500, audio: 199 };
for (const [shapeName, row] of [["public", publicRow], ["admin", adminRow]] as const) {
  for (const format of ["digital", "printed", "giftset", "audio"]) {
    const cents = cartItemPriceCents(row, { slug: row.slug, format });
    assert(cents === EXPECTED[format], `${shapeName} shape: ${format} resolves to ${EXPECTED[format]} (got ${cents})`);
  }
}
// The reported symptom, stated as a test: an audio entry against
// the admin shape is purchasable at $1.99, not dropped.
{
  const items = purchasableCartItems([{ slug: "mastery", format: "audio" }], { mastery: adminRow });
  assert(items.length === 1, "admin shape: audio entry survives purchasable filtering");
}
// Format availability gates hold in both shapes.
for (const [shapeName, row] of [["public", publicNoColor], ["admin", adminNoColor]] as const) {
  assert(cartItemPriceCents(row, { slug: "nocolor", format: "giftset" }) === 0, `${shapeName} shape: gift set is 0 without a coloring book`);
  assert(cartItemPriceCents(row, { slug: "nocolor", format: "audio" }) === 199, `${shapeName} shape: audio still resolves without a coloring book`);
}
assert(cartItemPriceCents(publicNoAudio, { slug: "silent", format: "audio" }) === 0, "audio is 0 for a book with no audiobook");
assert(cartItemPriceCents(undefined, { slug: "ghost", format: "digital" }) === 0, "unknown slug resolves to 0");
assert(cartItemPriceCents(publicRow, { slug: "mastery", format: "digital" }, { mastery: 700 }) === 700, "audio owner's digital unlock price applies");
assert(cartItemPriceCents(publicRow, { slug: "mastery", format: "audio" }, { mastery: 700 }) === 199, "unlock price never touches the audio format");
assert(cartItemPriceCents(publicRow, { slug: "mastery", format: "digital" }, { other: 700 }) === 899, "unlock price for another book does not leak");

// --- Normalization: one cart, counted identically everywhere -------
{
  const items = normalizeCartItems([
    "mastery",
    { slug: "mastery", format: "digital" },
    { slug: "mastery", format: "audio" },
    { slug: "mastery", format: "audio" },
    { slug: "", format: "digital" },
    null,
    { slug: "mastery" },
  ]);
  assert(items.length === 2, "duplicates and junk collapse: legacy string + digital dupe + audio dupe -> 2 entries");
  assert(items[0].format === "digital" && items[1].format === "audio", "first occurrence wins, formats preserved");

  const bySlug = { mastery: publicRow };
  const buyable = purchasableCartItems(items, bySlug);
  assert(buyable.length === 2, "badge count source == sheet items == cart items for a mixed cart");
  const dead = purchasableCartItems([{ slug: "ghost", format: "digital" }], bySlug);
  assert(dead.length === 0, "a cart of only unpurchasable entries resolves to zero items (badge must agree at 0)");
}

// --- Layer 3: wiring in the routes and the shared cart store -------
// The cart used to be copy-pasted into every surface, and this layer
// pinned the same markers in each copy. The copies are gone: the
// cart lives in ONE store (src/components/CartStore.astro, shipped
// via SiteHeader as window.bbsCart) and ONE sheet component
// (src/components/CartSheet.astro). The same semantic markers are
// now pinned where they live, each page is pinned to wiring into
// the shared pieces instead of carrying a private copy, and the
// sync contract is pinned too: every mutation announces
// "bbs:cart-changed", surfaces subscribe, and Clear exists.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const booksRoute = read("../src/pages/api/books.ts");
assert(booksRoute.includes("withAvailabilityFlags"), "/api/books stamps availability flags on every shape");

const store = read("../src/components/CartStore.astro");
assert(store.includes('flagOf(b, "has_audiobook", "audiobook_key")'), "store: prices audio through the flag/key fallback");
assert(store.includes('flagOf(b, "has_picture_book", "picture_book_key")'), "store: prices gift set through the flag/key fallback");
assert(store.includes('flagOf(b, "has_coloring_book", "coloring_book_key")'), "store: prices gift set through the coloring flag/key fallback");
assert(store.includes("byKey[k]"), "store: normalize keeps one entry per slug + format (quantities merged)");
assert(store.includes("paintBadgeCount(cart.filter"), "store: badge repaints with the purchasable count");
assert(store.includes("window.bbsPaintBadge = paintBadge"), "store: exposes the badge painter");
assert(store.includes('localStorage.setItem(KEY, JSON.stringify(cart))') && store.includes('"bbs-cart"'), "store: is the one writer of the bbs-cart key");
assert(store.includes('"/api/books?scope=cart"'), "store: resolves against the cart-scoped catalog");
assert(store.includes('"bbs:cart-changed"'), "store: every mutation announces bbs:cart-changed");
assert(store.includes("clear: function () { setCart([]); }"), "store: clear empties the cart through the same write path");
assert(store.includes('window.addEventListener("storage"'), "store: mirrors carts changed in another tab into the same signal");

const header = read("../src/components/SiteHeader.astro");
assert(header.includes("<CartStore />"), "SiteHeader ships the cart store on every public page");

const sheet = read("../src/components/CartSheet.astro");
assert(sheet.includes('"Audiobook only"'), "sheet: labels the audio format \"Audiobook only\"");
assert(sheet.includes('id="cart-clear"') && sheet.includes("Clear cart"), "sheet: carries a Clear cart button");
assert(sheet.includes("store.clear()"), "sheet: Clear goes through the store");
assert(sheet.includes("store.remove(entry.slug, entry.format)"), "sheet: Remove goes through the store");
assert(sheet.includes("store.onChange"), "sheet: re-renders on cart changes from anywhere");

const SHEET_FILES = [
  "../src/pages/index.astro",
  "../src/pages/about.astro",
  "../src/pages/clubs.astro",
  "../src/pages/books/[slug].astro",
  "../src/pages/audiobooks/[slug].astro",
];
for (const f of SHEET_FILES) {
  const src = read(f);
  const name = f.split("/").slice(-2).join("/");
  assert(src.includes("<CartSheet"), `${name}: carries the shared cart sheet`);
  assert(!src.includes("function initCartSheet"), `${name}: no private sheet script remains`);
  assert(!src.includes('localStorage.getItem("bbs-cart")'), `${name}: never reads the cart key directly`);
  assert(!src.includes('localStorage.setItem("bbs-cart"'), `${name}: never writes the cart key directly`);
}

// /cart is a redirect stub now: plain visits go home to the drawer,
// cancelled returns go to the checkout page. The cart machinery this
// block used to pin on /cart (the unlock map, store wiring, Clear,
// Remove, onChange, no reload, no private key access) lives on
// /checkout now, so the pins follow it there.
const cartRoute = read("../src/pages/cart.astro");
assert(cartRoute.includes('Astro.redirect("/?cart=open", 301)'), "/cart: plain visits redirect home to the drawer");
assert(cartRoute.includes('Astro.redirect("/checkout?checkout=cancelled", 301)'), "/cart: cancelled returns redirect to the checkout page, flag intact");
assert(!cartRoute.includes("window.bbsCart"), "/cart: keeps no cart logic of its own anymore");

const checkoutPage = read("../src/pages/checkout.astro");
assert(checkoutPage.includes("__bbsUpgrades"), "/checkout: applies the audio owner's digital unlock price");
assert(checkoutPage.includes("upgradeCentsBySlug"), "/checkout: computes the unlock map server-side from entitlements");
assert(checkoutPage.includes("window.bbsCart"), "/checkout: resolves and mutates through the shared store");
assert(checkoutPage.includes('id="clear-cart"'), "/checkout: carries a Clear cart button");
assert(checkoutPage.includes("store.clear()"), "/checkout: Clear goes through the store");
assert(checkoutPage.includes("store.remove(entry.slug, entry.format)"), "/checkout: Remove goes through the store");
assert(checkoutPage.includes("store.onChange"), "/checkout: re-renders on cart changes from anywhere");
assert(!checkoutPage.includes("window.location.reload()"), "/checkout: removing an item no longer reloads the page");
assert(!checkoutPage.includes('localStorage.getItem("bbs-cart")'), "/checkout: never reads the cart key directly");

const bookPage = read("../src/pages/books/[slug].astro");
assert(bookPage.includes('value="audio"'), "book page: format picker offers the audio format");
assert(bookPage.includes("Audiobook only"), "book page: picker labels it Audiobook only with its price");
assert(bookPage.includes('aria-label="What this book includes"'), "book page: includes badge row is present");
assert(bookPage.includes("Story book") && bookPage.includes("Coloring book"), "book page: badge row names the story and coloring books");
assert(bookPage.includes("bbsCart.add(slug, format)"), "book page: add-to-cart goes through the store (which repaints the header badge)");
assert(bookPage.includes("function syncBtn()"), "book page: buy button state syncs with the picker format's cart state");
assert(bookPage.includes('"bbs:cart-changed"'), "book page: buy button mirror re-syncs on cart changes made elsewhere");

const audioPage = read("../src/pages/audiobooks/[slug].astro");
assert(audioPage.includes('bbsCart.add(slug, "audio")'), "audiobook page: add-to-cart goes through the store (which repaints the header badge)");
assert(audioPage.includes('"bbs:cart-changed"'), "audiobook page: buy button mirror re-syncs on cart changes made elsewhere");

if (failures) {
  console.error(`\n${failures} cart resolution assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll cart resolution assertions passed");
