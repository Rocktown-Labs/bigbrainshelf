// Lock model surface pins (CG, 2026-10-29): membership is read +
// listen access in the library; downloads belong to owned books
// (bought, or arrived in a shipped club box). The entitlement behavior
// itself is pinned in library.test.ts and club-plans.test.ts; this
// file pins the surfaces that consume the owned marker, plus the
// approved Audio Club prices ($5.99/mo, $49/yr) and the revised copy
// that stopped promising member downloads.
// Run with: bun tests/lock-model.test.ts
import {
  AUDIO_CLUB_PRICE_CENTS,
  AUDIO_CLUB_ANNUAL_PRICE_CENTS,
  clubPriceLabel,
} from "../src/lib/offers";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
const read = async (rel: string) =>
  Bun.file(new URL(rel, import.meta.url)).text();

// ---- Prices -----------------------------------------------------------------
assert(AUDIO_CLUB_PRICE_CENTS === 599, "audio club monthly constant is 599");
assert(AUDIO_CLUB_ANNUAL_PRICE_CENTS === 4900, "audio club annual constant is 4900");
assert(clubPriceLabel(AUDIO_CLUB_PRICE_CENTS) === "$5.99", "audio club monthly renders $5.99");
assert(`$${Math.round(AUDIO_CLUB_ANNUAL_PRICE_CENTS / 100)}` === "$49", "audio club annual renders $49 whole");

const offersSrc = await read("../src/lib/offers.ts");
assert(offersSrc.includes("PRICES APPROVED BY CG, 2026-10-29"), "offers records the owner's price approval");
assert(!offersSrc.includes("CG-PENDING"), "offers no longer flags the club prices as pending");

// ---- Download route ---------------------------------------------------------
const downloadSrc = await read("../src/pages/api/download.ts");
assert(downloadSrc.includes("entitlementDownloads"), "download route gates on the ownership helper");
assert(downloadSrc.includes('error: "You don\'t own this book yet."'), "download refusal keeps the non-owner shape (403, same message)");
assert(!downloadSrc.includes("ent?.audio === true : ent?.digital === true"), "download route no longer serves on raw access flags");

// ---- My Shelf UI --------------------------------------------------------------
const accountSrc = await read("../src/pages/account/index.astro");
assert(accountSrc.includes("The books you own are yours to download and keep."), "shelf subline names ownership as the download rule");
assert(accountSrc.includes("b.owned && b.audiobook_key"), "shelf: the audiobook download renders only for owned listen-only entries");
assert(accountSrc.includes("{b.owned ? ("), "shelf: download rows and the unlock button render only for owned entries");

// ---- Reader page ---------------------------------------------------------------
const readerSrc = await read("../src/pages/read/[slug].astro");
assert(readerSrc.includes("if (entitlement.owned)"), "reader: the downloads block renders only for owned books (reading and streaming untouched)");

// ---- The upgrade credit keys off ownership, never membership -------------------
const checkoutSrc = await read("../src/pages/api/checkout.ts");
assert(checkoutSrc.includes("ent?.owned === true && ent?.audio === true"), "checkout passes owned-derived audio flags to the pricer (no member credit)");
assert(checkoutSrc.includes("ent?.owned === true && ent?.digital === true"), "checkout passes owned-derived digital flags to the pricer");
const cartSrc = await read("../src/pages/checkout.astro");
assert(cartSrc.includes("e.owned && !e.digital && e.audio"), "checkout upgrade prices qualify on owned audio only");
const bookPageSrc = await read("../src/pages/books/[slug].astro");
assert(bookPageSrc.includes("ent.owned && !ent.digital && ent.audio"), "book page upgrade price qualifies on owned audio only");

// ---- Copy: no surface promises member downloads ---------------------------------
const clubPageSrc = await read("../src/pages/clubs.astro");
assert(clubPageSrc.includes("the whole shelf opens in your library") && clubPageSrc.includes("The club book is yours to keep digitally, even if you cancel."), "book club card carries the lock-model revision (member access vs owned-and-kept; the fuller download-and-keep wording lives on /clubs/book-club)");
assert(clubPageSrc.includes("Listen in the reader, as much as you like, while you are a member."), "audio club bullet carries the lock-model revision");
assert(clubPageSrc.includes("{audioMonthlyLabel} a month, or {audioAnnualWholeLabel} a year."), "audio card price line renders monthly label + whole-dollar annual");
assert(!clubPageSrc.includes("read, listen, and download"), "plans page no longer promises member downloads");
assert(!clubPageSrc.includes("Listen in the reader, or download the audiobook files."), "plans page audio bullet no longer promises downloads");

const clubCheckoutSrc = await read("../src/pages/api/club/checkout.ts");
assert(clubCheckoutSrc.includes("listen in the reader, as much as you like"), "club checkout product description carries the revision");
assert(!clubCheckoutSrc.includes("download the audiobook files"), "club checkout no longer promises member downloads");

const audioPageSrc = await read("../src/pages/audiobooks/[slug].astro");
assert(audioPageSrc.includes("Joining The Audio Club unlocks every chapter in your library for as long as your membership is active."), "audiobook page separates buying (downloads) from membership (library access)");
assert(audioPageSrc.includes("Buying the audiobook unlocks every chapter in your library, plus the downloadable files."), "audiobook page keeps the purchase promise intact");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nALL LOCK MODEL TESTS PASSED");
