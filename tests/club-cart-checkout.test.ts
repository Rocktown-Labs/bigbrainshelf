// Club cart checkout (CG, 2026-11-07): the clubs are cart products.
// A visitor adds a plan on /clubs, checks out (guests included, no
// account, no account prompt), and the membership activates from
// the ORDER on the buyer's email. This suite drives the real
// /api/checkout route with a stubbed Stripe, the real completion
// path, and the real club cycle pass, and proves:
//   - club lines resolve server-side (price, period, one per cart)
//   - the guest email guards: (a) an email that already has an
//     account is refused with a sign-in message, (b) a paid member
//     re-joining the same plan is refused, paid audio + book-club
//     is the upgrade and proceeds
//   - a club cart opens a subscription-mode Stripe session with the
//     book lines one-time and the club line recurring
//   - a club-only Book Club cart takes its address with NO shipping
//     quote and NO shipping charge (address_only)
//   - completion activates a paid signup with user_id NULL and the
//     Stripe subscription id stored
//   - a guest physical member (user_id NULL) gets a first box from
//     the cycle pass, and email-only entitlements see the grants
//   - the audio-to-physical upgrade still cancels the old sub
//   - the gift flag round-trips into the order items JSON
// Run with: bun tests/club-cart-checkout.test.ts
import { Database } from "bun:sqlite";
import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import {
  resolveClubCartLine,
  isClubCartSlug,
} from "../src/lib/offers";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- Offers resolution ----------------------------------------------------
const q = resolveClubCartLine("book-club", "quarterly");
assert(q && q.priceCents === 6000 && q.clubPlan === "physical" && q.recurring.interval === "month" && q.recurring.interval_count === 3, "offers: book-club quarterly is $60 every 3 months");
const an = resolveClubCartLine("book-club", "annual");
assert(an && an.priceCents === 19900 && an.recurring.interval === "year" && an.recurring.interval_count === undefined, "offers: book-club annual is $199 a year");
const am = resolveClubCartLine("audio-club", "monthly");
assert(am && am.priceCents === 599 && am.clubPlan === "audio" && am.recurring.interval === "month", "offers: audio-club monthly is $5.99 a month");
const aa = resolveClubCartLine("audio-club", "annual");
assert(aa && aa.priceCents === 4900 && aa.recurring.interval === "year", "offers: audio-club annual is $49 a year");
assert(resolveClubCartLine("book-club", "monthly") === null, "offers: book-club has no monthly period");
assert(resolveClubCartLine("audio-club", "quarterly") === null, "offers: audio-club has no quarterly period");
assert(resolveClubCartLine("mastery", "digital") === null && !isClubCartSlug("mastery"), "offers: book slugs are not club lines");
assert(isClubCartSlug("book-club") && isClubCartSlug("audio-club"), "offers: both club slugs are reserved");

// ---- Database ---------------------------------------------------------------
const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, topic TEXT, status TEXT, cover_key TEXT, picture_book_key TEXT, coloring_book_key TEXT, epub_key TEXT, color_book_key TEXT, audiobook_key TEXT, price INTEGER, price_print INTEGER);
CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, emailVerified INTEGER, image TEXT, createdAt INTEGER, updatedAt INTEGER);
CREATE TABLE club_signups (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, shelf TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL, user_id TEXT, plan TEXT, club_plan TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT, subscription_status TEXT, first_ship_date TEXT, ship_name TEXT, ship_address TEXT);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL, book_slugs TEXT NOT NULL, stripe_session_id TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'usd', status TEXT NOT NULL DEFAULT 'complete', created_at INTEGER NOT NULL, items TEXT DEFAULT '', delivery_token TEXT, cart_fingerprint TEXT, physical_status TEXT, ship_name TEXT, ship_address TEXT, shipping_cents INTEGER NOT NULL DEFAULT 0, carrier TEXT, tracking_number TEXT, label_url TEXT, shippo_shipment_id TEXT, shippo_transaction_id TEXT);
CREATE UNIQUE INDEX orders_delivery_token_idx ON orders(delivery_token) WHERE delivery_token IS NOT NULL;
CREATE UNIQUE INDEX orders_pending_fp_idx ON orders(user_id, cart_fingerprint) WHERE status = 'pending';
CREATE TABLE webhook_events (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL, processed_at INTEGER, result TEXT);
CREATE TABLE email_outbox (id TEXT PRIMARY KEY, order_id TEXT, kind TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL, body_html TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, send_after INTEGER, dedupe_key TEXT);
CREATE UNIQUE INDEX email_outbox_order_kind_idx ON email_outbox(order_id, kind) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX email_outbox_dedupe_idx ON email_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE delivery_links (id TEXT PRIMARY KEY, order_id TEXT, user_id TEXT, email TEXT, book_slug TEXT NOT NULL, file_key TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'owned', token TEXT NOT NULL UNIQUE, expires_at INTEGER, created_at INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER);
CREATE TABLE club_cycle_boxes (id TEXT PRIMARY KEY, signup_id TEXT NOT NULL, ship_date TEXT NOT NULL, selected_book_slug TEXT, resolved_book_slug TEXT, second_selected_book_slug TEXT, second_resolved_book_slug TEXT, selection_source TEXT NOT NULL DEFAULT 'surprise', allow_repeat INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'awaiting_selection', carrier TEXT, tracking_number TEXT, label_url TEXT, locked_at INTEGER, shipped_at INTEGER, delivered_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(signup_id, ship_date));
CREATE TABLE club_box_events (id TEXT PRIMARY KEY, box_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
CREATE TABLE club_cycle_config (id INTEGER PRIMARY KEY CHECK (id = 1), cadence_days INTEGER NOT NULL, lookahead_days INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE club_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO books VALUES ('mira-the-heron-and-the-still-water', 'Mira the Heron and the Still Water', 'courage', 'complete', 'books/mira/cover.jpg', 'books/mira/picture.pdf', 'books/mira/coloring.pdf', NULL, 'books/mira/color.pdf', 'books/mira/audio.m4b', 1299, 2499);
INSERT INTO books VALUES ('algorithms', 'Fenix the Fox and the Clever Pattern', 'tech', 'complete', 'books/algorithms/cover.jpg', 'books/algorithms/picture.pdf', 'books/algorithms/coloring.pdf', NULL, 'books/algorithms/color.pdf', 'books/algorithms/audio.m4b', 1299, 2499);
INSERT INTO books VALUES ('mastery', 'Wally the Whale and the Deep Harbor', 'tech', 'complete', 'books/mastery/cover.jpg', 'books/mastery/picture.pdf', 'books/mastery/coloring.pdf', NULL, 'books/mastery/color.pdf', 'books/mastery/audio.m4b', 1299, 2499);
INSERT INTO books VALUES ('richdadpoordad', 'Penny the Squirrel and the Acorn Orchard', 'money', 'complete', 'books/penny/cover.jpg', 'books/penny/picture.pdf', 'books/penny/coloring.pdf', NULL, 'books/penny/color.pdf', 'books/penny/audio.m4b', 1299, 2499);
INSERT INTO "user" VALUES ('u-existing', 'member@example.com', 'Existing Member', 1, NULL, 0, 0);
INSERT INTO club_signups (id, name, email, shelf, status, created_at, user_id, plan, club_plan, stripe_subscription_id, subscription_status)
  VALUES ('cs-audio-paid', 'Audio Member', 'audiomember@example.com', 'tech', 'paid', 1000, NULL, 'monthly', 'audio', 'sub_audio_old', 'active');
INSERT INTO club_signups (id, name, email, shelf, status, created_at, user_id, plan, club_plan, stripe_subscription_id, subscription_status)
  VALUES ('cs-phys-paid', 'Physical Member', 'physmember@example.com', 'tech', 'paid', 1000, NULL, 'quarterly', 'physical', 'sub_phys_old', 'active');
`);
const db = {
  prepare(sql: string) {
    return {
      bind(...args: any[]) {
        const stmt = raw.query(sql);
        return {
          async run() { stmt.run(...args); return {}; },
          async first() { return stmt.get(...args) ?? null; },
          async all() { return { results: stmt.all(...args) }; },
        };
      },
    };
  },
} as any;
const SITE = "https://bigbrainshelf.com";

// ---- Module mocks: env, Stripe (capturing), auth (signed out) ---------------
const captured: any[] = [];
const cancelledSubs: string[] = [];
let sessionSeq = 0;
class FakeStripe {
  checkout = {
    sessions: {
      create: async (params: any) => {
        captured.push(params);
        sessionSeq += 1;
        const id = sessionSeq === 1 ? "cs_test_club" : `cs_test_club_${sessionSeq}`;
        return { id, url: `https://checkout.stripe.com/pay/${id}` };
      },
    },
  };
  subscriptions = {
    cancel: async (id: string) => { cancelledSubs.push(id); return {}; },
    retrieve: async (id: string) => ({ id, status: "active" }),
  };
  constructor(_key?: string, _opts?: any) {}
}
const bindings: any = { DB: db, STRIPE_SECRET_KEY: "sk_test_fake", APP_URL: SITE };
mock.module("cloudflare:workers", () => ({ env: bindings }));
mock.module("stripe", () => ({ default: FakeStripe }));
mock.module("../src/lib/auth", () => ({
  getAuth: () => ({ api: { getSession: async () => null } }),
}));

const { POST } = await import("../src/pages/api/checkout");
const { processCheckoutCompleted } = await import("../src/lib/orders");
const { activateClubFromOrder } = await import("../src/lib/club");
const { clubMemberCycleEligible, generateUpcomingCyclesForMember } = await import("../src/lib/club-cycles");
const { getDigitalEntitlements } = await import("../src/lib/library");

function post(body: any) {
  return POST({
    request: new Request("https://bigbrainshelf.com/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  } as any);
}
const signupByEmail = (email: string) =>
  raw.query("SELECT * FROM club_signups WHERE email = ?").get(email) as any;

// ---- Route: guest joins the Audio Club --------------------------------------
captured.length = 0;
{
  const res = await post({ items: [{ slug: "audio-club", format: "monthly" }], email: "newguest@example.com", guest_id: "guest:aaaa" });
  const data: any = await res.json();
  assert(res.status === 200 && data.url, "route: a guest can check out with an audio club line");
  const params = captured[0];
  assert(params && params.mode === "subscription", "route: a club cart opens a subscription-mode session");
  assert(params.line_items.length === 1 && params.line_items[0].price_data.recurring.interval === "month" && params.line_items[0].price_data.unit_amount === 599, "route: the club line is a $5.99 monthly recurring line");
  assert(params.line_items[0].price_data.product_data.name === "Big Brain Shelf Audio Club", "route: the club line reuses the club checkout product name");
  assert(params.metadata.club_plan === "audio" && params.metadata.club_period === "monthly" && params.metadata.club_email === "newguest@example.com", "route: the session metadata carries the club facts");
  assert(params.customer_email === "newguest@example.com", "route: the guest email rides the session");
  const order = raw.query("SELECT * FROM orders WHERE email = 'newguest@example.com'").get() as any;
  assert(order && order.status === "pending", "route: the pending order is stored under the guest email");
  const items = JSON.parse(order.items);
  assert(items.length === 1 && items[0].slug === "audio-club" && items[0].format === "monthly" && items[0].priceCents === 599 && items[0].qty === 1, "route: the order stores the club line with its price");
  assert(order.amount === 599, "route: the order amount is the club price");
}

// ---- Route: the guest email guards -------------------------------------------
{
  const noEmail = await post({ items: [{ slug: "audio-club", format: "monthly" }], guest_id: "guest:bbbb" });
  assert(noEmail.status === 400 && (await noEmail.json()).error.includes("email for your membership"), "guard: a guest club checkout without an email is refused");

  const hasAccount = await post({ items: [{ slug: "audio-club", format: "monthly" }], email: "member@example.com", guest_id: "guest:cccc" });
  const ha: any = await hasAccount.json();
  assert(hasAccount.status === 400 && ha.error.includes("already has an account") && ha.error.includes("Sign in"), "guard (a): an email with an account is told to sign in, nothing created");
  assert(!signupByEmail("member@example.com"), "guard (a): no signup row appears for the account email");

  const samePlan = await post({ items: [{ slug: "audio-club", format: "annual" }], email: "audiomember@example.com", guest_id: "guest:dddd" });
  assert(samePlan.status === 400 && (await samePlan.json()).error.includes("already a member"), "guard (b): a paid audio member cannot re-join audio as a guest");

  const audioOverPhysical = await post({ items: [{ slug: "audio-club", format: "monthly" }], email: "physmember@example.com", guest_id: "guest:eeee" });
  assert(audioOverPhysical.status === 400 && (await audioOverPhysical.json()).error.includes("already a member"), "guard (b): a paid physical member cannot add audio as a guest (the box includes listening)");

  captured.length = 0;
  const upgrade = await post({ items: [{ slug: "book-club", format: "quarterly" }], email: "audiomember@example.com", guest_id: "guest:ffff", address: { name: "Audio Member", line1: "1 Main St", city: "Searcy", state: "AR", postal_code: "72143", country: "US", phone: "+15015550142" } });
  assert(upgrade.status === 200, "guard (b): paid audio + book-club is the upgrade and proceeds");
  const up = captured[0];
  assert(up && up.mode === "subscription" && up.line_items[0].price_data.unit_amount === 6000 && up.line_items[0].price_data.recurring.interval_count === 3, "upgrade: the session carries the $60 quarterly club line");
}

// ---- Route: one club line, invalid pairs, mixed carts -------------------------
{
  captured.length = 0;
  const two = await post({ items: [{ slug: "audio-club", format: "monthly" }, { slug: "book-club", format: "annual" }], email: "twofer@example.com", guest_id: "guest:gggg", address: { name: "Two Fer", line1: "2 Main St", city: "Searcy", state: "AR", postal_code: "72143", country: "US", phone: "+15015550142" } });
  assert(two.status === 200, "route: a payload with two club lines still checks out");
  const tp = captured[0];
  assert(tp.line_items.length === 1 && tp.line_items[0].price_data.unit_amount === 19900 && tp.metadata.club_period === "annual", "route: only the last club line survives");

  captured.length = 0;
  const invalid = await post({ items: [{ slug: "book-club", format: "monthly" }], email: "nope@example.com", guest_id: "guest:hhhh" });
  assert(invalid.status === 400 && captured.length === 0, "route: an invalid club period drops the line (nothing purchasable, no session)");

  captured.length = 0;
  const mixed = await post({ items: [{ slug: "mira-the-heron-and-the-still-water", format: "digital", gift: true }, { slug: "audio-club", format: "annual" }], email: "mixed@example.com", guest_id: "guest:iiii" });
  assert(mixed.status === 200, "route: a mixed book + club cart checks out");
  const mp = captured[0];
  assert(mp.mode === "subscription" && mp.line_items.length === 2, "route: the mixed session is subscription mode with both lines");
  const bookLine = mp.line_items.find((l: any) => !l.price_data.recurring);
  const clubLine = mp.line_items.find((l: any) => l.price_data.recurring);
  assert(bookLine && bookLine.price_data.unit_amount === 1299, "route: the book line stays a one-time $12.99");
  assert(clubLine && clubLine.price_data.unit_amount === 4900 && clubLine.price_data.recurring.interval === "year", "route: the club line is the $49 annual recurring");
  const mOrder = raw.query("SELECT * FROM orders WHERE email = 'mixed@example.com'").get() as any;
  const mItems = JSON.parse(mOrder.items);
  assert(mItems.find((i: any) => i.slug === "mira-the-heron-and-the-still-water")?.gift === true, "gift: the flag round-trips into the order items JSON");
  assert(mItems.find((i: any) => i.slug === "audio-club")?.priceCents === 4900, "route: the mixed order stores the club line price");
}

// ---- Route: club-only Book Club quotes as address_only -------------------------
{
  const res = await post({ action: "quote", items: [{ slug: "book-club", format: "quarterly" }], address: { name: "Box Guest", line1: "3 Main St", city: "Searcy", state: "AR", postal_code: "72143", country: "US", phone: "+15015550142" } });
  const data: any = await res.json();
  assert(res.status === 200 && data.address_only === true && data.shipping === null, "quote: a club-only Book Club cart validates the address with no shipping quote");
  assert(data.total === 6000, "quote: the club-only total is the club price with $0 shipping");

  const badAddr = await post({ action: "quote", items: [{ slug: "book-club", format: "quarterly" }], address: { name: "Box Guest", line1: "", city: "Searcy", state: "AR", postal_code: "72143", country: "US", phone: "+15015550142" } });
  assert(badAddr.status === 400, "quote: a club-only cart still refuses an incomplete address");
}

// ---- Completion: the guest audio membership activates from the order ----------
{
  const session = {
    id: "cs_test_club",
    payment_status: "paid",
    amount_total: 599,
    currency: "usd",
    customer: "cus_guest",
    subscription: "sub_guest_audio",
    customer_email: "newguest@example.com",
    metadata: captured.length ? undefined : undefined,
  } as any;
  // Rebuild the session the way Stripe delivers it: metadata from
  // the captured create params of the guest audio checkout.
  const order = raw.query("SELECT * FROM orders WHERE email = 'newguest@example.com'").get() as any;
  session.metadata = {
    order_id: order.id,
    user_id: order.user_id,
    items: order.items,
    slugs: "audio-club",
    email: "newguest@example.com",
    club_plan: "audio",
    club_period: "monthly",
    club_email: "newguest@example.com",
    shipping_cents: "0",
  };
  const done = await processCheckoutCompleted(db, SITE, session, { STRIPE_SECRET_KEY: "sk_test_fake" });
  assert(done && done.status === "complete", "completion: the club order completes");
  const row = signupByEmail("newguest@example.com");
  assert(row && row.status === "paid" && row.club_plan === "audio" && row.plan === "monthly", "completion: the guest signup is paid on the order's email");
  assert(row.user_id === null, "completion: the guest membership carries NO user id (it claims by email later)");
  assert(row.stripe_subscription_id === "sub_guest_audio", "completion: the Stripe subscription id lands on the signup row");
  const welcome = raw.query("SELECT * FROM email_outbox WHERE kind = 'club_welcome' AND to_email = 'newguest@example.com'").get() as any;
  assert(!!welcome, "completion: the welcome email is queued for the guest");
}

// ---- Guest physical member: first box + email-only entitlements ----------------
{
  const order: any = {
    id: "ord_box_guest",
    user_id: null,
    email: "boxguest@example.com",
    ship_name: "Box Guest",
    ship_address: JSON.stringify({ line1: "3 Main St", city: "Searcy", state: "AR", postal_code: "72143", country: "US" }),
    items: JSON.stringify([{ slug: "book-club", format: "quarterly", qty: 1, priceCents: 6000 }]),
  };
  const act = await activateClubFromOrder(db, order, { customer: "cus_box", subscription: "sub_box_guest", metadata: {} }, undefined);
  assert(act && act.email === "boxguest@example.com", "activation: a guest book-club order activates");
  const row = signupByEmail("boxguest@example.com");
  assert(row && row.status === "paid" && row.club_plan === "physical" && row.user_id === null, "activation: the paid physical row is email-keyed with no user id");
  assert(row.stripe_subscription_id === "sub_box_guest" && row.first_ship_date, "activation: subscription id and first ship anchor are stored");
  assert(row.ship_name === "Box Guest", "activation: the ships-to comes from the order");
  assert(clubMemberCycleEligible(row), "cycles: a user_id NULL paid physical member is cycle-eligible");
  const grants = await getDigitalEntitlements(db, { id: null, email: "boxguest@example.com" } as any);
  assert(grants.get("algorithms")?.owned === true, "entitlements: the first-box digital book is visible by email alone");

  const boxes = await generateUpcomingCyclesForMember(db, row, new Date().toISOString().slice(0, 10));
  assert(boxes.length >= 1, "cycles: the guest member's first box is generated with no user id anywhere");
  const box = raw.query("SELECT * FROM club_cycle_boxes WHERE signup_id = ? ORDER BY ship_date LIMIT 1").get(row.id) as any;
  // The scheduler resolves a surprise box's contents at its lock
  // step; here the resolution is stamped directly so the shipped
  // box carries both titles, as a locked box does.
  raw.prepare("UPDATE club_cycle_boxes SET resolved_book_slug = COALESCE(resolved_book_slug, selected_book_slug, 'algorithms'), second_resolved_book_slug = COALESCE(second_resolved_book_slug, second_selected_book_slug, 'mastery'), status = 'shipped', shipped_at = ? WHERE id = ?").run(Date.now(), box.id);
  const shippedBox = raw.query("SELECT * FROM club_cycle_boxes WHERE id = ?").get(box.id) as any;
  const after = await getDigitalEntitlements(db, { id: null, email: "boxguest@example.com" } as any);
  assert(after.get(String(shippedBox.resolved_book_slug))?.owned === true && after.get(String(shippedBox.second_resolved_book_slug))?.owned === true, "entitlements: both box books are owned by email once the box ships");
}

// ---- Upgrade from the order path cancels the old subscription -------------------
{
  cancelledSubs.length = 0;
  const order: any = {
    id: "ord_upgrade",
    user_id: null,
    email: "audiomember@example.com",
    ship_name: "Audio Member",
    ship_address: JSON.stringify({ line1: "1 Main St", city: "Searcy", state: "AR", postal_code: "72143", country: "US" }),
    items: JSON.stringify([{ slug: "book-club", format: "quarterly", qty: 1, priceCents: 6000 }]),
  };
  const fakeStripe = { subscriptions: { cancel: async (id: string) => { cancelledSubs.push(id); return {}; } } };
  const act = await activateClubFromOrder(db, order, { customer: "cus_up", subscription: "sub_phys_new", metadata: {} }, fakeStripe);
  assert(act && act.email === "audiomember@example.com", "upgrade: the order-path activation lands");
  assert(cancelledSubs.length === 1 && cancelledSubs[0] === "sub_audio_old", "upgrade: the previous audio subscription is cancelled");
  const row = signupByEmail("audiomember@example.com");
  assert(row.club_plan === "physical" && row.stripe_subscription_id === "sub_phys_new" && row.status === "paid", "upgrade: the row is now the physical membership on the new subscription");
}

// ---- Gift + club display plumbing (lib level) ------------------------------------
{
  const { parseItems, orderPickList } = await import("../src/lib/orders");
  const parsed = parseItems({ items: JSON.stringify([{ slug: "mastery", format: "digital", gift: true }, { slug: "book-club", format: "quarterly", priceCents: 6000 }]) });
  assert(parsed[0].gift === true, "gift: parseItems keeps the flag");
  assert(parsed[1].format === "quarterly" && parsed[1].priceCents === 6000, "club: parseItems keeps the period format and price");
  const picks = await orderPickList(db, [{ id: "ord_gift", items: JSON.stringify([{ slug: "mastery", format: "digital", gift: true }, { slug: "book-club", format: "quarterly", priceCents: 6000 }]), book_slugs: "[]" }]);
  const groups = picks.get("ord_gift") || [];
  assert(groups.some((g: any) => g.title === "The Book Club" && g.format === "quarterly" && g.unitCents === 6000), "club: admin groups name the club, never the slug");
  assert(groups.find((g: any) => g.title === "Wally the Whale and the Deep Harbor")?.gift === true, "gift: the admin group carries the flag for the badge");
}

// ---- Webhook routing pin ----------------------------------------------------------
{
  const hook = read("../src/pages/api/stripe/webhook.ts");
  assert(hook.includes('(s.metadata as any)?.club === "1"'), "webhook: only dedicated club sessions route to club activation");
  assert(!hook.includes('s.mode === "subscription"'), "webhook: subscription mode alone never routes away from order completion");
}

if (failures) { console.error(`\n${failures} FAILURES`); process.exit(1); }
console.log("\nAll club cart checkout tests passed.");
