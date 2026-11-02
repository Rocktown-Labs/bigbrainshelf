// Merch catalog for /merch (A2 redesign).
//
// PLACEHOLDER PRODUCTS: these are the approved preview products from
// the A2 prototype. There is no fulfillment behind them yet, so the
// merch page renders them with a "Coming soon" button and never adds
// anything to the cart. When real products exist, swap the entries
// here (name, price, note, and the book whose cover art the card
// shows) and wire the button on the page.
//
// `bookSlug` is the INTERNAL slug of the book whose cover illustrates
// the product card.
export interface MerchProduct {
  name: string;
  bookSlug: string;
  price: string;
  note: string;
}

export const MERCH_PRODUCTS: MerchProduct[] = [
  { name: "Mira plush", bookSlug: "mira-the-heron-and-the-still-water", price: "$24", note: "Soft heron, stands 10 inches tall" },
  { name: "Fern trail tee, kids", bookSlug: "algorithms", price: "$18", note: "Fern the Fox, front print" },
  { name: "Wally harbor tee, kids", bookSlug: "docker", price: "$18", note: "Wally the Whale, front print" },
  { name: "Pattern Book tee, grown-ups", bookSlug: "designpatterns", price: "$22", note: "Basil the Beaver, front print" },
  { name: "Big Brain Shelf headband", bookSlug: "richdadpoordad", price: "$14", note: "Penny the Squirrel print band" },
  { name: "Cover art print, Wren", bookSlug: "thewarofart", price: "$12", note: "8 by 10 print, ready to frame" },
  { name: "Cast sticker pack", bookSlug: "compoundeffect", price: "$6", note: "Eight stickers, one per book" },
];
