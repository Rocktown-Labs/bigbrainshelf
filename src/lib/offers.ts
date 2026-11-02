// Offer constants and date-driven feature flags for the Big Brain Shelf
// store. All dates are evaluated in America/Chicago (the store's home
// timezone) so a flag flips at local midnight, not UTC midnight.
//
// New date-gated offers should read their dates from here, never from
// ad-hoc constants scattered through pages.

// ---------------------------------------------------------------------------
// Gift Set (Phase 1): the full color printed storybook plus the printed
// coloring book, with the digital bundle included. One flat price for
// every book, set by CG. A book can sell a Gift Set when it has both a
// story book (the picture book, printed in full color) and a coloring
// book; the option appears automatically once a live book qualifies.

export const GIFT_SET_PRICE_CENTS = 2500;

export function giftSetEligible(book: {
  picture_book_key?: string | null;
  coloring_book_key?: string | null;
}): boolean {
  return Boolean(book?.picture_book_key) && Boolean(book?.coloring_book_key);
}

// ---------------------------------------------------------------------------
// Standard book prices (CG, 2026-10-27). Every book sells its digital
// bundle at $8.99 and its full color printed book at $20. Prices live
// per book on the books row and checkout reads them directly (there is
// no Stripe-side catalog to sync), so the publish action stamps these
// onto any price field that is still 0/NULL when a book goes live.
// A non-zero price is a deliberate custom price and publishing never
// overwrites it.

export const STANDARD_DIGITAL_PRICE_CENTS = 899;
export const STANDARD_PRINT_PRICE_CENTS = 2000;

// ---------------------------------------------------------------------------
// Audiobook only (CG, 2026-10-28): alongside the digital bundle, which
// keeps including the audiobook, a buyer who only wants to listen can
// buy the audiobook on its own for a flat $1.99. The price is a store
// constant like the Gift Set price, not a per-book field: checkout,
// the book page, the carts, and the account pages all read it here.
// The format exists only for books that actually have an audiobook
// (the same data-driven gate as the bundle's audiobook inclusion).

export const AUDIO_PRICE_CENTS = 199;

export function audioEligible(book: { audiobook_key?: string | null }): boolean {
  return Boolean(book?.audiobook_key);
}

// Fill any unset (0/NULL/undefined) price with the standard one; set
// prices pass through untouched. Pure so the publish route and the
// tests share exactly this logic.
export function publishPriceStamp(book: {
  price?: number | null;
  price_print?: number | null;
}): { price: number; price_print: number } {
  return {
    price: book.price ? book.price : STANDARD_DIGITAL_PRICE_CENTS,
    price_print: book.price_print
      ? book.price_print
      : STANDARD_PRINT_PRICE_CENTS,
  };
}

// Buyer-facing names for each cart format. The client-side cart code in
// the .astro pages carries the same strings; keep them in step.
export function formatLabel(format: string): string {
  if (format === "printed") return "Full color printed book";
  if (format === "giftset") return "Gift Set";
  if (format === "audio") return "Audiobook only";
  return "Digital download";
}

export function formatDetail(format: string): string {
  if (format === "printed") return "Full color printed book · digital included";
  if (format === "giftset") return "Gift Set · printed storybook + printed coloring book, digital included";
  if (format === "audio") return "Audiobook only · listen in your library or download the audiobook";
  return "Digital download";
}

// ---------------------------------------------------------------------------
// Book Club membership (Workstream 2, pricing per the approved offer
// memo "Book Club Offer and Pricing", 2026-10-27). A paid subscription;
// joining requires a store account and charges today. Box cycles are
// purchase-anchored: the first box is due the day a member joins and
// the next boxes fall every 3 months from the join date. Shipping is
// included in the price.
//
// These constants are the single source of the club prices everywhere
// (page copy, Stripe sessions, admin revenue math). Nothing else in the
// codebase may hard-code a club price.

// Quarterly plan: $60 billed every 3 months (Stripe recurring interval
// "month" with interval_count 3). CG set $60 on 2026-10-31, priced on
// the totality of the box: two printed books shipped (gift set + a
// second book), the club book's digital kept forever, and read/listen
// access to the whole shelf while a member, shipping included.
export const CLUB_PRICE_CENTS = 6000;

// Annual plan: $199 billed once a year, the same ~17% annual discount
// off 4 x quarterly as the earlier $149 off $45. Offered beside the
// quarterly plan on /clubs, never the default.
export const CLUB_ANNUAL_PRICE_CENTS = 19900;

// ---------------------------------------------------------------------------
// Audio Club (CG rethink, 2026-10-28): the second club plan beside the
// physical Book Club above. A subscription to listening only: while it
// is active, every published book that has an audiobook is listenable
// in the member's library (reader streaming; downloads belong to owned
// books under the lock model, see lib/library). No boxes, no printed
// sets, no digital page access, no founding cap.
//
// PRICES APPROVED BY CG, 2026-10-29: monthly $5.99 (set by CG) and
// annual $49 (the pricing workup's recommendation, approved with it).
// Every surface (page, checkout, emails, admin) reads these constants,
// so changing the price is a one-line edit here and nothing else moves.

// Monthly plan: $5.99 billed every month (Stripe recurring interval
// "month").
export const AUDIO_CLUB_PRICE_CENTS = 599;

// Annual plan: $49 billed once a year.
export const AUDIO_CLUB_ANNUAL_PRICE_CENTS = 4900;

// There is no member cap (CG, 2026-10-31): The Book Club is open to
// whoever joins. The founding cap that used to live here, and every
// check and line of copy that referenced it, were removed.

// The first box's book for each shelf. On paid join, the member gets
// this book's digital bundle in their library immediately (they do not
// wait for the January box for everything). The printed first box
// contents themselves stay operator-chosen; this mapping only drives
// the day-one digital grant.
export const CLUB_FIRST_BOX_BOOK: Record<string, string> = {
  tech: "algorithms", // Fern the Fox and the Clever Trails
  money: "richdadpoordad", // Penny the Squirrel and the Acorn Orchard
  courage: "mira-the-heron-and-the-still-water", // Mira the Heron and the Still Water
};

export function clubPriceLabel(cents: number = CLUB_PRICE_CENTS): string {
  return "$" + (cents / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// Date flags. Dates are YYYY-MM-DD strings in America/Chicago.

export const STORE_TIMEZONE = "America/Chicago";

// RETIRED (2026-10-29): the club originally opened to live members on
// this date, with signups stored as 'queued' before it. The plans are
// live at launch now and box cycles are purchase-anchored, so nothing
// gates on this date anymore. The constant stays only so older imports
// keep compiling.
export const CLUB_LIVE_DATE = "2027-01-01";

// Christmas gift copy (order-by framing for the Gift Set) runs through
// Christmas Day. After this date the Gift Set keeps selling with plain
// evergreen gift copy.
export const CHRISTMAS_COPY_UNTIL = "2026-12-25";

// The order-by date the Christmas Gift Set copy names ("please order
// by December 18 so there is time to print, bind, and mail it"). It
// lives here, beside the season gate, so the date is config and not a
// string buried in a page: next season's date changes in one place.
export const CHRISTMAS_ORDER_BY_LABEL = "December 18";

export function chicagoDateString(d: Date = new Date()): string {
  // en-CA yields YYYY-MM-DD; formatToParts is used so the result does
  // not depend on any one runtime's exact en-CA rendering.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: STORE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Public "Published {Month D, YYYY}" label for a book's published_at
// stamp (unix seconds; books.published_at, stamped once by the publish
// action). Rendered on the book page and in release announcements.
export function formatPublishedDate(sec: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: STORE_TIMEZONE,
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(sec * 1000));
}

// The club plans are live offers (owner direction, 2026-10-29): there
// is no future launch date to gate on. Kept as a function because the
// email models and pages read it as the club's public state.
export function clubIsLive(now: Date = new Date()): boolean {
  return true;
}

export function clubSignupStatus(now: Date = new Date()): "queued" | "live" {
  return "live";
}

export function isChristmasSeason(now: Date = new Date()): boolean {
  return chicagoDateString(now) <= CHRISTMAS_COPY_UNTIL;
}
