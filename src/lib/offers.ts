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

export const GIFT_SET_PRICE_CENTS = 3500; // $35 (CG, 2026-11-07, raised from $25 with the Lulu print integration)

export function giftSetEligible(book: {
  picture_book_key?: string | null;
  coloring_book_key?: string | null;
}): boolean {
  return Boolean(book?.picture_book_key) && Boolean(book?.coloring_book_key);
}

// ---------------------------------------------------------------------------
// Standard book prices (CG, 2026-10-27; raised 2026-11-07 with the
// Lulu print integration). Every book sells its digital bundle at
// $12.99 and its full color printed book at $24.99. Prices live
// per book on the books row and checkout reads them directly (there is
// no Stripe-side catalog to sync), so the publish action stamps these
// onto any price field that is still 0/NULL when a book goes live.
// A non-zero price is a deliberate custom price and publishing never
// overwrites it. The 2026-11-07 raise also updated the live rows that
// carried the old standards (899/2000) to the new ones in D1.

export const STANDARD_DIGITAL_PRICE_CENTS = 1299;
export const STANDARD_PRINT_PRICE_CENTS = 2499;

// ---------------------------------------------------------------------------
// Audiobook only (CG, 2026-10-28): alongside the digital bundle, which
// keeps including the audiobook, a buyer who only wants to listen can
// buy the audiobook on its own for a flat $5.99 (raised from $1.99,
// CG, 2026-11-07, with the Lulu print integration; the audio-to-digital
// unlock stays exactly $7.00: 1299 - 599). The price is a store
// constant like the Gift Set price, not a per-book field: checkout,
// the book page, the carts, and the account pages all read it here.
// The format exists only for books that actually have an audiobook
// (the same data-driven gate as the bundle's audiobook inclusion).

export const AUDIO_PRICE_CENTS = 599;

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
  tech: "algorithms", // Fenix the Fox and the Clever Trails
  money: "richdadpoordad", // Penny the Squirrel and the Acorn Orchard
  courage: "mira-the-heron-and-the-still-water", // Mira the Heron and the Still Water
};

export function clubPriceLabel(cents: number = CLUB_PRICE_CENTS): string {
  return "$" + (cents / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// Clubs in the cart (CG, 2026-11-07): the clubs are cart products like
// everything else. A club line carries a reserved slug (never a book
// slug) and its FORMAT is the billing period:
//
//   book-club   The Book Club (physical plan): quarterly | annual
//   audio-club  The Audio Club (audio plan):     monthly | annual
//
// The cart holds at most one club line (adding a club replaces any
// club line already there), quantity is locked to 1, and checkout
// prices the line from the constants above, never from a client
// figure. Memberships live on the buyer's email (club_signups is
// email-keyed), so guests subscribe without an account and the
// membership attaches when they later sign in with that email.

export const BOOK_CLUB_CART_SLUG = "book-club";
export const AUDIO_CLUB_CART_SLUG = "audio-club";

export function isClubCartSlug(slug: unknown): boolean {
  return slug === BOOK_CLUB_CART_SLUG || slug === AUDIO_CLUB_CART_SLUG;
}

export type ClubCartPlan = "physical" | "audio";

export function clubPlanForCartSlug(slug: unknown): ClubCartPlan | null {
  return slug === BOOK_CLUB_CART_SLUG
    ? "physical"
    : slug === AUDIO_CLUB_CART_SLUG
      ? "audio"
      : null;
}

export function clubCartSlugForPlan(plan: ClubCartPlan): string {
  return plan === "audio" ? AUDIO_CLUB_CART_SLUG : BOOK_CLUB_CART_SLUG;
}

export interface ClubCartLineSpec {
  slug: string;
  clubPlan: ClubCartPlan;
  period: string; // quarterly | annual | monthly
  priceCents: number;
  title: string; // "The Book Club" | "The Audio Club"
  periodLabel: string; // "Every 3 months" | "Yearly" | "Monthly"
  billedLabel: string; // "billed every 3 months" | "billed once a year" | "billed monthly"
  productName: string; // Stripe product name (matches /api/club/checkout)
  productDescription: string; // Stripe product description (same)
  recurring: { interval: "month" | "year"; interval_count?: number };
}

// Resolve a (club slug, period) pair to its full line spec, or null
// when the pair is not a club line the store sells (wrong period for
// the plan, unknown slug). The Stripe product names, descriptions,
// prices, and recurring intervals are the ones /api/club/checkout has
// always used, so a membership started from the cart is identical to
// one started from the account-bound club checkout.
export function resolveClubCartLine(slug: unknown, format: unknown): ClubCartLineSpec | null {
  const clubPlan = clubPlanForCartSlug(slug);
  if (!clubPlan) return null;
  const period = String(format || "");
  if (clubPlan === "audio") {
    if (period !== "monthly" && period !== "annual") return null;
    const annual = period === "annual";
    return {
      slug: AUDIO_CLUB_CART_SLUG,
      clubPlan,
      period,
      priceCents: annual ? AUDIO_CLUB_ANNUAL_PRICE_CENTS : AUDIO_CLUB_PRICE_CENTS,
      title: "The Audio Club",
      periodLabel: annual ? "Yearly" : "Monthly",
      billedLabel: annual ? "billed once a year" : "billed monthly",
      productName: annual ? "Big Brain Shelf Audio Club (Annual)" : "Big Brain Shelf Audio Club",
      productDescription:
        "Every Big Brain Shelf audiobook in your library while your membership is active: listen in the reader, as much as you like. Listening only; no printed sets ship on this plan.",
      recurring: annual ? { interval: "year" } : { interval: "month" },
    };
  }
  if (period !== "quarterly" && period !== "annual") return null;
  const annual = period === "annual";
  return {
    slug: BOOK_CLUB_CART_SLUG,
    clubPlan,
    period,
    priceCents: annual ? CLUB_ANNUAL_PRICE_CENTS : CLUB_PRICE_CENTS,
    title: "The Book Club",
    periodLabel: annual ? "Yearly" : "Every 3 months",
    billedLabel: annual ? "billed once a year" : "billed every 3 months",
    productName: annual ? "Big Brain Shelf Book Club (Annual)" : "Big Brain Shelf Book Club",
    productDescription:
      "A printed set each quarter: the full color storybook plus its printed coloring book, with a bonus back catalog coloring book and the digital editions in your library. Shipping included.",
    recurring: annual ? { interval: "year" } : { interval: "month", interval_count: 3 },
  };
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
