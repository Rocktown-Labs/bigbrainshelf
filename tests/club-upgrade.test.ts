// Club upgrade + address tests (CG's club fixes, 2026-10-31):
//  - a paid Audio Club member can upgrade to The Book Club (the
//    storefront used to wall them off completely); activation flips
//    the plan, starts the box cycle, grants the first-box digital,
//    and cancels the old Audio subscription in Stripe so the member
//    is never billed for both;
//  - the reservation for an upgrade must NOT flip the row's plan
//    before payment (an abandoned upgrade checkout changes nothing);
//  - the physical club checkout collects a shipping address in
//    Stripe and activation stores it on the signup row (members who
//    never bought a printed book had a first box due with no address
//    on file anywhere).
// Run with: bun tests/club-upgrade.test.ts
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  activateClubFromSession,
  upsertClubReservation,
  clubPlanOf,
  ensureClubTable,
} from "../src/lib/club";
import { chicagoDateString } from "../src/lib/offers";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else {
    failures += 1;
    console.error("FAIL:", label);
  }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, topic TEXT, cover_key TEXT, status TEXT, picture_book_key TEXT, coloring_book_key TEXT, epub_key TEXT, color_book_key TEXT, audiobook_key TEXT, price INTEGER, price_print INTEGER);
CREATE TABLE club_signups (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, shelf TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, book_slugs TEXT, items TEXT, stripe_session_id TEXT, amount INTEGER DEFAULT 0, currency TEXT DEFAULT 'usd', status TEXT DEFAULT 'complete', delivery_token TEXT, cart_fingerprint TEXT, physical_status TEXT, ship_name TEXT, ship_address TEXT, shipping_cents INTEGER, created_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE email_outbox (id TEXT PRIMARY KEY, order_id TEXT, kind TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, send_after INTEGER, from_email TEXT);
CREATE UNIQUE INDEX email_outbox_order_kind_idx ON email_outbox(order_id, kind) WHERE order_id IS NOT NULL;
INSERT INTO books (slug, title, topic, status, cover_key, picture_book_key, coloring_book_key, audiobook_key, price, price_print) VALUES
  ('algorithms', 'Fern', 'tech', 'complete', 'f/cover.jpg', 'f/pic.pdf', 'f/col.pdf', 'f/audio.m4b', 899, 2000);
`);

const db = {
  prepare(sql: string) {
    return {
      bind(...args: any[]) {
        const stmt = raw.query(sql);
        return {
          async run() { const r = stmt.run(...args) as any; return { meta: { changes: r?.changes ?? 0 } }; },
          async first() { return stmt.get(...args) ?? null; },
          async all() { return { results: stmt.all(...args) }; },
        };
      },
    };
  },
} as any;

await ensureClubTable(db);
const cols = (raw.query("PRAGMA table_info(club_signups)").all() as any[]).map((r) => r.name);
assert(cols.includes("ship_name") && cols.includes("ship_address"), "ensureClubTable adds the ships-to columns");

const memberRow = (email: string) => raw.query("SELECT * FROM club_signups WHERE email = ?").get(email) as any;
const count = (sql: string, ...args: any[]) => (raw.query(sql).get(...args) as any).n as number;

const cancelled: string[] = [];
const fakeStripe = {
  subscriptions: {
    cancel: async (id: string) => { cancelled.push(id); return { id, status: "canceled" }; },
  },
};

// --- An Audio Club member joins, then upgrades ------------------------------
const res = await upsertClubReservation(db, {
  name: "Uma Upgrade", email: "uma@example.com", shelf: "tech",
  status: "queued", userId: "user-uma", clubPlan: "audio",
});
const audioSession = {
  id: "cs_audio", customer: "cus_uma", subscription: "sub_audio_uma",
  metadata: { club: "1", club_signup_id: res.id, club_plan: "audio", plan: "monthly", email: "uma@example.com", name: "Uma Upgrade", shelf: "tech", user_id: "user-uma" },
};
const audioMember = await activateClubFromSession(db, audioSession, fakeStripe);
assert(audioMember?.status === "paid" && clubPlanOf(audioMember) === "audio", "audio activation lands as an audio member");
assert(cancelled.length === 0, "first activation cancels nothing");
assert(!audioMember.ship_address && !audioMember.ship_name, "audio join stores no shipping address");

// The upgrade reservation (what /api/club/checkout writes for a paid
// audio member): clubPlan null, so the row must keep saying audio
// until the upgrade is actually paid for.
await upsertClubReservation(db, {
  name: "Uma Upgrade", email: "uma@example.com", shelf: "tech",
  status: "paid", userId: "user-uma", clubPlan: null,
});
assert(clubPlanOf(memberRow("uma@example.com")) === "audio", "upgrade reservation does not clobber the live audio plan");
assert(memberRow("uma@example.com").stripe_subscription_id === "sub_audio_uma", "upgrade reservation keeps the audio subscription on the row");

// The upgrade checkout completes (physical, quarterly, address collected).
const upgradeSession = {
  id: "cs_upgrade", customer: "cus_uma", subscription: "sub_book_uma",
  metadata: { club: "1", club_signup_id: res.id, club_plan: "physical", plan: "quarterly", email: "uma@example.com", name: "Uma Upgrade", shelf: "tech", user_id: "user-uma" },
  shipping_details: {
    name: "Uma Upgrade",
    address: { line1: "12 River Rd", line2: "", city: "Searcy", state: "AR", postal_code: "72143", country: "US" },
  },
};
const upgraded = await activateClubFromSession(db, upgradeSession, fakeStripe);
assert(clubPlanOf(upgraded) === "physical" && upgraded.plan === "quarterly", "upgrade activation flips to Book Club quarterly");
assert(upgraded.stripe_subscription_id === "sub_book_uma", "row now carries the Book Club subscription");
assert(cancelled.length === 1 && cancelled[0] === "sub_audio_uma", "the Audio subscription is cancelled exactly once");
assert(upgraded.first_ship_date === chicagoDateString(), "first box is due on the upgrade date");
assert(upgraded.ship_name === "Uma Upgrade", "ships-to name stored from checkout");
const addr = JSON.parse(upgraded.ship_address || "{}");
assert(addr.line1 === "12 River Rd" && addr.city === "Searcy" && addr.postal_code === "72143", "ships-to address stored in the orders JSON shape");
assert(
  count("SELECT COUNT(*) n FROM orders WHERE stripe_session_id = ?", `club_firstbox_${res.id}`) === 1,
  "upgrade writes the first-box digital grant"
);

// Webhook replay of the same upgrade session: no second cancel.
await activateClubFromSession(db, upgradeSession, fakeStripe);
assert(cancelled.length === 1, "replay does not cancel again");

// --- A fresh Book Club join also stores its address -------------------------
const res2 = await upsertClubReservation(db, {
  name: "Fred Fresh", email: "fred@example.com", shelf: "tech",
  status: "queued", userId: "user-fred", clubPlan: "physical",
});
const fresh = await activateClubFromSession(db, {
  id: "cs_fresh", customer: "cus_fred", subscription: "sub_fred",
  metadata: { club: "1", club_signup_id: res2.id, club_plan: "physical", plan: "annual", email: "fred@example.com", name: "Fred Fresh", shelf: "tech", user_id: "user-fred" },
  // Newer Stripe API versions nest the address under
  // collected_information (the shape this account's webhooks carry;
  // the first live upgrade stored nothing until activation read
  // both, like orders.ts does).
  collected_information: { shipping_details: { name: "Fred Fresh", address: { line1: "9 Oak St", city: "Little Rock", state: "AR", postal_code: "72202", country: "US" } } },
}, fakeStripe);
assert(fresh.ship_name === "Fred Fresh" && JSON.parse(fresh.ship_address).city === "Little Rock", "fresh physical join stores its ships-to");
assert(cancelled.length === 1, "fresh join cancels nothing");

// --- Wiring pins --------------------------------------------------------------
const checkoutSrc = readFileSync(new URL("../src/pages/api/club/checkout.ts", import.meta.url), "utf8");
assert(checkoutSrc.includes("shipping_address_collection"), "club checkout collects a shipping address for the physical plan");
assert(checkoutSrc.includes("clubPlan: isUpgrade ? null : clubPlan"), "upgrade reservation passes no plan (no pre-payment clobber)");
assert(checkoutSrc.includes('existingPlan === "physical" && clubPlan === "audio"'), "Book Club member asking for audio reads as already a member");
const webhookSrc = readFileSync(new URL("../src/pages/api/stripe/webhook.ts", import.meta.url), "utf8");
assert(webhookSrc.includes("activateClubFromSession(e.DB, s, stripe)"), "webhook hands activation the Stripe client for the old-sub cancel");
const clubsSrc = readFileSync(new URL("../src/pages/clubs.astro", import.meta.url), "utf8");
assert(clubsSrc.includes("data-upgrade-plan") && clubsSrc.includes("Want the printed books too?"), "/clubs offers audio members the upgrade");
const accountSrc = readFileSync(new URL("../src/pages/account/club.astro", import.meta.url), "utf8");
assert(accountSrc.includes("data-club-upgrade"), "/account club page offers audio members the upgrade");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
