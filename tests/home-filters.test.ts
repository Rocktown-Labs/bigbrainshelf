// Home shelf filter, A2 redesign (2026-10-29): the Topics sidebar and
// the Filters UI are gone entirely (desktop included), replaced by
// the category pill row (All / Tech / Money / Courage with counts)
// under the shared hero and routes bar. The pills filter the shelf in
// place by the book's shelf category; format remains information on
// the cards as icon-only includes badges. The shelf script is an
// inline browser script, so these are source-level pins in the same
// style as the books-public consumer checks. Run with:
//   bun tests/home-filters.test.ts
import { readFileSync } from "node:fs";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const src = readFileSync(new URL("../src/pages/index.astro", import.meta.url), "utf8");
// The home shelf script ends where the cart sheet begins; cart format
// strings (printed/giftset/audio purchase formats) are not the filter.
const home = src.split("<!-- cart-sheet")[0];

// ---- Shared hero + routes bar --------------------------------------
assert(home.includes("SectionHero"), "home renders the shared SectionHero");
assert(home.includes('subline="Picture, coloring, and audio books on tech, money, and courage, told so kids can get it."'), "home hero carries the A2 home subline");
assert(home.includes('<SectionNav active="books" />'), "home renders the routes bar with Books active");
assert(!home.includes("Picture books and coloring books on tech"), "the old hero wording is gone");

// ---- Topics sidebar + Filters UI are gone ---------------------------
assert(!home.includes('id="topic-filters"'), "no Topics chip container remains");
assert(!home.includes("renderTopicFilters"), "topic filter rendering is gone");
assert(!home.includes("TOPIC_CAP"), "no topic cap logic remains");
assert(!home.includes("topic-chip"), "no topic chips remain");
assert(!home.includes('id="topics-clear"'), "no Topics Clear action remains");
assert(!home.includes('id="filters-toggle"'), "no Filters disclosure button remains");
assert(!home.includes('id="filters-panel"'), "no Filters panel remains");
assert(!home.includes(">Topics<"), "no Topics heading remains");
assert(!home.includes('id="tabs"'), "the old category tab bar is gone");
assert(!home.includes("state.topics"), "multi-topic state removed from the shelf script");
assert(!home.includes("state.picture") && !home.includes("state.coloring"), "no format filter state in the shelf script");
assert(!home.includes(">Age<"), "the Age note left with the rail");

// ---- Category pills: the four shelves, counts, single-select --------
assert(home.includes('id="cat-chips"'), "the category pill row exists");
for (const cat of ["all", "tech", "money", "courage"]) {
  assert(home.includes(`data-cat="${cat}"`), `server-rendered pill for ${cat}`);
}
assert(home.includes('var CATS = [["all", "All"], ["tech", "Tech"], ["money", "Money"], ["courage", "Courage"]]'), "the pill script knows the same four categories");
assert(home.includes("function catCounts()"), "per-category book counts are computed");
assert(home.includes("counts[c[0]]"), "pills render their counts");
assert(home.includes("function paintChips()"), "pills repaint on selection and load");
assert(home.includes('aria-pressed'), "pills expose their selected state");
assert(home.includes('state.topic = btn.getAttribute("data-cat")'), "a pill click selects exactly one category");
assert(home.includes('if (state.topic !== "all" && (b.topic || "tech") !== state.topic) return false;'), "the shelf filters by the selected category in place");

// ---- Search hook still filters the shelf in place -------------------
assert(home.includes("window.__bbsHomeSearch"), "home search Enter-to-filter hook still registered");
assert(home.includes("state.q = value;"), "search still sets the shelf query");

// ---- Includes badges on the cards (icon-only) -----------------------
assert(home.includes("badgeRow(b)"), "cards render the includes-badge row");
assert(home.includes('name: "Story book"') && home.includes("b.has_picture_book"), "Story badge driven by has_picture_book");
assert(home.includes('name: "Coloring book"') && home.includes("b.has_coloring_book"), "Coloring badge driven by has_coloring_book");
assert(home.includes('name: "Audiobook"') && home.includes("b.has_audiobook"), "Audio badge driven by has_audiobook");
assert(home.includes("min-h-[30px]") && home.includes("lg:min-h-[20px]"), "badge row reserves exactly one badge line when a badge is absent");
assert(home.includes("bg-green-100 text-green-800") && home.includes("bg-amber-100 text-amber-800") && home.includes("bg-red-100 text-red-800"), "badges carry the format colors: story green, coloring amber, audio red");
assert(home.includes('audio: \'<svg width="18" height="18"'), "the audio glyph is drawn 2px larger than the other card glyphs");
assert(home.includes("/just-buy-it.webp"), "cards keep the deterrent overlay on cover art");

// Icon-only: the format name lives in title/aria-label attributes,
// never as a visible text node next to the icon.
const badgeRowSrc = home.slice(home.indexOf("function badgeRow"), home.indexOf("function visible"));
assert(badgeRowSrc.includes('aria-label="What this book includes"'), "badge row carries the What this book includes aria-label");
assert(badgeRowSrc.includes('title="') && badgeRowSrc.includes('aria-label="'), "each badge names its format in title and aria-label");
assert(badgeRowSrc.includes('role="listitem"'), "each badge is a listitem in the formats list");
assert(!badgeRowSrc.includes("esc(bd"), "no badge label text is rendered as visible text");
assert(badgeRowSrc.includes('bd.icon + "</span>"'), "badge markup is the icon alone inside the pill");

// ---- Book page includes row (icon-only) -----------------------------
const bookPage = readFileSync(new URL("../src/pages/books/[slug].astro", import.meta.url), "utf8");
const includesRow = bookPage.slice(
  bookPage.indexOf('aria-label="What this book includes"'),
  bookPage.indexOf('id="price-display"')
);
assert(includesRow.length > 0, "book page includes row found above the price");
for (const fmt of ["Story book", "Coloring book", "Audiobook"]) {
  assert(includesRow.includes(`title="${fmt}"`), `book page badge names ${fmt} in title`);
  assert(includesRow.includes(`aria-label="${fmt}"`), `book page badge names ${fmt} in aria-label`);
  assert(!new RegExp(`>\\s*${fmt}\\s*<`).test(includesRow), `book page badge shows no visible "${fmt}" text`);
}
assert(includesRow.includes("book.picture_book_key") && includesRow.includes("book.coloring_book_key") && includesRow.includes("book.audiobook_key"), "book page badges stay conditional on the book's files");
assert(includesRow.includes("bg-green-100 text-green-800") && includesRow.includes("bg-amber-100 text-amber-800") && includesRow.includes("bg-red-100 text-red-800"), "book page badges carry the same format colors as the cards");
assert(includesRow.includes("w-[18px] h-[18px]"), "book page audio glyph is drawn 2px larger than the other glyphs");

// ---- Card order (pass 2, 2026-10-29): cover, icons, title, price --
// In the home card template the badge row renders above the title.
assert(home.indexOf("badgeRow(b) +") > -1 && home.indexOf("badgeRow(b) +") < home.indexOf("'<h3 class="), "home cards render the format icons above the title");

if (failures) { console.error(`${failures} assertion(s) failed`); process.exit(1); }
console.log("All home-filters assertions passed");
