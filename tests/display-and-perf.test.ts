// Pass 3 display rules + pass 1 performance pins (2026-10-29).
//
// Pass 3: a book is NAMED for a human by its public title from the
// books table, everywhere, admin included. The internal slug (which
// names the source material) may live only in URLs, storage keys,
// and code, never as a displayed label, and never in a download
// filename (the buyer keeps the file forever). The three production
// test orders are the fixture: mastery digital, mastery audio, and
// richdadpoordad audio must render as Mira and Penny titles.
//
// Pass 1: the edge-cache allowlist and session bypass, the Astro
// prefetch config, and the middleware wiring are pinned here; the
// decoy contract itself is pinned in audio-sample.test.ts.
// Run with: bun tests/display-and-perf.test.ts
import { readFileSync } from "node:fs";
import { orderItemLabels, orderFormatLabel, shortOrderId, shortBookName, orderPickList } from "../src/lib/orders";
import { downloadBaseName } from "../src/lib/download-names";
import { isEdgeCacheablePath, hasSessionCookie } from "../src/lib/edge-cache";
import { parseTrackParam, serveAudiobookTrack } from "../src/lib/audiobooks";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ---- orderItemLabels against a fixture shaped like production -----
const TITLES: Record<string, string> = {
  mastery: "Mira the Heron and the Still Water",
  richdadpoordad: "Penny the Squirrel and the Acorn Orchard",
};
const fakeDb = {
  prepare: (_sql: string) => ({
    bind: (...args: any[]) => ({
      all: async () => ({
        results: args
          .filter((a) => TITLES[String(a)])
          .map((a) => ({ slug: String(a), title: TITLES[String(a)] })),
      }),
    }),
  }),
};
const labels = await orderItemLabels(fakeDb, [
  { id: "o-penny-audio", items: '[{"slug":"richdadpoordad","format":"audio"}]', book_slugs: '["richdadpoordad"]' },
  { id: "o-mira-audio", items: '[{"slug":"mastery","format":"audio"}]', book_slugs: '["mastery"]' },
  { id: "o-mira-digital", items: '[{"slug":"mastery","format":"digital"}]', book_slugs: '["mastery"]' },
  { id: "o-legacy", items: null, book_slugs: '["mastery"]' },
  { id: "o-gone", items: '[{"slug":"deletedbook","format":"digital"}]', book_slugs: '["deletedbook"]' },
]);
assert(labels.get("o-penny-audio")?.[0] === "Penny the Squirrel and the Acorn Orchard (audiobook only)", "admin orders: the richdadpoordad audio order renders as the Penny title with its format label");
assert(labels.get("o-mira-audio")?.[0] === "Mira the Heron and the Still Water (audiobook only)", "admin orders: the mastery audio order renders as the Mira title");
assert(labels.get("o-mira-digital")?.[0] === "Mira the Heron and the Still Water (digital)", "admin orders: the mastery digital order renders as the Mira title");
assert(labels.get("o-legacy")?.[0] === "Mira the Heron and the Still Water", "a legacy order with only book_slugs renders titles with no format suffix");
assert(labels.get("o-gone")?.[0] === "Big Brain Shelf book (digital)", "a missing book row renders a neutral label, never the raw slug");
for (const [id, list] of labels) {
  for (const line of list) {
    assert(!line.includes("richdadpoordad") && !line.includes("mastery") && !line.includes("deletedbook"), `no internal slug appears in the label for ${id}`);
  }
}
assert(orderFormatLabel("printed").startsWith("full color printed"), "printed format label matches the email wording");
assert(orderFormatLabel("giftset").startsWith("gift set"), "gift set format label matches the email wording");

// ---- Pick list (2026-10-29): short names + counts for the rows ----
// The operator fulfills by character name ("1 Penny, 2 Miras"), so
// the list summary groups identical slug+format items under the
// short name (the title up to " the ") with a count.
assert(shortBookName("Penny the Squirrel and the Acorn Orchard") === "Penny", "short name is the title up to ' the '");
assert(shortBookName("Mira the Heron and the Still Water") === "Mira", "short name for Mira");
assert(shortBookName("Big Brain Shelf book") === "Big Brain Shelf book", "a title without ' the ' is returned whole");
const picks = await orderPickList(fakeDb, [
  { id: "o-pick-1", items: '[{"slug":"mastery","format":"digital"},{"slug":"mastery","format":"digital"},{"slug":"richdadpoordad","format":"audio"}]', book_slugs: '["mastery","richdadpoordad"]' },
  { id: "o-pick-2", items: null, book_slugs: '["mastery"]' },
  { id: "o-pick-3", items: '[{"slug":"deletedbook","format":"printed"}]', book_slugs: '["deletedbook"]' },
]);
const p1 = picks.get("o-pick-1") || [];
assert(p1.length === 2 && p1[0].name === "Mira" && p1[0].format === "digital" && p1[0].count === 2, "pick list groups identical slug+format items into a count (2 Mira, digital)");
assert(p1[1].name === "Penny" && p1[1].format === "audio" && p1[1].count === 1, "pick list keeps first-seen order and formats (1 Penny, audio)");
assert(p1[0].title === "Mira the Heron and the Still Water", "pick groups still carry the full public title for the detail page");
const p2 = picks.get("o-pick-2") || [];
assert(p2.length === 1 && p2[0].name === "Mira" && p2[0].format === "digital" && p2[0].count === 1, "a legacy book_slugs-only order pick-lists as digital");
const p3 = picks.get("o-pick-3") || [];
assert(p3.length === 1 && p3[0].name === "Big Brain Shelf book" && !JSON.stringify(p3).includes("deletedbook"), "a missing book row pick-lists under the neutral label, never the raw slug");

// ---- The admin orders payload + page carry titles, not slugs -------
const adminOrdersApi = read("../src/pages/api/admin/orders.ts");
assert(adminOrdersApi.includes("orderItemLabels") && adminOrdersApi.includes("items_display"), "the admin orders API resolves item titles server-side");
const adminOrdersPage = read("../src/pages/admin/orders.astro");
assert(adminOrdersPage.includes("items_display"), "the admin orders page renders the resolved item labels");
assert(!adminOrdersPage.includes("i.slug") && !adminOrdersPage.includes("o.book_slugs"), "the admin orders page has no slug-rendering path left");

// ---- Operator redesign (2026-10-29): the orders list is a slim
// table (Date | Order ID | Items | Price | Format circles), rows
// led by the short order id, never a timestamp header.
assert(shortOrderId("a1b2c3d4-e5f6-4789-abcd-0123456789ab") === "#A1B2C3D4", "short order id is '#' + the first eight id characters, uppercased");
assert(shortOrderId("") === "#", "short order id tolerates an empty id");
assert(adminOrdersApi.includes("shortOrderId") && adminOrdersApi.includes("short_id"), "the admin orders API attaches the short id to each row");
assert(adminOrdersPage.includes("o.short_id"), "the orders list renders the short id as the row lead");
assert(adminOrdersPage.includes("<table") && adminOrdersPage.includes("otable") && adminOrdersPage.includes('id="orders-rows"'), "the orders list is a slim fixed-layout table");
assert(adminOrdersPage.includes("stagePill") && adminOrdersPage.includes("covers-line"), "the orders list renders small real covers and the derived stage pill (orders redo, CG 2026-11-10)");
assert(adminOrdersPage.includes(".covers-line img{width:26px;height:34px"), "list cover thumbnails carry fixed CSS sizes so they cannot balloon");
const globalCss = read("../src/styles/global.css");
assert(globalCss.includes(".fcircle svg") && globalCss.includes("width: 14px") && globalCss.includes(".fchip svg") && globalCss.includes("width: 11px"), "the global stylesheet pins chip and circle SVG sizes for injected DOM");
assert(globalCss.includes(".fmt-giftset") && globalCss.includes(".orderband") && globalCss.includes(".ptable"), "the shared format system and order-template styles live in the global stylesheet");
assert(globalCss.includes("#user-account-menu-wrap:not(.hidden)") && globalCss.includes("#account-link"), "mobile header: the My library pill steps aside when the account chip is showing (CG, 2026-11-07)");
assert(!adminOrdersPage.includes("fmtDate(o.created_at)"), "the orders list no longer leads with a full timestamp");
assert(!adminOrdersPage.includes("pre-orders"), "the orders header no longer calls live orders pre-orders");
const adminOrderDetail = read("../src/pages/admin/orders/[id].astro");
assert(adminOrderDetail.includes("AdminShell") && adminOrderDetail.includes("order_id="), "the order detail page loads its order through the admin API");
assert(adminOrderDetail.includes("Emails for this order") && adminOrderDetail.includes("Print shipping label"), "the order detail carries the email history and the label print action");
assert(adminOrdersApi.includes("email_outbox") && adminOrdersApi.includes("WHERE order_id = ?"), "the admin orders API returns the order's email history");

// ---- Pick-list rows + tabs (2026-10-29) -----------------------------
assert(adminOrdersApi.includes("orderPickList") && adminOrdersApi.includes("items_pick"), "the admin orders API resolves the pick list server-side");
assert(adminOrdersPage.includes("items_pick") && adminOrdersPage.includes("contentsHtml"), "the orders list renders covers + item naming in the contents cell, never status chatter");
assert(adminOrdersPage.includes("KIND_LABELS") && adminOrdersPage.includes("Printed (POD)"), "each order carries its kind label on the list (Digital / Printed (POD) / Club)");
assert(adminOrdersPage.includes('giftset: "gift set"'), "the gift set names as its own item in the contents cell (orders redo naming)");
assert(adminOrdersPage.includes("stagePill(o.stage)"), "stage language lives in the Stage column only, not the contents cell (CG, 2026-11-10)");
assert(!adminOrdersPage.includes("esc(fmtItems(o))"), "the row summary no longer renders full title labels");
assert(adminOrdersApi.includes("tabCounts") && adminOrdersApi.includes("TAB_WHERE"), "the orders API classifies the filter tabs server-side");
assert(adminOrdersPage.includes('id="kind-chips"') && adminOrdersPage.includes('data-saved="stuck"') && adminOrdersPage.includes('data-saved="manual_waiting"'), "the orders list carries kind chips and saved filters (orders redo)");
assert(adminOrdersApi.includes("per_page") && adminOrdersPage.includes('id="per-page"') && adminOrdersPage.includes('id="orders-pager"'), "the orders list paginates server-side, 10 per page by default with a 10/25/50 selector (prototype v3)");

// ---- Order detail rebuild (2026-10-29): the "Order history"
// template (summary band + products table), the raw UUID and the
// Stripe reference de-emphasized at the very bottom.
assert(adminOrdersApi.includes("items_detail"), "the detail payload carries structured items (title, format, count)");
assert(adminOrderDetail.includes("items_detail") && adminOrderDetail.includes("fchip"), "the detail products table renders full titles with the shared format chips");
assert(adminOrderDetail.includes("orderband") && adminOrderDetail.includes("Date placed") && adminOrderDetail.includes("Total amount"), "the detail page leads with the template summary band");
assert(adminOrderDetail.includes("View Product") && adminOrderDetail.includes("stagePill") && adminOrderDetail.includes("Status notes"), "detail lines carry the derived stage pill; status prose lives in the Status notes section (orders redo)");
assert(adminOrderDetail.includes("g.cover") && adminOrderDetail.includes("g.href") && adminOrderDetail.includes("g.unitCents"), "detail product rows dress groups with cover, product link, and unit price");
const picksDressed = await orderPickList(fakeDb, [
  { id: "o-dress", items: '[{"slug":"mastery","format":"digital"}]', book_slugs: '["mastery"]' },
]);
const dress = (picksDressed.get("o-dress") || [])[0] as any;
assert(dress && "cover" in dress && "href" in dress && "unitCents" in dress, "pick groups carry the template dressing fields");
const guestOrderPage = read("../src/pages/order.astro");
assert(guestOrderPage.includes("orderband") && guestOrderPage.includes("orderblock") && guestOrderPage.includes("View Product"), "the guest order page renders the same order block");
assert(guestOrderPage.includes("Go to my library") && guestOrderPage.includes("signedIn"), "the guest order band action is the library link for signed-in buyers only");
const accountPage = read("../src/pages/account/orders.astro");
assert(accountPage.includes("orderViews.map") && accountPage.includes("bg-[#faf6ef]") && accountPage.includes("Date placed") && accountPage.includes("View receipt"), "the account order history renders each order as the same block with its receipt action");
assert(adminOrderDetail.includes("Order details") && adminOrderDetail.indexOf("Order details") > adminOrderDetail.indexOf("Emails for this order"), "the Order details reference block sits at the very bottom, below the emails card");
assert(!adminOrderDetail.includes('esc(o.id) + " · "'), "the detail header no longer renders the raw UUID under the title");
assert(adminOrderDetail.includes("Checkout never completed"), "a pending order says so plainly near the top");
assert(adminOrderDetail.includes("nothing to pack or ship"), "a digital/audio order shows the delivered-automatically note instead of fulfillment machinery");

// ---- Download filenames never carry the internal slug --------------
assert(downloadBaseName({ public_slug: "penny-the-squirrel-and-the-acorn-orchard", title: "Penny the Squirrel and the Acorn Orchard" }) === "penny-the-squirrel-and-the-acorn-orchard", "download base name is the public slug");
assert(downloadBaseName({ public_slug: null, title: "Penny the Squirrel and the Acorn Orchard" }) === "penny-the-squirrel-and-the-acorn-orchard", "download base name falls back to the slugified title");
assert(downloadBaseName({}) === "big-brain-shelf-book", "download base name has a neutral last resort, never a slug parameter");
for (const rel of ["../src/pages/api/download.ts", "../src/pages/api/admin-download.ts"]) {
  const src = read(rel);
  assert(src.includes("downloadBaseName"), `${rel} builds its filename from downloadBaseName`);
  assert(!src.includes("${slug}-") && !src.includes("${slug}."), `${rel} never interpolates the internal slug into a filename`);
}
// The legacy token route serves no files at all since the
// auth-backed download change (2026-10-31): it redirects into the
// library, so it builds no filename and names no slug.
const legacyDl = read("../src/pages/api/order-download.ts");
assert(legacyDl.includes('Location: "/account"') && !legacyDl.includes("downloadBaseName"), "legacy order-download redirects to the library and builds no filename");
// The M4B download (admin audiobook route) wears the public name too.
const FILES = new Map<string, Uint8Array>([["books/richdadpoordad/audiobook.m4b", new Uint8Array(4000)]]);
const fakeBooks = {
  head: async (k: string) => (FILES.has(k) ? { size: FILES.get(k)!.length } : null),
  get: async (k: string) => (FILES.has(k) ? { body: FILES.get(k)! } : null),
};
const m4b = await serveAudiobookTrack({
  books: fakeBooks, audiobookKey: "books/richdadpoordad/audiobook.m4b", slug: "richdadpoordad",
  filenameBase: downloadBaseName({ public_slug: "penny-the-squirrel-and-the-acorn-orchard", title: "Penny the Squirrel and the Acorn Orchard" }),
  track: parseTrackParam("m4b")!, method: "GET", rangeHeader: null, allowDownload: true,
});
const disposition = m4b.headers.get("Content-Disposition") || "";
assert(disposition.includes("penny-the-squirrel-and-the-acorn-orchard-audiobook.m4b"), "the M4B download filename is the public name");
assert(!disposition.includes("richdadpoordad"), "the M4B download filename contains no internal slug");

// ---- Remaining slug-as-label fallbacks are gone ---------------------
const account = read("../src/pages/account/index.astro");
assert(!account.includes("?.title || it.slug"), "account order history never falls back to the slug as a title");
const releases = read("../src/lib/releases.ts");
assert(!releases.includes("title || book.slug") && !releases.includes("b.title || b.slug"), "release announcements never fall back to the slug as a title");
const characters = read("../src/pages/admin/characters.astro");
assert(!characters.includes("c.source"), "the admin character list no longer prints the registry source citation");
const characterDetail = read("../src/pages/admin/characters/[id].astro");
assert(!characterDetail.includes("row.source"), "the admin character page no longer prints the registry source citation");

// ---- Pass 1: edge cache allowlist + session bypass ------------------
for (const p of ["/", "/audiobooks", "/audiobooks/fern-the-fox-and-the-clever-trails", "/books/mira-the-heron-and-the-still-water", "/merch", "/clubs", "/meet-the-cast", "/meet-the-cast/mira"]) {
  assert(isEdgeCacheablePath(p), `edge-cacheable: ${p}`);
}
for (const p of ["/account", "/admin", "/admin/orders", "/api/books", "/api/search", "/read/mira-the-heron-and-the-still-water", "/order", "/cart", "/checkout", "/login", "/signup", "/audiobooks/a/b", "/books", "/meet-the-cast/a/b"]) {
  assert(!isEdgeCacheablePath(p), `never edge-cached: ${p}`);
}
assert(hasSessionCookie("admin_session=abc.def"), "the admin session cookie bypasses the edge cache");
assert(hasSessionCookie("foo=1; bbs.session_token=xyz"), "a better-auth session cookie bypasses the edge cache");
assert(hasSessionCookie("__Secure-bbs.session_token=xyz"), "a secure-prefixed better-auth cookie bypasses the edge cache");
assert(!hasSessionCookie("_fbp=abc; _ga=xyz"), "unrelated cookies do not bypass the edge cache");
assert(!hasSessionCookie(null), "no cookie header means anonymous");

// ---- Pass 1: prefetch config + middleware wiring --------------------
const config = read("../astro.config.mjs");
assert(config.includes("prefetchAll: true") && config.includes("defaultStrategy: 'hover'"), "Astro prefetch is configured: all links, hover strategy");
const middleware = read("../src/middleware.ts");
assert(middleware.includes("withEdgeCache") && middleware.includes("isEdgeCacheablePath") && middleware.includes("hasSessionCookie"), "the middleware runs the edge cache with its session bypass");

console.log(failures === 0 ? "\nALL DISPLAY + PERF TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
