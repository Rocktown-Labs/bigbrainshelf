// Traks analytics wiring (2026-10-29): the taxonomy events from the
// tracking plan must stay wired at their confirmed-success points,
// and the shared component must keep the privacy shape (curated
// props only, no ids fanned out to Traks).
//
// Pins:
//  - Tracking.astro defines the guarded bbsTraks helper, translates
//    the two legacy bbsTrack click events into taxonomy names
//    (add_to_cart with the format, begin_checkout), and no longer
//    fans Meta names or content_ids out to Traks;
//  - the page-event marker carries { ev, traks } and the nav hook
//    applies the once-guard before firing a traks event;
//  - owned downloads are caught by one delegated listener that keeps
//    only the kind (book vs audio);
//  - every taxonomy event is fired from its real surface: book_view
//    and review_submitted (book page), audiobook_view and sample_play
//    (audiobook page), purchase (account success landing + guest
//    order page, both format_mix shaped), club_join_click /
//    club_checkout_start / club_subscribed (clubs), newsletter_
//    signup (footer, success branch only), account_signup (signup,
//    success branch), search (header widget, has_results only),
//    read_start + listen_start (reader).
//
// Assert-style, like the rest of the suite: bun tests/traks.test.ts
import { readFileSync } from "node:fs";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const tracking = src("../src/components/Tracking.astro");
assert(tracking.includes("window.bbsTraks = function"), "Tracking defines the bbsTraks helper");
assert(tracking.includes('window.bbsTraks("add_to_cart", { format:'), "AddToCart translates to add_to_cart with the format");
assert(tracking.includes('window.bbsTraks("begin_checkout", {})'), "InitiateCheckout translates to begin_checkout");
assert(!tracking.includes('if (k !== "value" && k !== "currency")'), "the old pass-everything Traks fan-out is gone");
assert(tracking.includes('marker.ev') && tracking.includes('marker.traks'), "the nav hook reads the combined marker");
assert(tracking.includes('"bbs-traks-once:" + tev.name + ":" + tev.onceKey'), "traks events with a onceKey are refresh-guarded");
assert(tracking.includes('a[href*="/api/download?"], a[href*="/api/order-download?"]'), "owned_download rides one delegated listener");
assert(tracking.includes('"owned_download", { kind:'), "owned_download keeps only the kind");
assert(tracking.includes("traksEvent"), "Tracking accepts a traksEvent prop");

const book = src("../src/pages/books/[slug].astro");
assert(book.includes('traksEvent={{ name: "book_view", props: { topic } }}'), "book page declares book_view with the topic");
assert(book.includes("format: format,"), "book page AddToCart carries the picked format");
assert(book.includes('window.bbsTraks("review_submitted", { rating:'), "review_submitted fires from the book page");

const audio = src("../src/pages/audiobooks/[slug].astro");
assert(audio.includes('traksEvent={{ name: "audiobook_view", props: { topic } }}'), "audiobook page declares audiobook_view");
assert(audio.includes('format: "audio",'), "audiobook page AddToCart carries the audio format");
assert(audio.includes('window.bbsTraks("sample_play", {})'), "sample_play fires from the sample player");

const account = src("../src/pages/account/index.astro");
assert(account.includes('name: "purchase",') && account.includes("format_mix: formats.join(\"+\")"), "account purchase is format_mix shaped");
assert(account.includes("traksEvent={purchaseTraksEvent}"), "account passes its purchase traks event");

const order = src("../src/pages/order.astro");
assert(order.includes("purchaseTraksEvent = {") && order.includes("traksEvent={purchaseTraksEvent}"), "guest order page fires purchase when complete");

const club = src("../src/pages/clubs.astro");
assert(club.includes('name: "club_subscribed",'), "clubs declares club_subscribed for the joined landing");
assert(club.includes('window.bbsTraks("club_join_click", { plan: "physical" })'), "club_join_click fires for The Book Club form");
assert(club.includes('window.bbsTraks("club_join_click", { plan: "audio" })'), "club_join_click fires for The Audio Club form");
assert(club.includes('window.bbsTraks("club_checkout_start", { plan: "physical" })'), "club_checkout_start fires at the physical checkout post");
assert(club.includes('window.bbsTraks("club_checkout_start", { plan: "audio" })'), "club_checkout_start fires at the audio checkout post");

const footer = src("../src/components/SiteFooter.astro");
assert(footer.includes('if (!res.d.already && window.bbsTraks) window.bbsTraks("newsletter_signup", {})'), "newsletter_signup fires only on a confirmed new subscribe");

const signup = src("../src/pages/signup.astro");
assert(signup.includes('window.bbsTraks("account_signup", { method: "email" })'), "account_signup fires on email signup success");

const header = src("../src/components/SiteHeader.astro");
assert(header.includes('window.bbsTraks("search", { has_results: total > 0 ? "yes" : "no" })'), "search fires with has_results only");

const read = src("../src/pages/read/[slug].astro");
assert(read.includes('readTraksEvent = !audioOnly && reader.totalPages > 0 ? { name: "read_start", props: {} } : null'), "read_start is declared only for page-bearing opens");
assert(read.includes('window.bbsTraks("listen_start", {})'), "listen_start fires on first play in the library player");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nALL TRAKS TESTS PASSED");
