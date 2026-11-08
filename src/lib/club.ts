// Book Club membership (Workstream 2).
//
// Membership is a paid Stripe subscription (quarterly or annual
// founding plan; prices in src/lib/offers.ts). Joining requires a
// store account and charges today. Box cycles are purchase-anchored:
// a physical member's first box is due the day they join
// (first_ship_date stamps the join date) and the next boxes fall
// every 3 months from it. club_signups is the membership ledger,
// keyed by account email:
//
//   queued    founding reservation (no payment). Rows made by the
//             original /api/club-signup queue keep this status until
//             the same email pays, then upgrade in place.
//   paid      active paying member (stripe ids + first_ship_date set).
//   canceled  subscription ended (Stripe deleted it, or it lapsed to
//             canceled/unpaid). The row and its shelf pick are kept.
//   live      legacy status written by the old date-based queue for
//             signups after the live date. Treated as a reservation.
//
// Paid state changes only through the Stripe webhook (see
// src/pages/api/stripe/webhook.ts); checkout itself never marks a row
// paid, so an abandoned or replayed session cannot fake a membership.

import type { DBLike } from "./orders";
import { ensureOnce } from "./schema-cache";
import {
  AUDIO_CLUB_ANNUAL_PRICE_CENTS,
  AUDIO_CLUB_PRICE_CENTS,
  CLUB_ANNUAL_PRICE_CENTS,
  CLUB_FIRST_BOX_BOOK,
  CLUB_PRICE_CENTS,
  chicagoDateString,
  clubPriceLabel,
  clubSignupStatus,
  resolveClubCartLine,
} from "./offers";

export const SHELVES = [
  { id: "tech", label: "Tech", blurb: "How the digital world works: code, the internet, and the machines behind them." },
  { id: "money", label: "Money", blurb: "Saving, growing, and thinking clearly about money from a young age." },
  { id: "courage", label: "Courage", blurb: "Big feelings, hard things, and characters who keep going anyway." },
] as const;

export function shelfLabel(id: string): string {
  return SHELVES.find((s) => s.id === id)?.label || id;
}

export function isShelf(id: string): boolean {
  return SHELVES.some((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Club plans (CG rethink, 2026-10-28). A membership is one of two
// plans, stored on club_signups.club_plan:
//
//   physical  the original Book Club: quarterly printed boxes plus,
//             while active, digital + audio access to every published
//             book. Cycle boxes apply. No member cap on either plan.
//   audio     the Audio Club: while active, audio access to every
//             published book that has an audiobook. Nothing else: no
//             boxes, no page access.
//
// The pre-existing club_signups.plan column is the BILLING PERIOD
// (quarterly | annual | monthly), a different axis; do not conflate
// them. Rows written before club_plan existed carry NULL and are
// physical, which clubPlanOf encodes in one place.

export type ClubPlanId = "physical" | "audio";

export function clubPlanOf(member: any): ClubPlanId {
  return member?.club_plan === "audio" ? "audio" : "physical";
}

export function isClubPlanId(value: any): value is ClubPlanId {
  return value === "physical" || value === "audio";
}

// Subscription states in which the membership layer grants nothing:
// terminal states end access, and a past-due or paused subscription
// pauses it (Book Club V2 billing health; cycle boxes use the same
// sets through club-cycles). A NULL subscription_status is a legacy
// row with no events yet and counts as in good standing.
const CLUB_INACTIVE_SUBSCRIPTION_STATUSES = ["canceled", "unpaid", "incomplete_expired"];
const CLUB_PAUSED_SUBSCRIPTION_STATUSES = ["past_due", "paused"];

// Is this row a member in good standing right now? The entitlement
// layer's all-access grants (library.ts) key on exactly this, so a
// canceled or past-due member of either plan gets neither layer while
// their owned books and shipped boxes stay untouched.
export function clubMembershipActive(member: any): boolean {
  if (!member || member.status !== "paid") return false;
  const sub = String(member.subscription_status || "");
  // A comp membership (a granted free year, lib/promo.ts) is active
  // strictly inside its comp window; the window is the whole truth,
  // so an expired comp reads inactive everywhere this helper is
  // consulted, even before the scheduler flips the row.
  if (sub === "comp") return Number(member.comp_until || 0) > Math.floor(Date.now() / 1000);
  return (
    !CLUB_INACTIVE_SUBSCRIPTION_STATUSES.includes(sub) &&
    !CLUB_PAUSED_SUBSCRIPTION_STATUSES.includes(sub)
  );
}

// The membership row for a signed-in user, matched by account email
// with the user id as the second key (the same lookup shape the
// library's shipped-box grants use).
export async function getClubMembership(
  db: DBLike,
  user: { id?: string; email?: string }
): Promise<any | null> {
  await ensureClubTable(db);
  const email = String(user?.email || "").trim().toLowerCase();
  const userId = String(user?.id || "");
  if (!email && !userId) return null;
  return db
    .prepare("SELECT * FROM club_signups WHERE email = ? OR user_id = ? LIMIT 1")
    .bind(email, userId)
    .first();
}

// Columns added after the original queue table shipped. ensureClubTable
// adds any that are missing, so a database created by the founding-queue
// pass upgrades in place the first time any club code runs.
const CLUB_COLUMNS: Record<string, string> = {
  user_id: "TEXT",
  plan: "TEXT",
  stripe_customer_id: "TEXT",
  stripe_subscription_id: "TEXT",
  first_ship_date: "TEXT",
  paid_at: "INTEGER",
  canceled_at: "INTEGER",
  // Book Club V2 billing health: the live Stripe subscription status
  // (active, past_due, canceled, unpaid, ...) tracked from webhook
  // events. Cycle generation and locking skip members whose
  // subscription is canceled/unpaid/past_due; NULL means a legacy row
  // with no events yet and counts as in good standing.
  subscription_status: "TEXT",
  payment_failed_at: "INTEGER",
  // Club plans (2026-10-28): 'physical' | 'audio'. Existing rows get
  // NULL and are physical by clubPlanOf; new writes always set it.
  club_plan: "TEXT",
  // Ships-to captured at club checkout (Stripe collects the shipping
  // address on the physical plan, 2026-10-31): the member's own
  // address for their boxes, stored in the orders' JSON shape,
  // instead of the admin view borrowing one from a store order.
  ship_name: "TEXT",
  ship_address: "TEXT",
  // Scheduled downgrade (2026-11-01): a Book Club member switching
  // to The Audio Club at the end of the paid period. Stripe carries
  // cancel_at_period_end; these columns remember the intent and the
  // chosen audio billing period so the switch moment (subscription
  // deleted webhook) sends the right email and the club page can
  // show what happens next.
  downgrade_to_audio_at: "INTEGER",
  // Comp memberships (2026-11-01, lib/promo.ts): a granted free year
  // carries subscription_status 'comp' and an epoch end in
  // comp_until. No Stripe subscription exists behind it.
  comp_until: "INTEGER",
  downgrade_audio_period: "TEXT",
};

export async function ensureClubTable(db: DBLike): Promise<void> {
  await ensureOnce(db, "club_signups", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS club_signups (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           email TEXT NOT NULL UNIQUE,
           shelf TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'queued',
           created_at INTEGER NOT NULL,
           user_id TEXT,
           plan TEXT,
           stripe_customer_id TEXT,
           stripe_subscription_id TEXT,
           first_ship_date TEXT,
           paid_at INTEGER,
           canceled_at INTEGER,
           club_plan TEXT DEFAULT 'physical'
         )`
      )
      .bind()
      .run();
    const { results } = await db.prepare("PRAGMA table_info(club_signups)").bind().all();
    const have = new Set(((results || []) as any[]).map((r) => String(r.name)));
    for (const [col, type] of Object.entries(CLUB_COLUMNS)) {
      if (!have.has(col)) {
        await db.prepare(`ALTER TABLE club_signups ADD COLUMN ${col} ${type}`).bind().run();
      }
    }
  });
}

const now = () => Math.floor(Date.now() / 1000);

// Create or refresh the reservation row for an email. A repeat signup
// updates name, shelf pick, and (once known) the account user id, but
// never touches payment state: a paid member stays paid.
export async function upsertClubReservation(
  db: DBLike,
  args: {
    name: string;
    email: string;
    shelf: string;
    status: string;
    userId?: string | null;
    clubPlan?: ClubPlanId | null;
  }
): Promise<any> {
  const email = args.email.trim().toLowerCase();
  await db
    .prepare(
      `INSERT INTO club_signups (id, name, email, shelf, status, created_at, user_id, club_plan)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'physical'))
       ON CONFLICT(email) DO UPDATE SET
         name = excluded.name,
         shelf = excluded.shelf,
         user_id = COALESCE(excluded.user_id, club_signups.user_id),
         club_plan = CASE WHEN ? IS NOT NULL THEN excluded.club_plan ELSE club_signups.club_plan END`
    )
    .bind(
      crypto.randomUUID(),
      args.name,
      email,
      args.shelf,
      args.status,
      now(),
      args.userId ?? null,
      args.clubPlan ?? null,
      args.clubPlan ?? null
    )
    .run();
  return getClubSignup(db, email);
}

export async function getClubSignup(db: DBLike, email: string): Promise<any | null> {
  return db
    .prepare("SELECT * FROM club_signups WHERE email = ?")
    .bind(email.trim().toLowerCase())
    .first();
}

export async function isPaidClubMember(db: DBLike, email: string): Promise<boolean> {
  const row = await getClubSignup(db, email);
  return row?.status === "paid";
}

// Paid members right now. Drives the founding cap on /clubs and the
// admin summary. The founding cap counts PHYSICAL members only (the
// Audio Club has no cap), so cap checks pass plan = 'physical'; the
// unfiltered count stays for totals.
export async function countPaidClubMembers(db: DBLike, plan?: ClubPlanId): Promise<number> {
  await ensureClubTable(db);
  const row = plan
    ? await db
        .prepare(
          plan === "audio"
            ? "SELECT COUNT(*) AS n FROM club_signups WHERE status = 'paid' AND club_plan = 'audio'"
            : "SELECT COUNT(*) AS n FROM club_signups WHERE status = 'paid' AND (club_plan IS NULL OR club_plan = 'physical')"
        )
        .bind()
        .first()
    : await db.prepare("SELECT COUNT(*) AS n FROM club_signups WHERE status = 'paid'").bind().first();
  return Number((row as any)?.n || 0);
}

// Day-one digital: a paid member's library gains the digital bundle of
// their shelf's first-box book (CLUB_FIRST_BOX_BOOK in offers.ts) the
// moment they join, instead of everything waiting for the first printed
// box. The store's library entitlement mechanism is a completed order,
// so the grant is a $0 completed order for that one digital book. The
// synthetic stripe_session_id makes the grant idempotent: webhook
// replays, repeat activations, and rejoins all converge on one grant.
//
// Memberships live on the email (CG, 2026-11-07: guests subscribe from
// the cart with no account), so a member with no account yet keys the
// grant to the membership itself ("club:<signup id>") instead of
// skipping it: the entitlement layer matches completed orders by email
// too, so the book is waiting the moment they sign in with that email.
export async function grantClubFirstBoxDigital(db: DBLike, member: any): Promise<void> {
  const userId = member?.user_id ? String(member.user_id) : member?.id ? `club:${String(member.id)}` : "";
  if (!userId) return;
  const slug = CLUB_FIRST_BOX_BOOK[String(member?.shelf || "")];
  if (!slug) return;
  const sessionKey = `club_firstbox_${member.id}`;
  const existing = await db
    .prepare("SELECT id FROM orders WHERE stripe_session_id = ?")
    .bind(sessionKey)
    .first();
  if (existing) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO orders
         (id, user_id, email, book_slugs, items, stripe_session_id, amount, currency, status, delivery_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'usd', 'complete', ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      userId,
      String(member.email || ""),
      JSON.stringify([slug]),
      JSON.stringify([{ slug, format: "digital" }]),
      sessionKey,
      crypto.randomUUID(),
      now()
    )
    .run();
}

// The explicit facts one membership activation is made of. Two
// callers build them: activateClubFromSession (the account-bound club
// checkout's webhook) and activateClubFromOrder (a store order whose
// cart carried a club line, CG 2026-11-07). Everything downstream of
// the facts (the paid UPDATE, the replaced-subscription cancel, the
// first-box grant, the welcome + owner emails) is shared, so a member
// who joins from the cart is indistinguishable from one who joined
// from the club checkout.
export interface ClubActivationFields {
  shelf: string;
  clubPlan: ClubPlanId;
  // Billing period: quarterly | annual (physical), monthly | annual
  // (audio). Normalized inside applyClubActivation.
  period: string;
  userId?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  // Ships-to for the member's boxes, in the orders' storage shape
  // (ship_address is the JSON string). Absent keeps the row's values.
  shipName?: string | null;
  shipAddress?: string | null;
}

// Apply an activation to an already-resolved membership row.
async function applyClubActivation(
  db: DBLike,
  row: any,
  fields: ClubActivationFields,
  stripe?: any
): Promise<any> {
  const shelf = fields.shelf;
  const clubPlan: ClubPlanId = fields.clubPlan;
  const plan =
    fields.period === "annual" ? "annual" : fields.period === "monthly" ? "monthly" : "quarterly";
  // The box cycle anchors to the day this subscription was purchased.
  // A webhook replay for the SAME subscription keeps the original
  // anchor (and its already-minted boxes); a new subscription (a
  // rejoin, or a first physical join after Audio Club) starts a fresh
  // cycle at the new join date.
  const newSubscriptionId = fields.stripeSubscriptionId ? String(fields.stripeSubscriptionId) : null;
  const sameSubscription =
    !!row.stripe_subscription_id &&
    !!newSubscriptionId &&
    String(row.stripe_subscription_id) === newSubscriptionId;
  const firstShipDate =
    clubPlan === "physical"
      ? sameSubscription && row.first_ship_date
        ? String(row.first_ship_date)
        : chicagoDateString()
      : null;
  // The subscription this activation replaces (an Audio Club sub on
  // an upgrade, most importantly): it gets cancelled below once the
  // new one is live, so the member is never billed for both clubs.
  const prevSubscriptionId = row.stripe_subscription_id
    ? String(row.stripe_subscription_id)
    : null;
  await db
    .prepare(
      `UPDATE club_signups SET
         status = 'paid',
         shelf = ?,
         plan = ?,
         club_plan = ?,
         user_id = COALESCE(?, user_id),
         stripe_customer_id = ?,
         stripe_subscription_id = ?,
         first_ship_date = ?,
         paid_at = COALESCE(paid_at, ?),
         canceled_at = NULL,
         subscription_status = 'active',
         payment_failed_at = NULL,
         ship_name = COALESCE(?, ship_name),
         ship_address = COALESCE(?, ship_address)
       WHERE id = ?`
    )
    .bind(
      shelf,
      plan,
      clubPlan,
      fields.userId ? String(fields.userId) : null,
      fields.stripeCustomerId ? String(fields.stripeCustomerId) : null,
      newSubscriptionId,
      firstShipDate,
      now(),
      fields.shipName ? String(fields.shipName) : null,
      fields.shipAddress ? String(fields.shipAddress) : null,
      row.id
    )
    .run();
  const member = await db.prepare("SELECT * FROM club_signups WHERE id = ?").bind(row.id).first();
  // Plan switch (the Audio to Book Club upgrade): the old
  // subscription must stop billing now that the new one is active.
  // A replay of the same session has prev === new and skips this.
  // Best effort: a failure is logged, never fatal to the activation
  // (the member's new club is live either way, and a stuck old sub
  // is visible in Stripe for a human to kill).
  if (stripe && prevSubscriptionId && newSubscriptionId && prevSubscriptionId !== newSubscriptionId) {
    try {
      await stripe.subscriptions.cancel(prevSubscriptionId);
    } catch (err) {
      console.error(
        "club plan switch: cancelling the previous subscription failed",
        (err as any)?.message || err
      );
    }
  }
  // Day-one digital for the first box's book is a PHYSICAL club grant
  // (idempotent; see the grant's comment). Audio Club members get no
  // grant order: their access is the live membership layer in
  // library.ts, which lapses with the subscription instead of becoming
  // a permanent owned book. Never let a grant failure break the
  // activation: the webhook would otherwise 500 and Stripe would retry
  // a join that already succeeded.
  try {
    if (member && clubPlanOf(member) === "physical") await grantClubFirstBoxDigital(db, member);
  } catch (err) {
    console.error("club first-box digital grant failed", (err as any)?.message || err);
  }
  // The member hears from us, and so does the owner (CG's rule:
  // a new subscription should land in his inbox like an order
  // does). Deduped per subscription, so webhook replays and
  // renewals never re-send. Never fatal to activation.
  try {
    if (member && member.email) {
      const { enqueueEmail, OWNER_NOTIFY_EMAIL } = await import("./orders");
      const audio = clubPlan === "audio";
      const clubName = audio ? "The Audio Club" : "The Book Club";
      const cents = audio
        ? plan === "annual" ? AUDIO_CLUB_ANNUAL_PRICE_CENTS : AUDIO_CLUB_PRICE_CENTS
        : plan === "annual" ? CLUB_ANNUAL_PRICE_CENTS : CLUB_PRICE_CENTS;
      const cadence = plan === "annual" ? "a year" : audio ? "a month" : "a quarter";
      const price = `${clubPriceLabel(cents)} ${cadence}`;
      const dedupe = `${row.id}:${String(newSubscriptionId || "")}`;
      await enqueueEmail(db, {
        kind: "club_welcome",
        to: String(member.email),
        subject: `Welcome to ${clubName}`,
        text: audio
          ? `You are in. Every Big Brain Shelf audiobook is in your library while your membership is active, ready to listen.\n\nYour plan: ${clubName}, ${price}, billed until you cancel. Pause or cancel anytime from your account page.\n\nOpen your library: https://bigbrainshelf.com/account`
          : `You are in. Your first box is being put together: the club book as a gift set, a second printed book you pick (or a surprise), and the club book in digital on day one.\n\nYour plan: ${clubName}, ${price}, billed until you cancel. Pause or cancel anytime from your account page.\n\nPick your second book: https://bigbrainshelf.com/account`,
        dedupeKey: `club-welcome:${dedupe}`,
      });
      await enqueueEmail(db, {
        kind: "owner_new_subscription",
        to: OWNER_NOTIFY_EMAIL,
        subject: `New ${clubName} member: ${price}`,
        text:
          `New Big Brain Shelf club member.\n\n` +
          `Club: ${clubName}\nPlan: ${plan} (${price})\nMember: ${member.email}\n\n` +
          `Club list: https://bigbrainshelf.com/admin/club\n`,
        dedupeKey: `owner-sub:${dedupe}`,
      });
    }
  } catch (err) {
    console.error("club welcome/owner emails failed", (err as any)?.message || err);
  }
  return member;
}

// Webhook: a paid club checkout session. Matches the reservation by the
// signup id carried in session metadata, falling back to the email, and
// upgrades it in place: the account email and user id win, and the
// checkout's shelf pick replaces the reserved one when it differs.
export async function activateClubFromSession(
  db: DBLike,
  session: any,
  stripe?: any
): Promise<any | null> {
  await ensureClubTable(db);
  const meta = session?.metadata || {};
  const signupId = String(meta.club_signup_id || "");
  const email = String(meta.email || session?.customer_email || session?.customer_details?.email || "")
    .trim()
    .toLowerCase();
  let row: any = null;
  if (signupId) {
    row = await db.prepare("SELECT * FROM club_signups WHERE id = ?").bind(signupId).first();
  }
  if (!row && email) row = await getClubSignup(db, email);
  if (!row) {
    if (!email) return null;
    row = await upsertClubReservation(db, {
      name: String(meta.name || ""),
      email,
      shelf: isShelf(String(meta.shelf || "")) ? String(meta.shelf) : "tech",
      status: "queued",
      userId: meta.user_id ? String(meta.user_id) : null,
      clubPlan: meta.club_plan === "audio" ? "audio" : "physical",
    });
  }
  // Ships-to from the checkout session (the physical plan collects a
  // shipping address in Stripe Checkout): stored in the same JSON
  // shape as orders.ship_address. Absent (audio plan, older
  // sessions) keeps whatever is already on the row.
  const shipDetails =
    session?.shipping_details || session?.collected_information?.shipping_details || null;
  let shipAddress: string | null = null;
  if (shipDetails?.address) {
    const a = shipDetails.address;
    shipAddress = JSON.stringify({
      line1: a.line1 || "",
      line2: a.line2 || "",
      city: a.city || "",
      state: a.state || "",
      postal_code: a.postal_code || "",
      country: a.country || "",
    });
  }
  return applyClubActivation(
    db,
    row,
    {
      // meta.plan is the billing period (physical: quarterly | annual;
      // audio: monthly | annual); meta.club_plan is the plan dimension.
      // Sessions created before the Audio Club existed carry no
      // club_plan and are physical.
      shelf: isShelf(String(meta.shelf || "")) ? String(meta.shelf) : row.shelf,
      clubPlan: meta.club_plan === "audio" ? "audio" : "physical",
      period: String(meta.plan || ""),
      userId: meta.user_id ? String(meta.user_id) : null,
      stripeCustomerId: session?.customer ? String(session.customer) : null,
      stripeSubscriptionId: session?.subscription ? String(session.subscription) : null,
      shipName: shipDetails?.name ? String(shipDetails.name) : null,
      shipAddress,
    },
    stripe
  );
}

// Order completion: a paid store order whose cart carried a club line
// (CG, 2026-11-07: clubs are cart products; guests subscribe with no
// account). The membership is keyed to the ORDER's email: the
// reservation is upserted first (shelf from any existing row, else the
// default), then the shared activation runs with the order's own
// ships-to and the session's Stripe customer/subscription, so the
// subscription lifecycle webhooks keep syncing this row exactly like
// a club-checkout membership. The account user id attaches only when
// the order itself belongs to an account (a "guest:<id>" key is not
// one); the email match claims the membership at sign-in either way.
export async function activateClubFromOrder(
  db: DBLike,
  order: any,
  session: any,
  stripe?: any
): Promise<any | null> {
  await ensureClubTable(db);
  let items: any[] = [];
  try {
    const raw = JSON.parse(order?.items || "[]");
    if (Array.isArray(raw)) items = raw;
  } catch { /* an order without a parseable items list has no club line */ }
  const line = items
    .map((x: any) => resolveClubCartLine(x?.slug, x?.format))
    .find((s: any) => s);
  if (!line) return null;
  const meta = session?.metadata || {};
  const email = String(order?.email || meta.club_email || session?.customer_email || session?.customer_details?.email || "")
    .trim()
    .toLowerCase();
  if (!email) return null;
  const existing = await getClubSignup(db, email);
  const orderUserId = String(order?.user_id || "");
  const row = await upsertClubReservation(db, {
    name: String(order?.ship_name || existing?.name || email.split("@")[0]),
    email,
    shelf: existing?.shelf && isShelf(String(existing.shelf)) ? String(existing.shelf) : "tech",
    status: existing?.status || clubSignupStatus(),
    userId: orderUserId && !orderUserId.startsWith("guest:") ? orderUserId : null,
    clubPlan: line.clubPlan,
  });
  if (!row) return null;
  return applyClubActivation(
    db,
    row,
    {
      shelf: row.shelf,
      clubPlan: line.clubPlan,
      period: line.period,
      userId: orderUserId && !orderUserId.startsWith("guest:") ? orderUserId : null,
      stripeCustomerId: session?.customer ? String(session.customer) : null,
      stripeSubscriptionId: session?.subscription ? String(session.subscription) : null,
      shipName: order?.ship_name ? String(order.ship_name) : null,
      shipAddress: order?.ship_address ? String(order.ship_address) : null,
    },
    stripe
  );
}

// Webhook: a subscription ended (deleted by Stripe, or lapsed to a
// canceled/unpaid state). The membership is marked canceled; the row,
// its shelf pick, and its history stay for the admin list. The member
// and the owner both hear about it (CG, 2026-10-31: cancellations
// were silent before): one email each, deduped per membership and
// cancellation, in the branded shell.
// Scheduler pass: comp memberships whose granted window has closed
// flip to canceled, so counts, the admin list, and every status-only
// reader agree with the time-boxed guards above. Silent by design:
// the free year ending is not a cancellation the member caused.
export async function expireCompMemberships(db: DBLike): Promise<number> {
  await ensureClubTable(db);
  const res: any = await db
    .prepare(
      `UPDATE club_signups SET status = 'canceled', subscription_status = 'canceled', canceled_at = ?
       WHERE status = 'paid' AND subscription_status = 'comp' AND comp_until IS NOT NULL AND comp_until <= ?`
    )
    .bind(now(), now())
    .run()
    .catch(() => null);
  return Number(res?.meta?.changes ?? 0);
}

export async function cancelClubBySubscription(db: DBLike, subscriptionId: string): Promise<void> {
  if (!subscriptionId) return;
  await ensureClubTable(db);
  const member: any = await db
    .prepare("SELECT * FROM club_signups WHERE stripe_subscription_id = ? AND status = 'paid'")
    .bind(subscriptionId)
    .first()
    .catch(() => null);
  // A banked comp year (lib/promo.ts: a promo redeemer who was
  // already a member) starts HERE, at the moment the paid
  // subscription ends, instead of the membership ending: the row
  // converts to a comp membership for the rest of its granted
  // window, any scheduled downgrade is moot, and the member hears
  // their free year has begun rather than a cancellation.
  if (member && Number(member.comp_until || 0) > now()) {
    await db
      .prepare(
        `UPDATE club_signups SET subscription_status = 'comp', stripe_subscription_id = NULL,
           downgrade_to_audio_at = NULL, downgrade_audio_period = NULL
         WHERE id = ?`
      )
      .bind(member.id)
      .run();
    try {
      const { enqueueEmail } = await import("./orders");
      await enqueueEmail(db, {
        orderId: null,
        kind: "club_welcome",
        to: String(member.email),
        subject: "Your free year of The Book Club has started",
        text: `Good news: the free year of The Book Club you earned has started, so your membership rolls on with no charge. Your boxes keep coming on the same schedule, and your picks carry over.\n\nManage your boxes: https://bigbrainshelf.com/account/club`,
        dedupeKey: `club-comp-start:${member.id}:${Number(member.comp_until || 0)}`,
      });
    } catch { /* the conversion stands even if the email fails */ }
    return;
  }
  const canceledAt = now();
  const res: any = await db
    .prepare(
      "UPDATE club_signups SET status = 'canceled', subscription_status = 'canceled', canceled_at = ? WHERE stripe_subscription_id = ? AND status = 'paid'"
    )
    .bind(canceledAt, subscriptionId)
    .run();
  if (!member || Number(res?.meta?.changes ?? 0) === 0) return;
  try {
    const { enqueueEmail, OWNER_NOTIFY_EMAIL } = await import("./orders");
    const audio = member.club_plan === "audio";
    const clubName = audio ? "The Audio Club" : "The Book Club";
    const isDowngrade = !audio && Number(member.downgrade_to_audio_at || 0) > 0;
    if (isDowngrade) {
      // The switch the member scheduled: Book Club ended on time and
      // The Audio Club is one tap away in their account. Not a
      // cancellation in tone or in fact.
      await enqueueEmail(db, {
        orderId: null,
        kind: "club_downgrade_ready",
        to: String(member.email),
        subject: "Your membership switched to The Audio Club",
        text: `Your Book Club membership ended today, right on the schedule you set. Boxes already shipped are yours to keep, and books you bought to own stay in your library forever.\n\nYour Audio Club is ready to start: every Big Brain Shelf audiobook in your library while you are a member. One tap in your account starts it.`,
        dedupeKey: `club-downgrade:${member.id}:${canceledAt}`,
      });
    } else {
      await enqueueEmail(db, {
        orderId: null,
        kind: "club_canceled",
        to: String(member.email),
        subject: `Your ${clubName} membership has ended`,
        text: audio
          ? `Your ${clubName} membership has ended, so the club shelf is closed. Any books you bought to own stay in your library forever.\n\nIf this was a mistake, you can rejoin anytime.`
          : `Your ${clubName} membership has ended. Boxes already shipped are yours to keep, and any books you bought to own stay in your library forever.\n\nIf this was a mistake, you can rejoin anytime.`,
        dedupeKey: `club-canceled:${member.id}:${canceledAt}`,
      });
    }
    await enqueueEmail(db, {
      orderId: null,
      kind: "owner_club_canceled",
      to: OWNER_NOTIFY_EMAIL,
      subject: isDowngrade ? `Club downgrade switch: ${member.email}` : `Club cancellation: ${member.email}`,
      text: isDowngrade
        ? `A Book Club membership reached its scheduled switch to The Audio Club. The member still has to start the Audio Club from their account.\n\nMember: ${member.name || member.email} (${member.email})\nAudio period chosen: ${member.downgrade_audio_period || "monthly"}\nMember page: https://bigbrainshelf.com/admin/club/${member.id}`
        : `A ${clubName} membership was canceled.\n\nMember: ${member.name || member.email} (${member.email})\nPlan: ${member.plan || ""}\nMember page: https://bigbrainshelf.com/admin/club/${member.id}`,
      dedupeKey: `owner-club-canceled:${member.id}:${canceledAt}`,
    });
  } catch (err) {
    console.error("club canceled emails failed", (err as any)?.message || err);
  }
}

// Book Club V2: keep the member's billing health current from Stripe
// customer.subscription.updated events. Canceled/unpaid subscriptions
// end the membership (same path as a delete); every other status is
// recorded so cycle generation and locking can pause boxes while a
// payment is past due and resume them when it recovers.
export async function updateClubSubscriptionStatus(
  db: DBLike,
  subscription: any
): Promise<{ tracked: boolean; canceled: boolean }> {
  await ensureClubTable(db);
  const subId = subscription && typeof subscription === "object" ? String(subscription.id || "") : "";
  const status = subscription && typeof subscription.status === "string" ? subscription.status : "";
  if (!subId || !status) return { tracked: false, canceled: false };
  if (status === "canceled" || status === "unpaid") {
    await cancelClubBySubscription(db, subId);
    return { tracked: true, canceled: true };
  }
  const res: any = await db
    .prepare(
      `UPDATE club_signups SET subscription_status = ?,
         payment_failed_at = CASE WHEN ? = 'past_due' THEN COALESCE(payment_failed_at, ?) ELSE payment_failed_at END
       WHERE stripe_subscription_id = ? AND status = 'paid'`
    )
    .bind(status, status, now(), subId)
    .run();
  return { tracked: Number(res?.meta?.changes ?? 0) > 0, canceled: false };
}

function subscriptionIdOfValue(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.id === "string") return value.id;
  return "";
}

// Find the subscription id on a Stripe invoice across API shapes
// (invoice.subscription on older versions; parent.subscription_details
// on newer ones; the first subscription line as a fallback).
export function clubSubscriptionIdFromInvoice(invoice: any): string | null {
  if (!invoice || typeof invoice !== "object") return null;
  const direct = subscriptionIdOfValue(invoice.subscription);
  if (direct) return direct;
  const fromParent = subscriptionIdOfValue(invoice.parent?.subscription_details?.subscription);
  if (fromParent) return fromParent;
  const lines = invoice.lines?.data;
  if (Array.isArray(lines)) {
    for (const line of lines) {
      const id = subscriptionIdOfValue(line?.subscription);
      if (id) return id;
    }
  }
  return null;
}

// invoice.payment_failed parks the membership as past_due (boxes pause;
// nothing ships); invoice.paid / payment_succeeded restores active.
// Canceled memberships are never touched.
export async function recordClubInvoicePayment(
  db: DBLike,
  invoice: any,
  outcome: "failed" | "paid"
): Promise<boolean> {
  await ensureClubTable(db);
  const subId = clubSubscriptionIdFromInvoice(invoice);
  if (!subId) return false;
  const res: any =
    outcome === "failed"
      ? await db
          .prepare(
            "UPDATE club_signups SET subscription_status = 'past_due', payment_failed_at = ? WHERE stripe_subscription_id = ? AND status = 'paid'"
          )
          .bind(now(), subId)
          .run()
      : await db
          .prepare(
            `UPDATE club_signups SET subscription_status = 'active', payment_failed_at = NULL
             WHERE stripe_subscription_id = ? AND status = 'paid' AND subscription_status IN ('past_due', 'incomplete', 'trialing')`
          )
          .bind(subId)
          .run();
  const changed = Number(res?.meta?.changes ?? 0) > 0;
  // A failed renewal tells the member right away (CG, 2026-10-31:
  // past_due used to be silent, members only found out when a box
  // did not come). One email per failed invoice, deduped on it, so
  // Stripe retries never stack copies.
  if (changed && outcome === "failed") {
    try {
      const member: any = await db
        .prepare("SELECT * FROM club_signups WHERE stripe_subscription_id = ? AND status = 'paid'")
        .bind(subId)
        .first();
      if (member?.email) {
        const { enqueueEmail } = await import("./orders");
        const clubName = member.club_plan === "audio" ? "The Audio Club" : "The Book Club";
        await enqueueEmail(db, {
          orderId: null,
          kind: "club_payment_failed",
          to: String(member.email),
          subject: `Payment problem with your ${clubName} membership`,
          text: `We could not charge your card for your ${clubName} membership, so your membership is paused${member.club_plan === "audio" ? "" : " and no new box will ship"} until it is fixed.\n\nUpdate your payment method from your account page and Stripe will retry. If the card on file works now, no action is needed: the retry happens on its own.\n\nYour account: https://bigbrainshelf.com/account`,
          dedupeKey: `club-payfail:${member.id}:${String(invoice?.id || "")}`,
        });
      }
    } catch (err) {
      console.error("club payment failed email failed", (err as any)?.message || err);
    }
  }
  return changed;
}
