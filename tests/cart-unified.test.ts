// Cart unification pins (2026-10-30): ONE cart for the whole storefront.
// Every public page renders the header in sheet mode (so the header
// carries the #cart-count badge and the js-cart-open drawer trigger)
// and ships the shared CartSheet markup, so the cart a shopper sees is
// the slide-over drawer on every route. /cart is no longer a second
// cart page: plain visits redirect home with the drawer's open
// signal, cancelled returns redirect to /checkout with the flag
// intact, and checkout itself is its own page (/checkout) running
// the quote-then-pay flow. The checkout button reads "Checkout"; the
// old "Check out with Stripe" label is gone from src. Auth pages
// stay cart-free by design. Source pins in the house style. Run with:
//   bun tests/cart-unified.test.ts
import { readFileSync, readdirSync } from "node:fs";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ---- The header contract -------------------------------------------------
const header = read("../src/components/SiteHeader.astro");
assert(header.includes("js-cart-open"), "header: sheet mode marks the cart button js-cart-open");
assert(header.includes('id="cart-count"'), "header: sheet mode renders the #cart-count badge");
assert(header.includes("CartStore"), "header: ships the shared cart store on every page");

// ---- Every public storefront page: sheet-mode header + shared sheet -----
const SHEET_PAGES = [
  "../src/pages/index.astro",
  "../src/pages/about.astro",
  "../src/pages/clubs.astro",
  "../src/pages/books/[slug].astro",
  "../src/pages/audiobooks.astro",
  "../src/pages/audiobooks/[slug].astro",
  "../src/pages/merch.astro",
  "../src/pages/meet-the-cast.astro",
  "../src/pages/meet-the-cast/[character].astro",
  "../src/pages/privacy.astro",
  "../src/pages/terms.astro",
  "../src/pages/order.astro",
  "../src/pages/checkout.astro",
];
for (const p of SHEET_PAGES) {
  const src = read(p);
  assert(src.includes('cartMode="sheet"'), `${p}: header renders in sheet mode (badge + drawer trigger)`);
  assert(!src.includes('cartMode="link"'), `${p}: no link-mode header remains`);
  assert(src.includes("<CartSheet"), `${p}: ships the shared cart sheet markup`);
}

// ---- Auth pages carry no cart by design -----------------------------------
for (const p of ["../src/pages/login.astro", "../src/pages/signup.astro"]) {
  assert(!read(p).includes("CartSheet"), `${p}: auth page carries no cart sheet`);
}

// ---- The checkout button reads "Checkout" ---------------------------------
const sheet = read("../src/components/CartSheet.astro");
assert(sheet.includes('id="cart-checkout"') && sheet.includes(">Checkout</button>"), "drawer: checkout button reads Checkout");
assert(sheet.includes('window.location.href = "/checkout"'), "drawer: the checkout button hands off to the /checkout page");
assert(!sheet.includes('action: "quote"') && !sheet.includes('id="cart-ship-form"'), "drawer: runs no checkout machinery itself");

// ---- /cart is a permanent redirect, not a second cart ----------------------
const cartRoute = read("../src/pages/cart.astro");
assert(cartRoute.includes('Astro.redirect("/?cart=open", 301)'), "/cart: a plain visit goes home with the drawer's open signal");
assert(cartRoute.includes('Astro.redirect("/checkout?checkout=cancelled", 301)'), "/cart: a cancelled return goes to the checkout page with the flag intact");
assert(!cartRoute.includes("<CartSheet") && !cartRoute.includes("SiteHeader"), "/cart: the stub renders no header or sheet of its own");

// The sheet honors the open signal, then scrubs the param so a
// refresh stays closed.
assert(sheet.includes('params.get("cart") === "open"'), "drawer: opens when the URL carries ?cart=open");
assert(sheet.includes("history.replaceState"), "drawer: scrubs the signal from the URL after opening");

// ---- Checkout is its own page ------------------------------------------------
// The retired /cart page's machinery, framed as checkout: line
// items, the shipping address form, the two-step quote for physical
// carts, and the cancelled banner Stripe's cancel_url lands on.
const checkoutPage = read("../src/pages/checkout.astro");
assert(checkoutPage.includes('id="ship-form"'), "checkout page: carries the shipping address form");
assert(checkoutPage.includes('id="ship-line1"') && checkoutPage.includes('id="ship-zip"'), "checkout page: the address fields live on the page");
assert(checkoutPage.includes('action: "quote"'), "checkout page: quotes shipping through /api/checkout's quote action");
assert(checkoutPage.includes('id="step1-continue"') && checkoutPage.includes("Checking address and rates..."), "checkout page: step 1 Continue runs the shipping quote (stepped flow, CG 2026-10-30)");
assert(checkoutPage.includes('id="step2-continue"') && checkoutPage.includes('id="step1-edit"'), "checkout page: shipping step confirms with its own Continue, address step collapses to a summary with Edit");
assert(checkoutPage.includes('"Shipping" +') && checkoutPage.includes('" · " + store.money(qd.shipping.amount_cents)'), "checkout page: the quote line is one terse provider-neutral shipping line (CG, 2026-11-07, rethought around the Lulu flow)");
assert(!checkoutPage.includes("carrier's rate for your address") && !checkoutPage.includes("Deliverable address, as standardized"), "checkout page: no carrier prose and no standardized-address note on the shipping step (CG, 2026-11-07)");
assert(checkoutPage.includes('checkoutBtn.textContent = "Pay " + store.money(qd.total)'), "checkout page: the pay button names the quoted total");
assert(!checkoutPage.includes("with Stripe"), "checkout page: no buyer-facing button names Stripe");
assert(checkoutPage.includes('id="cancelled"') && checkoutPage.includes('get("checkout") === "cancelled"') && checkoutPage.includes("Checkout was cancelled. Your cart is still here."), "checkout page: shows the cancelled banner for ?checkout=cancelled");

// No user-facing "Check out with Stripe" anywhere in src.
{
  const srcRoot = new URL("../src/", import.meta.url);
  const files = (readdirSync(srcRoot, { recursive: true }) as string[])
    .filter((f) => /\.(astro|ts|tsx|js|mjs)$/.test(f));
  const offenders = files.filter((f) =>
    readFileSync(new URL(f, srcRoot), "utf8").includes("Check out with Stripe"));
  assert(offenders.length === 0, `no "Check out with Stripe" remains in src (offenders: ${offenders.join(", ") || "none"})`);
}

// ---- Club lines and the gift flag (CG, 2026-11-07) -----------------------
// Clubs are cart items: reserved slugs, period formats, one per
// cart, priced from the offers constants without the books catalog.
const store = read("../src/components/CartStore.astro");
const offers = read("../src/lib/offers.ts");
assert(offers.includes("CLUB_PRICE_CENTS = 6000") && offers.includes("CLUB_ANNUAL_PRICE_CENTS = 19900") && offers.includes("AUDIO_CLUB_PRICE_CENTS = 599") && offers.includes("AUDIO_CLUB_ANNUAL_PRICE_CENTS = 4900"), "offers: the four club prices are the constants");
assert(offers.includes("resolveClubCartLine"), "offers: the server resolves club cart lines from one place");
assert(store.includes("price: 6000") && store.includes("price: 19900") && store.includes("price: 599") && store.includes("price: 4900"), "cart store: club prices are baked from the offers constants");
assert(store.includes("if (isClubSlug(it.slug))"), "cart store: priceOf special-cases club slugs before the catalog");
assert(store.includes('it.slug === "book-club" && !!clubInfo(it)'), "cart store: a book-club line counts toward the address step");
assert(store.includes("needsAddress"), "cart store: address need is separate from the shipping charge");
assert(store.includes("getCart().filter(function (x) { return !isClubSlug(x.slug); })"), "cart store: adding a club replaces any club line already in the cart");
assert(store.includes("setGift: function"), "cart store: the gift flag has a dedicated setter");
assert(sheet.includes("clubInfo(it)") && sheet.includes("ci.title"), "cart sheet: renders club lines with the club title");
assert(sheet.includes("cart-gift") && sheet.includes("This is a gift"), "cart sheet: book lines carry the gift toggle");
assert(sheet.includes("Gift</span>"), "cart sheet: flagged lines wear the Gift tag");
assert(checkoutPage.includes("clubInfo(it)") && checkoutPage.includes('id="guest-email"'), "checkout page: club lines render and the guest membership email field exists");
assert(checkoutPage.includes("This is a gift") && checkoutPage.includes("gift-toggle"), "checkout page: book lines carry the gift toggle");
assert(checkoutPage.includes("view.shippingStep") && checkoutPage.includes("qd.address_only"), "checkout page: the club-only address flow skips the shipping step");
assert(checkoutPage.includes("Email for your membership and receipt"), "checkout page: the guest club email is labeled for membership and receipt");
const apiCheckout = read("../src/pages/api/checkout.ts");
assert(apiCheckout.includes("resolveClubCartLine") && apiCheckout.includes('mode: clubSpec ? "subscription" : "payment"'), "checkout api: club lines price server-side and open a subscription session");
assert(apiCheckout.includes("club_plan: clubSpec.clubPlan") && apiCheckout.includes("club_email"), "checkout api: the session metadata carries the club facts");
assert(apiCheckout.includes("That email already has an account."), "checkout api: guard (a) refuses an email that already has an account");
assert(apiCheckout.includes("already a member"), "checkout api: guard (b) refuses an existing paid membership for the same plan");

if (failures) { console.error(`\n${failures} FAILURES`); process.exit(1); }
console.log("\nAll cart unification tests passed.");
