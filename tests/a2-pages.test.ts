// A2 redesign surface pins (2026-10-29): the shared hero + routes bar,
// the merch preview (placeholder products, never wired to the cart),
// and the clubs page (hero + routes bar, no January ship copy,
// the mobile plan switch, and the checkout wiring untouched). Source
// pins in the house style. Run with:
//   bun tests/a2-pages.test.ts
import { readFileSync } from "node:fs";
import { MERCH_PRODUCTS } from "../src/data/merch";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ---- Shared components ------------------------------------------------
const hero = read("../src/components/SectionHero.astro");
assert(hero.includes("Big ideas for little brains."), "the shared hero carries the constant H1");
assert(hero.includes("For curious kids ages 4"), "the shared hero carries the constant ages line");
assert(hero.includes("subline"), "the shared hero takes the per-page subline");

const nav = read("../src/components/SectionNav.astro");
for (const [label, href] of [["Books", "/"], ["Audio", "/audiobooks"], ["Merch", "/merch"], ["Clubs", "/clubs"], ["Cast", "/meet-the-cast"]] as const) {
  assert(nav.includes(`label: "${label}"`) && nav.includes(`href: "${href}"`), `routes bar links ${label} to ${href}`);
}
assert(!nav.includes("Soon"), "no Soon tag remains on the routes bar (Merch is a live route)");

// ---- Merch: placeholder products, no cart wiring -----------------------
assert(MERCH_PRODUCTS.length === 7, "the merch data file carries the 7 prototype products");
for (const name of ["Mira plush", "Fern trail tee, kids", "Wally harbor tee, kids", "Pattern Book tee, grown-ups", "Big Brain Shelf headband", "Cover art print, Wren", "Cast sticker pack"]) {
  assert(MERCH_PRODUCTS.some((p) => p.name === name), `merch product present: ${name}`);
}
const merch = read("../src/pages/merch.astro");
assert(merch.includes('<SectionNav active="merch" />'), "merch renders the routes bar with Merch active");
assert(merch.includes('subline="Shirts, prints, and gifts starring the cast from the books."'), "merch hero carries the merch subline");
assert(merch.includes("Coming soon"), "merch buttons read Coming soon");
assert(merch.includes("disabled"), "merch buttons are disabled");
assert(!merch.includes("bbs-cart"), "merch never touches the cart storage");
assert(!merch.includes("Add to cart") && !merch.includes("addToCart"), "merch has no add-to-cart wiring");
assert(!merch.includes("/api/checkout"), "merch cannot reach checkout");
assert(merch.includes("<CartSheet"), "merch ships the shared cart sheet (the storefront-wide header drawer); its placeholder products stay unwired");
assert(merch.includes("/just-buy-it.webp"), "merch covers keep the deterrent overlay");

// ---- Book club: hero, no January copy, mobile switch, wiring -----------
const club = read("../src/pages/clubs.astro");
const bookClubPage = read("../src/pages/clubs/book-club.astro");
assert(club.includes('<SectionNav active="plans" />'), "clubs renders the routes bar with Plans active");
assert(club.includes('subline="Two simple clubs: printed books by mail, or every audiobook on the shelf."'), "clubs hero carries the plans subline");
assert(!club.includes("January"), "no January ship copy remains on the plans page");
assert(!club.includes("First boxes ship"), "the first-boxes-ship line is gone");
assert(club.includes("First box ships within 5 to 7 days of joining, then every 3 months."), "the plans page states the first box ship window (processing time, CG 2026-10-31)");
assert(club.includes('id="plan-switch"'), "the mobile plan switch exists");
assert(club.includes('data-plan-switch="physical"') && club.includes('data-plan-switch="audio"'), "the switch offers The Book Club and The Audio Club");
assert(club.includes(">The Book Club</button>") && club.includes(">The Audio Club</button>"), "the mobile switch names the products with the The");
assert(club.includes("plan-card-audio max-sm:hidden"), "the Audio Club panel starts hidden on mobile (Book Club is the default)");
assert(club.includes("plan-card-physical"), "the Book Club panel is tagged for the switch");
assert(club.includes("setMobilePlan"), "the switch toggles the panels");
// Checkout wiring untouched: the three forms and their endpoints.
assert(club.includes('id="club-form"') && club.includes('id="audio-form"'), "the two club forms keep their ids");
assert(!club.includes('id="waitlist-form"') && !club.includes("CLUB_FOUNDING_CAP"), "no waitlist form and no member cap anywhere on the clubs page (cap removed 2026-10-31)");
assert(club.includes('postJson("/api/club/checkout"'), "the join flow still posts to club checkout");
assert(club.includes('postJson("/api/club-signup"'), "the waitlist flow still posts to club signup");
assert(club.includes("club_plan"), "the join flow still sends the plan dimension");

// ---- The four section pages all carry hero + routes bar -----------------
const home = read("../src/pages/index.astro");
assert(home.includes("SectionHero") && home.includes('<SectionNav active="books" />'), "home carries hero + routes bar");
const audio = read("../src/pages/audiobooks.astro");
assert(audio.includes('subline="Audiobooks on tech, money, and courage, told so kids can get it."'), "audiobooks hero carries the audio subline");
assert(audio.includes("SeoHead"), "audiobooks gets the standard SEO head treatment");
assert(merch.includes("SeoHead"), "merch gets the standard SEO head treatment");

// ---- Option A offer (2026-10-29): two title slots + new copy ------
const clubCyclesSrcA = read("../src/lib/club-cycles.ts");
assert(clubCyclesSrcA.includes("second_selected_book_slug") && clubCyclesSrcA.includes("second_resolved_book_slug"), "club boxes carry a second title slot");
assert(clubCyclesSrcA.includes("saveClubSecondSelection"), "members can save a second-slot pick");
const adminClubApi = read("../src/pages/api/admin/club.ts");
assert(adminClubApi.includes("second_selected_title") && adminClubApi.includes("second_resolved_title"), "admin club payload includes both box titles");
const adminClubPage = read("../src/pages/admin/club.astro");
assert(adminClubPage.includes("Extras: sticker sheet + little extra"), "admin box rows carry the extras packing line");
assert(adminClubPage.includes("box-book-2"), "admin can resolve the second slot");
const accountPageSrc = read("../src/pages/account/club.astro");
assert(accountPageSrc.includes('data-pick-2') && accountPageSrc.includes('data-pick-shelf'), "account pick form is the Shelf selector with two box slots (radio list retired 2026-11-01; Shelf won the prototype, grid retired same day)");
assert(accountPageSrc.includes("selection_2"), "account pick form submits the second pick");
assert(!accountPageSrc.includes("bonus back catalog coloring book"), "account page no longer promises the old bonus coloring book");

// Plans page carries the owner's condensed card copy (2026-10-29):
// The Book Club card is exactly four bullets, the price lines above
// them unchanged, the official product names carry the The, and no
// shelf picking happens before subscribing (members configure their
// offering in their account afterwards).
assert(club.includes("{clubMonthlyEquivalentLabel} a month, billed every 3 months"), "clubs: monthly-equivalent framing from the price constants, with the billing rhythm spelled out (2026-10-30)");
assert(club.includes("About {clubAnnualMonthlyLabel} a month, billed once a year"), "clubs: annual plan carries its own per-month equivalent");
assert(club.includes("Save {clubSaveLabel}") && club.includes("Save {audioSaveLabel}"), "clubs: yearly options carry computed savings tags");
assert(club.includes("{boxValueLabel} in value in every box, shipping included") && club.includes("const boxValueLabel = \"$60\""), "clubs: the card's value claim is CG's flat $60 in value, shipping included (2026-11-01), matching the promo");
assert(bookClubPage.includes("{boxTotalLabel}") && bookClubPage.includes("{giftSetLabel}") && bookClubPage.includes("{secondBookLabel}") && bookClubPage.includes("{secondDigitalLabel}"), "clubs/book-club: the learn-more page itemizes the box from the same constants");
assert(club.includes("{boxValueLabel} in value in every box, shipping included"), "clubs: shipping line (the $60 value claim carries shipping included, CG 2026-11-01)");
assert(club.includes("The gift set: a printed storybook and a printed coloring book."), "clubs: short bullet 1 (the gift set)");
assert(club.includes("A second printed book: your pick, or a surprise you do not own."), "clubs: short bullet 2 (second book)");
assert(club.includes("First box guarantee: if it misses in 30 days, your first payment comes back."), "clubs: short bullet 3 (first box guarantee)");
assert(club.includes("The club book is yours to keep digitally, even if you cancel."), "clubs: card body keeps the owned-digital point (lock model)");
assert(club.includes("Save {clubSaveLabel} · {clubSavePct}%") && club.includes("Save {audioSaveLabel} · {audioSavePct}%"), "clubs: yearly badges carry the dollar saving and the computed percentage");
assert(club.includes("Cancel anytime. What you own stays yours."), "clubs: card footer kept");
assert(club.includes("Want the books themselves? That is The Book Club."), "clubs: audio card carries the clarifying line with the official name");
assert(!club.includes("every quarter"), "clubs: no calendar-quarter framing remains");
assert(!club.includes("Pick your starting shelf"), "clubs: no shelf picking before subscribing");
assert(!club.includes('name="shelf"'), "clubs: no shelf radio inputs remain");
assert(club.includes(">The Book Club</h2>") && club.includes(">The Audio Club</h2>"), "clubs: card titles carry the official names");

// ---- View transition parity (2026-10-29): audio covers carry the
// same shared-element transition name as the home shelf cards and
// the book detail cover, and audiobook detail pages classify at
// detail depth (2) in the transition hooks, like book detail pages.
// Round 2 (same day): the audio DETAIL page must not repeat the
// section chrome (SectionHero/SectionNav) the book detail page does
// not have: the duplicated hero composited against itself mid-
// transition (doubled headline) and padded the DOM-update phase
// until phone-class browsers skipped the transition outright. And
// merch cards carry NO transition name: they navigate nowhere, so a
// name only paired shelf covers into merch cards on tab switches
// and stranded exit groups over the next page on the way out.
const audioDetail = read("../src/pages/audiobooks/[slug].astro");
assert(audio.includes("view-transition-name: book-cover-${b.slug}"), "audio shelf cards carry the shared cover transition name");
assert(audioDetail.includes("view-transition-name: book-cover-${slug}"), "audio detail cover carries the shared cover transition name");
assert(!audioDetail.includes("<SectionHero"), "audio detail renders no SectionHero (book detail parity)");
assert(!audioDetail.includes("<SectionNav"), "audio detail renders no SectionNav (book detail parity)");
assert(!merch.includes("view-transition-name: book-cover"), "merch cards carry no cover transition name");
const hooks = read("../src/components/TransitionHooks.astro");
assert(hooks.includes('path.indexOf("/audiobooks/") === 0'), "transition hooks classify audiobook detail pages at detail depth");

// ---- Pass 2 (2026-10-29): audio listing pills, audio detail
// side-by-side, card icon order --------------------------------------
// The listing gets home's category pills with counts computed
// server-side over the audio-published set (home computes its counts
// client-side over the complete-books catalog; different source,
// same pills). The read-aloud intro copy sits above the pills,
// directly under the routes bar.
assert(audio.includes('id="cat-chips"'), "audio listing renders the category pills row");
assert(audio.includes('data-cat={key}') && audio.includes('aria-pressed'), "audio pills carry the category key and pressed state");
assert(audio.includes("const catCounts") && audio.includes("all: items.length"), "audio pill counts are computed over the audio-published set");
assert(audio.includes('id="audio-grid"') && audio.includes("data-topic={b.topic}"), "audio cards carry their topic for client-side filtering");
assert(audio.includes('id="audio-empty"'), "audio listing has the filtered-empty state");
assert(audio.indexOf("Every story on the shelf, read aloud") > -1 && audio.indexOf("Every story on the shelf, read aloud") < audio.indexOf('id="cat-chips"'), "the read-aloud intro copy sits above the pills row");
assert(audio.indexOf("<Fragment set:html={b.badges} />") > -1 && audio.indexOf("<Fragment set:html={b.badges} />") < audio.indexOf("<h3"), "audio cards render the format icons above the title");

// The detail page matches the book detail layout exactly: the same
// max-w-7xl outer container (content lines up under the header
// logo), the same back-link treatment, and the same md:grid-cols-2
// grid capped at max-w-5xl, cover left and the right column carrying
// eyebrow, title, meta, Original line, description, and the slim
// buy block (price + one strong button, the book page's pattern).
// The player, tracks, and upsell align to the same max-w-5xl column
// below. Mobile stacking is the same DOM in one column.
assert(audioDetail.includes('class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8"'), "audio detail uses the book page's outer container");
assert(audioDetail.includes("md:grid-cols-2") && !audioDetail.includes("md:grid-cols-12") && !audioDetail.includes("col-span"), "audio detail uses the book page's two-column grid, not the old 12-column split");
assert(audioDetail.includes("max-w-5xl"), "audio detail caps its grid at the book page's max-w-5xl");
assert(audioDetail.includes("inline-block mt-5 sm:mt-6 py-1 text-sm text-stone-500 hover:text-stone-900"), "audio detail back link matches the book page's style");
assert(audioDetail.includes("const topic = String(book.topic || \"tech\")"), "audio detail derives the shelf eyebrow from the catalog topic");
assert(audioDetail.includes("const description = String(book.description || \"\")"), "audio detail reads the catalog description");
assert(audioDetail.includes("{description &&"), "audio detail renders the description when one exists");
const buyIdx = audioDetail.indexOf('aria-label="Buy this audiobook"');
const colIdx = audioDetail.indexOf("md:grid-cols-2");
const playerIdx = audioDetail.indexOf('aria-label="Free sample player"');
assert(colIdx > -1 && buyIdx > colIdx && buyIdx < playerIdx, "the buy block sits inside the right column, above the player");

console.log(failures === 0 ? "\nALL A2 PAGE TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
