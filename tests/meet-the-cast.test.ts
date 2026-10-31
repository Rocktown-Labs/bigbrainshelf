// Meet the Cast index redesign (2026-10-28): stats sit directly under
// the title with the intro below them; the shelf pill filters and the
// per-card shelf badges are gone, replaced by shelf sections whose
// titles are the separators; on mobile each book's cast is a snap
// scroller; A to Z shows one letter at a time, its characters in a
// horizontal scrolling row (2026-10-30); its letter chips only
// cover letters the cast actually has. The page is server-rendered
// Astro with an inline browse script, so these are source-level pins
// (same style as home-filters.test.ts) plus data checks against the
// baked gallery manifest. Run with: bun tests/meet-the-cast.test.ts
import { readFileSync } from "node:fs";
import { bookGroups, type CastMember } from "../src/lib/cast-public";
import { bakedManifest } from "../src/lib/cast-gallery";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const src = readFileSync(new URL("../src/pages/meet-the-cast.astro", import.meta.url), "utf8");

// ---- Order: title, then stats, then the intro paragraph -----------
const iTitle = src.indexOf("Meet the");
const iStats = src.indexOf('aria-label="The cast at a glance"');
const iIntro = src.indexOf("Every Big Brain Shelf story is carried by an animal");
assert(iTitle !== -1 && iStats > iTitle, "stats block comes after the title block");
assert(iIntro > iStats, "intro paragraph sits below the stats cards");

// ---- Shelf badges and shelf pill filters are gone ------------------
assert(!src.includes("shelf-pill"), "no shelf pill filter buttons remain");
assert(!src.includes("data-shelf"), "no shelf filter state remains");
assert(!src.includes("All shelves"), "no All shelves pill remains");
assert(!src.includes("bg-orange-100 text-orange-700 px-2 py-0.5"), "no per-card shelf badge pill on cast cards");
assert(!src.includes("shelf</span>"), "no '{topic} shelf' pill on book subheaders");
assert(!src.includes("cast-flash"), "old letter-jump flash styling removed with the grid A-Z view");
assert(!src.includes('"ABCDEFGHIJKLMNOPQRSTUVWXYZ"'), "full-alphabet letter strip no longer rendered");
assert(src.includes('"In the workshop"') && src.includes("In the workshop</span>"), "workshop tag kept on the workshop group");

// ---- Toggle row: By shelf / A to Z only ----------------------------
assert(src.includes('data-view="shelves"') && src.includes("By shelf"), "toggle offers By shelf");
assert(src.includes('data-view="az"') && src.includes("A to Z"), "toggle offers A to Z");
assert(src.includes('id="letter-strip"') && src.includes('class="hidden flex-wrap'), "letter strip starts hidden (never renders in By-shelf mode)");
assert(src.includes('letterStrip.classList.toggle("flex", v === "az")'), "letter strip only appears in A to Z mode");

// ---- Shelf sections: headings are the separators, books nested -----
assert(src.includes("SHELF_ORDER = [\"Tech\", \"Money\", \"Courage\"]"), "shelves render in the established Tech/Money/Courage order");
assert(src.includes("shelfSections") && src.includes("`${topic} Shelf`"), "shelf sections built with Shelf headings");
assert(src.includes("g.workshop") && src.includes('heading: "In the workshop"'), "workshop books form their own closing section");
assert(src.includes('class="cast-shelf') && src.includes("s.heading"), "shelf section headings rendered as separators");
assert(src.includes("TOPIC_TINTS[s.topic]"), "shelf heading band uses the shelf tint family");
assert(src.includes("/books/${g.bookPublicSlug}"), "book subheads link via the public book slug");
assert(src.includes("See the book"), "book subheads keep the See the book link");

// ---- Mobile scroller, desktop grid ---------------------------------
assert(src.includes("cast-row") && src.includes("overflow-x-auto") && src.includes("snap-x snap-mandatory"), "book cast rows are horizontal snap scrollers");
assert(src.includes("w-[72%]") && src.includes("snap-start") && src.includes("shrink-0"), "mobile cards are ~72% wide with the next card peeking");
assert(src.includes("md:grid") && src.includes("md:overflow-visible"), "desktop returns to a grid");

// ---- Deterrent overlay preserved in every rendered card ------------
// (The overlay image itself switched PNG -> WebP on 2026-10-30; the
// PNG still exists for the media worker's hotlink deterrent.)
const overlays = src.split("/just-buy-it.webp").length - 1;
assert(overlays === 3, `deterrent overlay present on shelf cards, Otter tile, and A-Z cards (got ${overlays})`);
assert(src.includes("c.portraitCard || c.portrait"), "cards keep the WebP portrait derivative with full-size fallback");

// ---- A to Z: one full grid, letter chips as jump links ------------
// (Grid trial 2026-10-31 at CG's word, replacing the letter pager
// the 2026-10-30 pins below used to describe.)
assert(src.includes("azGroups") && src.includes("az-group"), "cast is grouped by letter");
assert(src.includes("sm:grid sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4"), "every letter renders its cast as a full grid from sm up");
assert(src.includes("cast-row flex flex-nowrap gap-4 overflow-x-auto snap-x snap-mandatory") && src.includes("w-[72%] sm:w-auto"), "on phones each letter section is a horizontal snap scroller, same as the By shelf rails");
assert(src.includes("az-letter-${g.letter}") && src.includes("scroll-mt-48"), "each letter group is a scroll anchor that clears the sticky chrome");
assert(!src.includes("az-prev") && !src.includes("az-next") && !src.includes("az-counter"), "the letter pager is gone in the grid trial");
assert(!src.includes("az-slide"), "one-card-at-a-time slides stay gone from A to Z");
assert(src.includes("scrollIntoView"), "letter chips jump to their letter section");
assert(src.includes("IntersectionObserver") && src.includes("paintLetters") && src.includes("data-letter"), "a scrollspy keeps the active letter chip tracking the section in view");
assert(src.includes("az-rail") && src.includes("hidden md:flex"), "on md+ the alphabet lives in a sticky sidebar rail (top strip remains for phones)");
assert(src.includes("<SectionHero"), "the cast route carries the shared branding hero on top, like the other section pages");

// ---- Letter chips == letters present in the cast data only ---------
const letterOf = (name: string) => name.replace(/^the /i, "").charAt(0).toUpperCase();
const baked = bakedManifest();
const dataLetters = [...new Set(Object.values(baked.characters).map((c: any) => letterOf(String(c.name))))].sort();
assert(
  JSON.stringify(dataLetters) === JSON.stringify(["A", "B", "C", "D", "F", "H", "J", "M", "N", "O", "P", "R", "S", "T", "W"]),
  `chips cover exactly the cast's letters (got ${dataLetters.join(",")})`
);
assert(src.includes("azLetters") && src.includes("[...presentLetters].sort()"), "page derives its chips from the letters present in the cast");
assert(src.includes("azLetters.map"), "chips render from the present-letters list only");

// ---- Grouping logic: books nest under their shelf, workshop last ---
function member(partial: Partial<CastMember>): CastMember {
  return partial as CastMember;
}
const fake = [
  member({ slug: "zed", name: "Zed", bookSlug: "zbook", bookPublicSlug: "zbook-public", bookTitle: "Zed Book", topic: "Money", workshop: false }),
  member({ slug: "amy", name: "Amy", bookSlug: "abook", bookPublicSlug: "abook-public", bookTitle: "Amy Book", topic: "Tech", workshop: false }),
  member({ slug: "wes", name: "Wes", bookSlug: "wbook", bookPublicSlug: "wbook-public", bookTitle: "Wes Book", topic: "Money", workshop: true }),
];
const gs = bookGroups(fake);
assert(gs.length === 3 && gs[gs.length - 1].workshop === true, "bookGroups keeps the workshop book last");
assert(gs[0].bookTitle === "Amy Book" && gs[1].bookTitle === "Zed Book", "bookGroups orders published books by title within the page flow");

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nAll meet-the-cast assertions passed");
