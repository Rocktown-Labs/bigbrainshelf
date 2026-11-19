import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("PASS:", msg);
}

const root = resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

// 1. Upcoming books must not show $0.00 above "Available soon."
const bookPage = read("src/pages/books/[slug].astro");
assert(
  bookPage.includes('{buyable && (\n            <span id="price-display"'),
  "book page gates #price-display on buyable",
);
assert(
  bookPage.includes("{buyable ? (\n              <>\n                <p class=\"text-sm mb-1\"><span class=\"font-bold text-lg\">{price}</span>"),
  "sample modal end card gates price lines on buyable",
);

// 2. GlobalPlayer must not emit an empty src="" on #bbs-mini-cover
const globalPlayer = read("src/components/GlobalPlayer.astro");
assert(
  !globalPlayer.includes('id="bbs-mini-cover" src=""'),
  "GlobalPlayer #bbs-mini-cover omits empty src attribute",
);
assert(
  globalPlayer.includes('cover.removeAttribute("src")'),
  "GlobalPlayer removes src attribute when cover is cleared",
);

// 3. SiteFooter back-to-top button is hidden from a11y/keyboard when inactive
const footer = read("src/components/SiteFooter.astro");
assert(
  footer.includes('id="back-to-top" type="button" aria-label="Back to top" aria-hidden="true" tabindex="-1"'),
  "SiteFooter #back-to-top starts aria-hidden and untabbable",
);
assert(
  footer.includes('btn.setAttribute("aria-hidden", on ? "false" : "true")') &&
    footer.includes("btn.tabIndex = on ? 0 : -1"),
  "SiteFooter #back-to-top toggles aria-hidden and tabIndex with visibility",
);

// 4. Empty shelf filter states ship a reset CTA and wrap pills cleanly on mobile
const home = read("src/pages/index.astro");
assert(
  home.includes('id="grid-empty-reset"') && home.includes("Show all books"),
  "home shelf empty state includes a Show all books CTA",
);
assert(
  home.includes('id="cat-chips" class="flex flex-wrap gap-2'),
  "home shelf filter chips wrap cleanly on mobile",
);

const audio = read("src/pages/audiobooks.astro");
assert(
  audio.includes('id="audio-empty-reset"') && audio.includes("Show all audiobooks"),
  "audiobooks empty state includes a Show all audiobooks CTA",
);
assert(
  audio.includes('id="cat-chips" class="flex flex-wrap gap-2'),
  "audiobooks filter chips wrap cleanly on mobile",
);

// 5. No em dashes in storefront <title> or SeoHead titles
const titledFiles = [
  "src/components/SeoHead.astro",
  "src/pages/index.astro",
  "src/pages/audiobooks.astro",
  "src/pages/audiobooks/[slug].astro",
  "src/pages/books/[slug].astro",
  "src/pages/clubs.astro",
  "src/pages/clubs/book-club.astro",
  "src/pages/clubs/audio-club.astro",
  "src/pages/meet-the-cast.astro",
  "src/pages/meet-the-cast/[character].astro",
  "src/pages/about.astro",
  "src/pages/shipping.astro",
  "src/pages/merch.astro",
  "src/pages/contact.astro",
  "src/pages/privacy.astro",
  "src/pages/terms.astro",
];
for (const file of titledFiles) {
  const src = read(file);
  assert(
    !src.includes("— Big Brain Shelf") && !src.includes("Big Brain Shelf —"),
    `${file} has no em dash in page title`,
  );
}

console.log("\nALL STOREFRONT AUDIT FIX TESTS PASSED");
