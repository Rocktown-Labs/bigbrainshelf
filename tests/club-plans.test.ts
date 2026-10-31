// Club plans tests (2026-10-28 rethink): the physical Book Club and the
// Audio Club as two subscription plans on the same membership ledger.
//
// Pins:
//  - checkout/webhook path records the plan dimension (club_plan) and
//    the billing period (plan) from Stripe session metadata;
//  - the physical join grant (first box book as a $0 order) is written
//    for physical members only, never for audio members;
//  - the entitlement matrix in library.ts: physical active = digital +
//    audio on every published book; audio active = audio-only on every
//    audio-published book (cover + audiobook on file, any book
//    status); past-due / canceled members of either plan get no
//    membership layer; owned books are unaffected in every state;
//    unpublished books never appear as readable, but an
//    audio-published one (ready_for_qa gamma, cover + audio) reaches
//    BOTH plans as listening only;
//  - audio members never enter the cycle-box pipeline: neither direct
//    cycle generation nor the scheduler creates boxes for them;
//  - the /clubs page and the checkout endpoint read the Audio Club
//    price constants (no hardcoded audio prices);
//  - the lock model (2026-10-29): membership-layer grants are never
//    owned, so they never download; orders and shipped boxes are
//    owned; a member can still buy an audio edition at the full 199
//    to own it, and that purchase (not the membership) is what earns
//    the digital unlock credit.
//
// Runs the real src/lib code against an in-memory bun:sqlite database.
// Run with: bun tests/club-plans.test.ts
import { Database } from "bun:sqlite";
import {
  activateClubFromSession,
  upsertClubReservation,
  clubPlanOf,
  clubMembershipActive,
  countPaidClubMembers,
  ensureClubTable,
} from "../src/lib/club";
import {
  getDigitalEntitlements,
  getLibraryBooks,
  ownsDigitalBook,
  ownsAudioBook,
  entitlementDownloads,
} from "../src/lib/library";
import { checkoutItemPrice } from "../src/lib/orders";
import { ensureClubCycleTables, generateUpcomingCyclesForMember, runClubCycleScheduler } from "../src/lib/club-cycles";
import { AUDIO_CLUB_PRICE_CENTS, AUDIO_CLUB_ANNUAL_PRICE_CENTS, chicagoDateString } from "../src/lib/offers";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, topic TEXT, cover_key TEXT, status TEXT, picture_book_key TEXT, coloring_book_key TEXT, epub_key TEXT, color_book_key TEXT, audiobook_key TEXT, price INTEGER, price_print INTEGER);
CREATE TABLE club_signups (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, shelf TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, book_slugs TEXT, items TEXT, stripe_session_id TEXT, amount INTEGER DEFAULT 0, currency TEXT DEFAULT 'usd', status TEXT DEFAULT 'complete', delivery_token TEXT, cart_fingerprint TEXT, physical_status TEXT, ship_name TEXT, ship_address TEXT, shipping_cents INTEGER, created_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE email_outbox (id TEXT PRIMARY KEY, order_id TEXT, kind TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, send_after INTEGER, from_email TEXT);
CREATE UNIQUE INDEX email_outbox_order_kind_idx ON email_outbox(order_id, kind) WHERE order_id IS NOT NULL;
INSERT INTO books (slug, title, topic, status, cover_key, picture_book_key, coloring_book_key, audiobook_key, price, price_print) VALUES
  ('alpha', 'Alpha', 'tech', 'complete', 'a/cover.jpg', 'a/pic.pdf', 'a/col.pdf', 'a/audio.m4b', 899, 2000),
  ('beta', 'Beta', 'money', 'complete', 'b/cover.jpg', 'b/pic.pdf', 'b/col.pdf', NULL, 899, 2000),
  ('delta', 'Delta', 'tech', 'complete', 'd/cover.jpg', 'd/pic.pdf', 'd/col.pdf', 'd/audio.m4b', 899, 2000),
  ('gamma', 'Gamma', 'courage', 'ready_for_qa', 'g/cover.jpg', 'g/pic.pdf', 'g/col.pdf', 'g/audio.m4b', 899, 2000),
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
await ensureClubCycleTables(db);

const count = (sql: string, ...args: any[]) => (raw.query(sql).get(...args) as any).n as number;
const memberRow = (email: string) => raw.query("SELECT * FROM club_signups WHERE email = ?").get(email) as any;

// A fake completed Stripe subscription session, shaped like the one
// the webhook hands activateClubFromSession.
function fakeSession(signupId: string, meta: Record<string, string>) {
  return {
    id: `cs_${signupId}`,
    customer: `cus_${signupId}`,
    subscription: `sub_${signupId}`,
    metadata: { club: "1", club_signup_id: signupId, ...meta },
  };
}

// ---- Activation records the plan (checkout -> webhook path) --------------
const physRes = await upsertClubReservation(db, {
  name: "Pat Physical", email: "pat@example.com", shelf: "tech",
  status: "queued", userId: "user-pat", clubPlan: "physical",
});
const physMember = await activateClubFromSession(db, fakeSession(physRes.id, {
  club_plan: "physical", plan: "quarterly", email: "pat@example.com",
  name: "Pat Physical", shelf: "tech", user_id: "user-pat",
}));
assert(physMember?.status === "paid", "physical activation marks the member paid");
assert(clubPlanOf(physMember) === "physical", "physical activation records club_plan physical");
assert(physMember?.plan === "quarterly", "physical activation records the quarterly period");
assert(physMember?.first_ship_date === chicagoDateString(), "physical member's first box is due on the join date (purchase-anchored cycle)");
assert(
  count("SELECT COUNT(*) n FROM orders WHERE stripe_session_id = ?", `club_firstbox_${physRes.id}`) === 1,
  "physical activation writes the first-box join grant order"
);

const audioRes = await upsertClubReservation(db, {
  name: "Andy Audio", email: "andy@example.com", shelf: "tech",
  status: "queued", userId: "user-andy", clubPlan: "audio",
});
const audioMember = await activateClubFromSession(db, fakeSession(audioRes.id, {
  club_plan: "audio", plan: "monthly", email: "andy@example.com",
  name: "Andy Audio", shelf: "tech", user_id: "user-andy",
}));
assert(audioMember?.status === "paid", "audio activation marks the member paid");
assert(clubPlanOf(audioMember) === "audio", "audio activation records club_plan audio");
assert(audioMember?.plan === "monthly", "audio activation records the monthly period");
assert(!audioMember?.first_ship_date, "audio member has no ship date");
assert(
  count("SELECT COUNT(*) n FROM orders WHERE stripe_session_id = ?", `club_firstbox_${audioRes.id}`) === 0,
  "audio activation writes NO first-box grant order"
);

// A session with no club_plan metadata (pre-rethink checkout) is physical.
const legacyRes = await upsertClubReservation(db, {
  name: "Legacy", email: "legacy@example.com", shelf: "money",
  status: "queued", userId: "user-legacy",
});
const legacyMember = await activateClubFromSession(db, fakeSession(legacyRes.id, {
  plan: "annual", email: "legacy@example.com", name: "Legacy", shelf: "money", user_id: "user-legacy",
}));
assert(clubPlanOf(legacyMember) === "physical", "session without club_plan activates as physical");

// Member counting by plan (the counts feed admin stats; no cap is
// enforced anywhere since 2026-10-31).
assert((await countPaidClubMembers(db)) === 3, "total paid count includes both plans");
assert((await countPaidClubMembers(db, "physical")) === 2, "physical paid count excludes audio members");
assert((await countPaidClubMembers(db, "audio")) === 1, "audio paid count counts audio members only");

// ---- Entitlement matrix ----------------------------------------------------
const pat = { id: "user-pat", email: "pat@example.com" };
const entPat = await getDigitalEntitlements(db, pat);
for (const slug of ["alpha", "beta", "delta", "algorithms"]) {
  assert(entPat.get(slug)?.digital === true && entPat.get(slug)?.audio === true, `physical active: ${slug} is digital + audio`);
  assert(entPat.get(slug)?.membership === "physical", `physical active: ${slug} is flagged membership physical`);
}
assert(entPat.get("gamma")?.audio === true && entPat.get("gamma")?.digital === false, "physical active: audio-published (ready_for_qa) book is listening only, never readable");
assert(entPat.get("gamma")?.membership === "physical", "physical active: the audio-published book is flagged membership physical");
assert(
  entPat.get("algorithms")?.sources.includes("order"),
  "physical active: the join-grant book is also owned (order source survives alongside membership)"
);

const andy = { id: "user-andy", email: "andy@example.com" };
const entAndy = await getDigitalEntitlements(db, andy);
for (const slug of ["alpha", "delta", "algorithms"]) {
  const e = entAndy.get(slug);
  assert(e?.audio === true && e?.digital === false, `audio active: ${slug} is audio-only`);
  assert(e?.membership === "audio", `audio active: ${slug} is flagged membership audio`);
}
assert(!entAndy.has("beta"), "audio active: book without an audiobook is NOT in the library");
assert(entAndy.get("gamma")?.audio === true && entAndy.get("gamma")?.digital === false, "audio active: audio-published (ready_for_qa) book IS granted, listening only");
assert(entAndy.get("gamma")?.membership === "audio", "audio active: the audio-published book is flagged membership audio");
assert(await ownsAudioBook(db, andy, "gamma"), "audio active: ownsAudioBook true for the audio-published book (streaming route opens; downloads stay locked, pinned below)");
assert(!(await ownsDigitalBook(db, andy, "gamma")), "audio active: ownsDigitalBook false for the audio-published book (no page reading)");
assert(await ownsAudioBook(db, andy, "alpha"), "audio active: ownsAudioBook true (reader listening opens; downloads stay locked, pinned below)");
assert(!(await ownsDigitalBook(db, andy, "alpha")), "audio active: ownsDigitalBook false (no page reading, no book files)");
const andyShelf = await getLibraryBooks(db, andy);
assert(andyShelf.find((b) => b.slug === "gamma")?.audioOnly === true, "audio active: the audio-published book's shelf entry is listen-only");
assert(andyShelf.find((b) => b.slug === "alpha")?.audioOnly === true, "audio active: shelf entry is listen-only");
assert(andyShelf.find((b) => b.slug === "alpha")?.clubPlan === "audio", "audio active: shelf entry carries the Audio Club marker");
assert((await getLibraryBooks(db, pat)).find((b) => b.slug === "beta")?.clubPlan === "physical", "physical active: shelf entry carries the Book Club marker");

// ---- Lapse removes exactly the membership layer ----------------------------
// Pat buys delta outright first: ownership must survive every lapse.
raw.query(
  "INSERT INTO orders (id, user_id, email, book_slugs, items, stripe_session_id, amount, status, created_at) VALUES ('order-pat-delta', 'user-pat', 'pat@example.com', '[\"delta\"]', '[{\"slug\":\"delta\",\"format\":\"digital\"}]', 'cs_pat_buy', 899, 'complete', 1700000001)"
).run();

raw.query("UPDATE club_signups SET subscription_status = 'past_due' WHERE email = 'pat@example.com'").run();
assert(clubMembershipActive(memberRow("pat@example.com")) === false, "past-due physical member is not active");
const entPatPaused = await getDigitalEntitlements(db, pat);
assert(!entPatPaused.has("alpha"), "physical past due: membership layer gone (alpha not owned, not granted)");
assert(entPatPaused.get("algorithms")?.sources.includes("order") && !entPatPaused.get("algorithms")?.membership, "physical past due: join-grant book stays owned, membership flag gone");
assert(entPatPaused.get("delta")?.digital === true && !entPatPaused.get("delta")?.membership, "physical past due: purchased book stays fully owned");

raw.query("UPDATE club_signups SET subscription_status = 'active', status = 'canceled' WHERE email = 'pat@example.com'").run();
const entPatCanceled = await getDigitalEntitlements(db, pat);
assert(!entPatCanceled.has("alpha") && entPatCanceled.has("delta"), "physical canceled: no membership layer, owned books remain");

raw.query("UPDATE club_signups SET subscription_status = 'past_due' WHERE email = 'andy@example.com'").run();
const entAndyPaused = await getDigitalEntitlements(db, andy);
assert(entAndyPaused.size === 0, "audio past due: no membership layer and nothing owned");

// A plain buyer with no membership is untouched by all of this.
raw.query(
  "INSERT INTO orders (id, user_id, email, book_slugs, items, stripe_session_id, amount, status, created_at) VALUES ('order-buyer', 'user-buyer', 'buyer@example.com', '[\"beta\"]', '[{\"slug\":\"beta\",\"format\":\"audio\"}]', 'cs_buyer', 199, 'complete', 1700000002)"
).run();
const entBuyer = await getDigitalEntitlements(db, { id: "user-buyer", email: "buyer@example.com" });
assert(entBuyer.get("beta")?.audio === true && entBuyer.get("beta")?.digital === false && !entBuyer.get("beta")?.membership, "purchased audio-only is unaffected by the membership layer");

// ---- Audio members never enter the box pipeline -----------------------------
const andyRow = memberRow("andy@example.com");
raw.query("UPDATE club_signups SET subscription_status = 'active' WHERE email = 'andy@example.com'").run();
const andyGen = await generateUpcomingCyclesForMember(db, memberRow("andy@example.com"), "2026-10-28");
assert(andyGen.length === 0, "cycle generation creates no boxes for an audio member");
assert(count("SELECT COUNT(*) n FROM club_cycle_boxes WHERE signup_id = ?", audioRes.id) === 0, "no box rows exist for the audio member");

// Pat's membership was canceled in the lapse section above; restore
// it to paid + active so the scheduler pass below has a live physical
// member to work on.
raw.query("UPDATE club_signups SET status = 'paid', subscription_status = 'active' WHERE email = 'pat@example.com'").run();
const summary = await runClubCycleScheduler(db, { site: "https://bigbrainshelf.com", now: new Date("2026-10-28T12:00:00Z") });
assert(count("SELECT COUNT(*) n FROM club_cycle_boxes WHERE signup_id = ?", audioRes.id) === 0, "the scheduler creates no boxes for the audio member");
assert(count("SELECT COUNT(*) n FROM club_cycle_boxes WHERE signup_id = ?", physRes.id) > 0, "the scheduler still creates boxes for the physical member");
assert(typeof summary.generatedMembers === "number", "scheduler ran");

// ---- Lock model: membership is access, downloads are ownership -------------
// (CG, 2026-10-29.) Both memberships are restored active above, so
// these reads see the full membership layer.
const entPatLive = await getDigitalEntitlements(db, pat);
assert(entPatLive.get("alpha")?.owned === false, "lock: a Book Club member's shelf-wide reach is NOT owned (alpha is membership only)");
assert(entPatLive.get("algorithms")?.owned === true, "lock: the join-grant book IS owned (it arrived as an order)");
assert(entitlementDownloads(entPatLive.get("alpha"), "book") === false, "lock: membership-only book does not download (book file)");
assert(entitlementDownloads(entPatLive.get("alpha"), "audiobook") === false, "lock: membership-only book does not download (audiobook file)");
assert(entitlementDownloads(entPatLive.get("algorithms"), "book") === true, "lock: owned join-grant book downloads");
assert((await getLibraryBooks(db, pat)).find((b) => b.slug === "alpha")?.owned === false, "lock: shelf row for a membership-only book carries owned false");
assert((await getLibraryBooks(db, pat)).find((b) => b.slug === "algorithms")?.owned === true, "lock: shelf row for the join-grant book carries owned true");
assert(entBuyer.get("beta")?.owned === true, "lock: a plain audio purchase is owned");

// An active Audio Club member buying a book's audio edition to OWN it:
// the purchase is never blocked, never discounted by the membership,
// and the completed order converts the grant to owned.
const alphaRow = { slug: "alpha", price: 899, price_print: 2000, picture_book_key: "a/pic.pdf", coloring_book_key: "a/col.pdf", audiobook_key: "a/audio.m4b" };
const entAndyLive = await getDigitalEntitlements(db, andy);
assert(entAndyLive.get("alpha")?.owned === false, "member buys to own: before the purchase, alpha is membership access only");
assert(entitlementDownloads(entAndyLive.get("alpha"), "audiobook") === false, "member buys to own: before the purchase, the audiobook file does not download");
const memberAudioPrice = checkoutItemPrice(alphaRow, "audio", { digital: false, audio: true });
assert(memberAudioPrice?.cents === 199 && memberAudioPrice?.upgrade === undefined, "member buys to own: the audio edition prices at the full 199 for a member, no discount, no credit marker");
// The digital unlock credit keys off OWNED audio only: with the
// owned-derived flags checkout passes (a member's are both false),
// Andy's digital price is the full list price, no member credit.
const memberDigitalPrice = checkoutItemPrice(alphaRow, "digital", { digital: false, audio: false });
assert(memberDigitalPrice?.cents === 899 && memberDigitalPrice?.upgrade === undefined, "member buys to own: membership alone earns no digital upgrade credit");
raw.query(
  "INSERT INTO orders (id, user_id, email, book_slugs, items, stripe_session_id, amount, status, created_at) VALUES ('order-andy-alpha-audio', 'user-andy', 'andy@example.com', '[\"alpha\"]', '[{\"slug\":\"alpha\",\"format\":\"audio\"}]', 'cs_andy_buy', 199, 'complete', 1700000003)"
).run();
const entAndyOwned = await getDigitalEntitlements(db, andy);
assert(entAndyOwned.get("alpha")?.owned === true, "member buys to own: after the purchase, alpha is owned");
assert(entAndyOwned.get("alpha")?.membership === "audio", "member buys to own: the book is owned AND membership-reached (owned wins)");
assert(entAndyOwned.get("alpha")?.digital === false, "member buys to own: an audio purchase still grants no digital edition");
assert(entitlementDownloads(entAndyOwned.get("alpha"), "audiobook") === true, "member buys to own: the owned audiobook file now downloads");
assert(entitlementDownloads(entAndyOwned.get("alpha"), "book") === false, "member buys to own: book files still do not download on an audio grant");
// And now the upgrade credit is legitimate: it keys off the owned
// audio grant the purchase created.
const ownerDigitalPrice = checkoutItemPrice(alphaRow, "digital", { digital: false, audio: true });
assert(ownerDigitalPrice?.cents === 700 && ownerDigitalPrice?.upgrade === "audio-upgrade", "member buys to own: after owning the audio, the digital unlock credit applies");
// Ownership survives the membership lapsing.
raw.query("UPDATE club_signups SET subscription_status = 'past_due' WHERE email = 'andy@example.com'").run();
const entAndyLapsed = await getDigitalEntitlements(db, andy);
assert(entAndyLapsed.get("alpha")?.owned === true && !entAndyLapsed.get("alpha")?.membership, "member buys to own: the owned audio grant survives cancellation of the membership");
assert(entitlementDownloads(entAndyLapsed.get("alpha"), "audiobook") === true, "member buys to own: the owned audiobook still downloads after the lapse");
raw.query("UPDATE club_signups SET subscription_status = 'active' WHERE email = 'andy@example.com'").run();

// ---- Surfaces read the constants --------------------------------------------
assert(AUDIO_CLUB_PRICE_CENTS === 599 && AUDIO_CLUB_ANNUAL_PRICE_CENTS === 4900, "audio club price constants are 599 / 4900 (CG, 2026-10-29)");
const clubPageSrc = await Bun.file(new URL("../src/pages/clubs.astro", import.meta.url)).text();
assert(clubPageSrc.includes("AUDIO_CLUB_PRICE_CENTS") && clubPageSrc.includes("AUDIO_CLUB_ANNUAL_PRICE_CENTS"), "clubs page formats audio prices from the constants");
assert(clubPageSrc.includes("Audio Club"), "clubs page presents the Audio Club");
assert(clubPageSrc.includes("club_plan"), "clubs page sends the plan dimension at checkout");
const oldClubStubSrc = await Bun.file(new URL("../src/pages/book-club.astro", import.meta.url)).text();
assert(oldClubStubSrc.includes('Astro.redirect("/clubs" + qs, 301)'), "old /book-club route is a 301 stub to /clubs preserving the query string");
const checkoutSrc = await Bun.file(new URL("../src/pages/api/club/checkout.ts", import.meta.url)).text();
assert(checkoutSrc.includes("AUDIO_CLUB_PRICE_CENTS") && checkoutSrc.includes("club_plan"), "club checkout prices the audio plan from the constants and carries club_plan");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nALL CLUB PLAN TESTS PASSED");
