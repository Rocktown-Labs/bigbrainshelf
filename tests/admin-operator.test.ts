// Operator redesign pins (2026-10-29): /admin/club, /admin/orders,
// and /admin/reviews share the dashboard's shape — one short line
// under the title, three stat cards side by side, then tappable list
// rows a kid could work. These pins hold the new layouts and the API
// fields they read, and confirm every pre-existing action survived.
// Run with: bun tests/admin-operator.test.ts
import { readFileSync } from "node:fs";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ---- Club ------------------------------------------------------------
const clubPage = read("../src/pages/admin/club.astro");
const clubApi = read("../src/pages/api/admin/club.ts");
for (const marker of ["Boxes to pack", "Active members", "Club revenue / mo"]) {
  assert(clubPage.includes(marker), `club stat card: ${marker}`);
}
assert(clubPage.includes("Members, their boxes, and what needs packing."), "club header is one short line");
assert(!clubPage.includes("Quarterly revenue equiv") && !clubPage.includes("revenue equiv:"), "the club stat-pill wall is gone");
assert(clubPage.includes("Math.round((data.quarterlyRevenueCents || 0) / 3) + (data.audioMonthlyRevenueCents || 0)"), "club revenue per month = quarterly equivalent / 3 + audio monthly equivalent");
assert(clubPage.includes('paidPhysical + " Book Club · " + paidAudio + " Audio Club"'), "active members stat splits Book Club and Audio Club in the subline");
assert(clubApi.includes("boxesToPack"), "the club API counts boxes to pack over the whole table");
assert(clubApi.includes("needs_attention"), "the boxes-to-pack count includes flagged boxes");
// Redesign slice S2 (2026-11-03): the packing controls leave this
// page for Orders (a club box is an order). The club page carries a
// summary card that links over; the box actions survive in the API.
assert(clubPage.includes('id="pack-summary"'), "club page carries the packing summary card");
assert(clubPage.includes('href="/admin/orders"') && clubPage.includes("Pack boxes in Orders"), "the summary card links to the orders queue for packing");
assert(clubApi.includes("update_box"), "the box update action survives in the club API");
assert(clubPage.indexOf('id="pack-summary"') < clubPage.indexOf('id="member-table"'), "the packing summary comes before members");
assert(clubPage.includes('id="member-drawer"') && clubPage.includes("member_id="), "member names open the right-side profile drawer fed by the member_id API branch");
assert(clubPage.includes("Reservations &amp; canceled") && clubPage.includes("paid physical members"), "reservations, canceled accounts and the member count sit in the quiet bottom section (no founding cap since 2026-10-31)");

// ---- Orders ------------------------------------------------------------
const ordersPage = read("../src/pages/admin/orders.astro");
const ordersApi = read("../src/pages/api/admin/orders.ts");
for (const marker of ["To fulfill", "Orders, last 7 days", "Revenue, last 30 days"]) {
  assert(ordersPage.includes(marker), `orders stat line: ${marker}`);
}
assert(ordersPage.includes('id="stat-fulfill"') && ordersPage.includes('id="stat-revenue"'), "orders stats bind to the API stats payload");
for (const field of ["toFulfill", "orders7d", "ordersTotal", "revenue30dCents"]) {
  assert(ordersApi.includes(field), `orders API stat: ${field}`);
}
assert(ordersPage.includes('id="retry-emails"') && ordersPage.includes("retry_emails"), "the outbox retry action survives on the slim strip");
assert(ordersPage.includes("SHIPPO") || ordersApi.includes("shippoStatus"), "the Shippo setup state still reaches the orders page");
// Condense pass (CG phone review, 2026-11-10): the orders page is
// the table plus what matters. Stat cards became one line, the
// outbox became a status line, the Shippo banner left the list
// page, secondary filters hide behind a toggle on mobile, the
// per-page selector sits in the table footer, the packing queue is
// slim rows, and mobile table rows are cover + buyer/item + pill.
assert(ordersPage.includes('class="statline"') && !ordersPage.includes('class="stats"'), "orders stats are one slim line, not three cards (condense pass)");
assert(!ordersPage.includes('id="shippo-banner"'), "the Shippo banner is gone from the orders list page (carrier state lives on order detail)");
assert(ordersPage.includes("· pending ") && ordersPage.includes('id="retry-emails" hidden'), "the outbox is a status line and Retry shows only when pending/failed exist");
assert(ordersPage.includes('id="filters-toggle"') && ordersPage.includes('id="filters-row"'), "stage select + saved filters sit in one secondary row behind the mobile Filters toggle");
assert(ordersPage.includes('class="tablefoot"') && ordersPage.indexOf('id="per-page"') > ordersPage.indexOf('id="orders-rows"'), "the per-page selector lives in the table footer");
assert(ordersPage.includes("packrow") && ordersPage.includes('id="packing-cards" class="packrows'), "the packing queue renders as slim rows");
assert(ordersPage.includes("m-itemline") && ordersPage.includes("max-width:699px") && ordersPage.includes("grid-template-areas"), "mobile orders rows: slim grid (cover, buyer + item line, pill over total), no column headers");
assert(ordersPage.includes("Club orders") && !ordersPage.includes("Club boxes"), "the kind chip reads Club orders, not Club boxes (boxes are not orders-table rows)");
assert(ordersPage.includes("menuItemsFor") && ordersPage.includes("set_physical_status"), "row actions survive in the kebab menu, stage advances included (orders redo: the advance button moved off the row)");
for (const action of ["set_physical_status", "label_quote", "buy_label", "retry_emails"]) {
  assert(ordersApi.includes(action), `orders API action survives: ${action}`);
}
const orderDetail = read("../src/pages/admin/orders/[id].astro");
for (const marker of ["Buyer", "Fulfillment", "Emails for this order", "Print label (USPS)", "Pack the box"]) {
  assert(orderDetail.includes(marker), `order detail carries: ${marker}`);
}
assert(orderDetail.includes("set_physical_status"), "order detail keeps the fulfillment advance action");
// Pick list + filter tabs (owner addendum, 2026-10-29).
assert(ordersPage.includes("contentsHtml") && ordersPage.includes("items_pick"), "orders rows summarize as covers + item naming in the contents cell (orders redo, CG 2026-11-10)");
assert(ordersPage.includes('id="kind-chips"') && ordersPage.includes('id="stage-select"') && ordersPage.includes('data-saved="needs_action"'), "orders filters: kind chips, stage select, saved filters (orders redo replaces the To fulfill / Fulfilled / All tabs)");
assert(ordersApi.includes("tabCounts") && ordersApi.includes("items_pick"), "the orders API returns tab counts and pick lists");
assert(ordersApi.includes("physical_status IS NULL"), "fulfilled includes completed digital/audio-only orders (physical_status IS NULL)");
assert(orderDetail.includes("Order details") && orderDetail.includes("items_detail"), "order detail: structured items up top, reference ids de-emphasized at the bottom");

// ---- Reviews -----------------------------------------------------------
const reviewsPage = read("../src/pages/admin/reviews.astro");
const reviewsApi = read("../src/pages/api/admin/reviews.ts");
for (const marker of ["Awaiting moderation", "Average rating", "Total reviews"]) {
  assert(reviewsPage.includes(marker), `reviews stat card: ${marker}`);
}
assert(reviewsApi.includes("avgApproved") && reviewsApi.includes("stats"), "the reviews API returns moderation stats over the whole table");
assert(reviewsPage.includes("PAGE_SIZE = 25"), "the reviews list paginates at 25 per page");
assert(reviewsPage.includes('id="page-prev"') && reviewsPage.includes('id="page-next"'), "the reviews pager exists");
assert(reviewsPage.includes('data-act="approve"') && reviewsPage.includes('data-act="reject"'), "quick approve/reject actions sit on the rows");
assert(reviewsPage.includes('id="review-detail"') && reviewsPage.includes("openDetail"), "tapping a row opens the full-screen review detail");
assert(reviewsApi.includes('action !== "approve" && action !== "reject"') || reviewsApi.includes("setReviewStatus"), "the moderation POST behavior is unchanged");
// Data table (owner correction, 2026-10-29): no TanStack, no React
// island — a proper table in the current stack, server-driven.
assert(reviewsPage.includes("<table") && reviewsPage.includes("rtable"), "the reviews list is a real data table");
assert(reviewsPage.includes('data-sort="date"') && reviewsPage.includes('data-sort="rating"'), "date and rating headers are sortable");
assert(reviewsPage.includes('data-fstatus="pending"') && reviewsPage.includes('data-fstatus="approved"') && reviewsPage.includes('data-fstatus="rejected"'), "the status filter covers all / pending / approved / rejected");
assert(reviewsPage.includes("col-opt") && reviewsPage.includes("table-layout:fixed"), "mobile shows priority columns only and the table cannot stretch");
assert(reviewsApi.includes('searchParams.get("status")') && reviewsApi.includes('searchParams.get("sort")') && reviewsApi.includes("PAGE_SIZE = 25"), "filter, sort, and pagination are server-side in the reviews API");

console.log(failures === 0 ? "\nALL ADMIN OPERATOR TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
