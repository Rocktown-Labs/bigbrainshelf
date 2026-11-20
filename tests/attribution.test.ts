// Acquisition attribution (2026-11-20): the full UTM set is captured
// first-touch on the storefront (30-day window), sanitized by the one
// shared lib, carried by the /api/collect mirror into store_events,
// stamped on the order row, and shown on the admin order page.
//
// Pins:
//  - lib/attribution sanitize/parse/metadata/label behavior;
//  - Tracking.astro keeps the first-touch store (localStorage
//    "bbs-attr", 30 days) and exposes window.bbsAttribution, and the
//    funnel mirror sends the full set;
//  - collect.ts sanitizes through the lib and emits medium/campaign/
//    content; metrics.ts appends them as blobs 4-6 (1-3 unchanged);
//  - checkout.ts stamps the pending order and the Stripe metadata;
//    club checkout carries the metadata too; the checkout and club
//    pages send the stored set;
//  - the admin orders API ensures + selects the column and the order
//    detail page renders the "Came from" line.
//
// Assert-style, like the rest of the suite: bun tests/attribution.test.ts
import { readFileSync } from "node:fs";
import {
  sanitizeAttribution,
  parseAttribution,
  attributionStripeMetadata,
  attributionLabel,
} from "../src/lib/attribution";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
function read(p: string) { return readFileSync(new URL(p, import.meta.url), "utf8"); }

// --- sanitize -------------------------------------------------------------
const full = sanitizeAttribution({
  source: "TikTok", medium: "Social", campaign: "Holiday-2026",
  term: "kids books", content: "video A",
  landing: "/books/mira-the-heron-and-the-still-water?utm_source=tiktok",
  ts: Math.floor(Date.now() / 1000),
});
assert(full?.source === "tiktok", "source lowercased");
assert(full?.medium === "social", "medium lowercased");
assert(full?.campaign === "holiday-2026", "campaign kept");
assert(full?.term === "kidsbooks", "term charset-stripped");
assert(full?.content === "videoa", "content charset-stripped");
assert(full?.landing === "/books/mira-the-heron-and-the-still-water", "landing drops the query string");
assert(typeof full?.ts === "number", "fresh ts kept");

const rawKeys = sanitizeAttribution({ utm_source: "instagram", utm_campaign: "launch" });
assert(rawKeys?.source === "instagram" && rawKeys?.campaign === "launch", "utm_ key spelling accepted");

assert(sanitizeAttribution({}) === null, "empty payload is null");
assert(sanitizeAttribution(null) === null, "null payload is null");
assert(sanitizeAttribution("tiktok") === null, "non-object payload is null");
assert(sanitizeAttribution({ source: "!!!" }) === null, "all-junk tags are null");
assert(sanitizeAttribution({ medium: "email" })?.medium === "email", "medium alone survives");

const capped = sanitizeAttribution({ source: "a".repeat(80), campaign: "b".repeat(120) });
assert(capped?.source.length === 32, "source capped at 32");
assert(capped?.campaign.length === 64, "campaign capped at 64");

const stale = sanitizeAttribution({ source: "tiktok", ts: 1000 });
assert(stale && stale.ts === undefined, "ancient ts dropped, tags kept");
const noLanding = sanitizeAttribution({ source: "tiktok", landing: "https://evil.example/x" });
assert(noLanding && noLanding.landing === undefined, "non-path landing dropped");

// --- parse / metadata / label ----------------------------------------------
const roundTrip = parseAttribution(JSON.stringify(full));
assert(roundTrip?.source === "tiktok" && roundTrip?.campaign === "holiday-2026", "stored JSON round-trips");
assert(parseAttribution("not json") === null, "junk stored value reads as null");
assert(parseAttribution(null) === null, "null stored value reads as null");
assert(parseAttribution("") === null, "empty stored value reads as null");

const meta = attributionStripeMetadata(full);
assert(meta.utm_source === "tiktok" && meta.utm_medium === "social" && meta.utm_campaign === "holiday-2026", "stripe metadata carries source/medium/campaign");
assert(!("utm_term" in meta) && !("utm_content" in meta), "term/content stay off stripe metadata");
assert(Object.keys(attributionStripeMetadata(null)).length === 0, "no attribution, no metadata");

assert(attributionLabel(full) === "tiktok / social / holiday-2026", "label joins source / medium / campaign");
assert(attributionLabel(null) === "", "label empty without attribution");

// --- wiring pins -------------------------------------------------------------
const tracking = read("../src/components/Tracking.astro");
assert(tracking.includes('BBS_ATTR_KEY = "bbs-attr"'), "client store key pinned");
assert(tracking.includes("30 * 24 * 3600 * 1000"), "client window is 30 days");
assert(tracking.includes("window.bbsAttribution"), "checkout-facing getter exposed");
assert(tracking.includes("utm_medium") && tracking.includes("utm_campaign") && tracking.includes("utm_content"), "mirror sends the full set");
assert(!tracking.includes("bbs-utm"), "old session utm_source capture retired");

const collect = read("../src/pages/api/collect.ts");
assert(collect.includes("sanitizeAttribution"), "collect sanitizes through the lib");
assert(collect.includes("campaign: attr?.campaign"), "collect emits the campaign");

const metrics = read("../src/lib/metrics.ts");
assert(metrics.includes('opts.medium ?? ""') && metrics.includes('opts.campaign ?? ""') && metrics.includes('opts.content ?? ""'), "metrics appends UTM blobs after the original three");

const orders = read("../src/lib/orders.ts");
assert(orders.includes("ensureOrderAttributionColumn"), "orders lib ensures the column");
assert(orders.includes("ADD COLUMN attribution TEXT"), "attribution column is TEXT (JSON)");
assert(orders.includes("stampOrderAttribution"), "orders lib stamps attribution");

const checkout = read("../src/pages/api/checkout.ts");
assert(checkout.includes("sanitizeAttribution((body as any)?.attribution)"), "checkout sanitizes the payload");
assert(checkout.includes("stampOrderAttribution(e.DB, order.id, attribution)"), "checkout stamps the pending order");
assert(checkout.includes("attributionStripeMetadata(attribution)"), "checkout carries Stripe metadata");

const clubCheckout = read("../src/pages/api/club/checkout.ts");
assert(clubCheckout.includes("attributionStripeMetadata(sanitizeAttribution("), "club checkout carries Stripe metadata");

const checkoutPage = read("../src/pages/checkout.astro");
assert(checkoutPage.includes("payload.attribution"), "checkout page sends the stored set");

const adminApi = read("../src/pages/api/admin/orders.ts");
assert(adminApi.includes("ensureOrderAttributionColumn(e.DB)"), "admin API ensures the column before selecting");
assert(adminApi.includes("pricing_detail, attribution FROM orders WHERE id = ?"), "admin detail select returns attribution");

const adminPage = read("../src/pages/admin/orders/[id].astro");
assert(adminPage.includes("Came from"), "order detail page renders the source line");
assert(adminPage.includes("attrParts(o)"), "order detail page parses the stored JSON");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
