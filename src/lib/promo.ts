// Promo codes (CG, 2026-11-01): the launch offer. FOUNDING15 takes
// 15% off a customer's FIRST purchase of $30 or more (merchandise
// subtotal, before shipping), is capped at 10 redemptions total,
// and every redeemer also gets a free year of The Book Club.
//
// How the pieces fit:
// - The discount is hub-side, like the audio-upgrade credit: the
//   checkout validates the code against D1, reprices the Stripe
//   line items, and the order records the code and the discount, so
//   receipts add up exactly (full-price lines, a promo line, total).
// - Validation runs at apply time (signed-in buyers get the full
//   first-purchase rule checked against their account email and
//   id) and again at completion. A guest's email only exists once
//   Stripe collects it, so for guests the first-purchase and
//   one-per-customer rules are enforced at redemption time, when
//   the webhook knows the email; the discount itself is bounded by
//   the subtotal rule and the global cap either way.
// - A reservation row is written when the Stripe session is
//   created, so simultaneous checkouts cannot oversell the cap.
//   Reservations count toward the cap for two hours, then lapse.
// - The free year is a COMP membership (club.ts): a club_signups
//   row with subscription_status 'comp' and comp_until a year out.
//   A redeemer who is already a paying Book Club member banks the
//   year instead: it is stored in comp_until and starts the moment
//   their paid subscription ends (cancelClubBySubscription converts
//   the row instead of ending the membership).

type DBLike = any;

export const PROMO_YEAR_SECONDS = 365 * 86400;
const RESERVATION_WINDOW_SECONDS = 2 * 3600;

const nowSeconds = () => Math.floor(Date.now() / 1000);

let promoEnsured = false;

export async function ensurePromoTables(db: DBLike): Promise<void> {
  if (promoEnsured) return;
  promoEnsured = true;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS promo_codes (
         code TEXT PRIMARY KEY,
         percent_off INTEGER NOT NULL,
         min_subtotal_cents INTEGER NOT NULL DEFAULT 0,
         max_redemptions INTEGER NOT NULL,
         grant_months INTEGER NOT NULL DEFAULT 12,
         active INTEGER NOT NULL DEFAULT 1,
         created_at INTEGER NOT NULL
       )`
    )
    .bind()
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS promo_redemptions (
         id TEXT PRIMARY KEY,
         code TEXT NOT NULL,
         order_id TEXT NOT NULL UNIQUE,
         email TEXT,
         user_id TEXT,
         discount_cents INTEGER NOT NULL DEFAULT 0,
         status TEXT NOT NULL DEFAULT 'reserved',
         note TEXT,
         club_signup_id TEXT,
         created_at INTEGER NOT NULL,
         completed_at INTEGER
       )`
    )
    .bind()
    .run();
  // The seed offer. INSERT OR IGNORE: edits CG makes later in D1
  // (deactivate, raise the cap) are never overwritten by a deploy.
  await db
    .prepare(
      `INSERT OR IGNORE INTO promo_codes
         (code, percent_off, min_subtotal_cents, max_redemptions, grant_months, active, created_at)
       VALUES ('FOUNDING15', 15, 3000, 10, 12, 1, ?)`
    )
    .bind(nowSeconds())
    .run();
  // The order carries its promo so receipts can show the discount
  // line from the order row alone (the receipt builders are sync).
  const { results } = await db.prepare("PRAGMA table_info(orders)").bind().all();
  const have = new Set(((results || []) as any[]).map((r) => String(r.name)));
  for (const [col, type] of Object.entries({
    promo_code: "TEXT",
    promo_discount_cents: "INTEGER",
  })) {
    if (!have.has(col)) {
      await db.prepare(`ALTER TABLE orders ADD COLUMN ${col} ${type}`).bind().run();
    }
  }
}

export function normalizePromoCode(raw: unknown): string {
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
}

/** The discount for a merchandise subtotal, in cents. */
export function promoDiscountCents(subtotalCents: number, percentOff: number): number {
  if (subtotalCents <= 0 || percentOff <= 0) return 0;
  return Math.round((subtotalCents * percentOff) / 100);
}

/**
 * Reduce Stripe line items by exactly `discountCents` in total:
 * each line gives up its proportional share (rounded), and the
 * residual cents land on the largest line, so the session total
 * drops by precisely the discount the buyer was shown.
 */
export function repriceLineItemsWithDiscount(lineItems: any[], discountCents: number): any[] {
  if (!discountCents || discountCents <= 0) return lineItems;
  const totals = lineItems.map(
    (li) => Number(li?.price_data?.unit_amount || 0) * Math.max(1, Number(li?.quantity || 1))
  );
  const subtotal = totals.reduce((a, b) => a + b, 0);
  if (subtotal <= 0) return lineItems;
  const cuts = totals.map((t) => Math.round((discountCents * t) / subtotal));
  let residual = discountCents - cuts.reduce((a, b) => a + b, 0);
  if (residual !== 0) {
    let largest = 0;
    for (let i = 1; i < totals.length; i++) if (totals[i] > totals[largest]) largest = i;
    cuts[largest] += residual;
  }
  return lineItems.map((li, i) => {
    const qty = Math.max(1, Number(li?.quantity || 1));
    const cut = Math.max(0, Math.min(cuts[i], totals[i] - qty)); // keep >= 1 cent per unit
    const newTotal = totals[i] - cut;
    const unit = Math.floor(newTotal / qty);
    const extra = newTotal - unit * qty; // 0..qty-1 cents that cannot split evenly
    const out = { ...li, price_data: { ...li.price_data, unit_amount: Math.max(1, unit) } };
    // An uneven split rides as a quantity-1 companion line so the
    // session total is exact to the cent.
    return extra > 0 && qty > 1 ? [out, { ...li, price_data: { ...li.price_data, unit_amount: extra }, quantity: 1, __remainder: true }] : [out];
  }).flat().map(({ __remainder, ...li }: any) => li);
}

export interface PromoValidation {
  ok: boolean;
  promo?: any;
  discountCents?: number;
  error?: string;
}

async function redemptionCounts(db: DBLike, code: string): Promise<{ completed: number; reserved: number }> {
  const row: any = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'reserved' AND created_at > ? THEN 1 ELSE 0 END) AS reserved
       FROM promo_redemptions WHERE code = ?`
    )
    .bind(nowSeconds() - RESERVATION_WINDOW_SECONDS, code)
    .first();
  return { completed: Number(row?.completed || 0), reserved: Number(row?.reserved || 0) };
}

async function hasCompletedOrder(
  db: DBLike,
  identity: { email?: string; userId?: string },
  excludeOrderId?: string
): Promise<boolean> {
  const email = String(identity.email || "").trim().toLowerCase();
  const userId = String(identity.userId || "");
  const accountId = userId && !userId.startsWith("guest:") ? userId : "";
  if (!email && !accountId) return false;
  const row: any = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM orders
       WHERE status = 'complete' AND id != ?
         AND (LOWER(email) = ? OR (user_id = ? AND user_id != ''))`
    )
    .bind(excludeOrderId || "", email, accountId)
    .first();
  return Number(row?.c || 0) > 0;
}

async function hasRedeemed(
  db: DBLike,
  code: string,
  identity: { email?: string; userId?: string }
): Promise<boolean> {
  const email = String(identity.email || "").trim().toLowerCase();
  const userId = String(identity.userId || "");
  const accountId = userId && !userId.startsWith("guest:") ? userId : "";
  if (!email && !accountId) return false;
  const row: any = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM promo_redemptions
       WHERE code = ? AND status = 'completed'
         AND (LOWER(email) = ? OR (user_id = ? AND user_id != ''))`
    )
    .bind(code, email, accountId)
    .first();
  return Number(row?.c || 0) > 0;
}

/**
 * Validate a code for a checkout in progress. Signed-in buyers are
 * checked against the first-purchase and one-per-customer rules
 * here; guests (no email yet) are checked on those two rules at
 * completion instead. The cap counts completions plus live
 * reservations, so the tenth slot cannot be oversold by parallel
 * checkouts.
 */
export async function validatePromo(
  db: DBLike,
  args: { code: string; email?: string; userId?: string; subtotalCents: number }
): Promise<PromoValidation> {
  await ensurePromoTables(db);
  const code = normalizePromoCode(args.code);
  if (!code) return { ok: false, error: "Enter a promo code." };
  const promo: any = await db.prepare("SELECT * FROM promo_codes WHERE code = ?").bind(code).first();
  if (!promo || Number(promo.active || 0) !== 1) {
    return { ok: false, error: "That code is not a current offer." };
  }
  if (args.subtotalCents < Number(promo.min_subtotal_cents || 0)) {
    return {
      ok: false,
      error: `This code takes 15% off a first order of $${(Number(promo.min_subtotal_cents || 0) / 100).toFixed(0)} or more.`,
    };
  }
  const counts = await redemptionCounts(db, code);
  if (counts.completed + counts.reserved >= Number(promo.max_redemptions || 0)) {
    return { ok: false, error: "All ten spots for this offer have been claimed." };
  }
  const knownIdentity = !!String(args.email || "").trim() || !!String(args.userId || "") && !String(args.userId || "").startsWith("guest:");
  if (knownIdentity) {
    if (await hasRedeemed(db, code, args)) {
      return { ok: false, error: "This code has already been used on your account." };
    }
    if (await hasCompletedOrder(db, args)) {
      return { ok: false, error: "This code is for a first purchase, and your account already has an order." };
    }
  }
  return { ok: true, promo, discountCents: promoDiscountCents(args.subtotalCents, Number(promo.percent_off || 0)) };
}

/** Reserve a redemption slot against a pending order (cap guard). */
export async function reservePromo(
  db: DBLike,
  args: { code: string; orderId: string; email?: string; userId?: string; discountCents: number }
): Promise<void> {
  await ensurePromoTables(db);
  await db
    .prepare(
      `INSERT OR REPLACE INTO promo_redemptions
         (id, code, order_id, email, user_id, discount_cents, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`
    )
    .bind(
      crypto.randomUUID(),
      normalizePromoCode(args.code),
      args.orderId,
      String(args.email || "").trim().toLowerCase() || null,
      String(args.userId || "") || null,
      args.discountCents,
      nowSeconds()
    )
    .run();
  await db
    .prepare("UPDATE orders SET promo_code = ?, promo_discount_cents = ? WHERE id = ?")
    .bind(normalizePromoCode(args.code), args.discountCents, args.orderId)
    .run();
}

async function voidRedemption(db: DBLike, orderId: string, note: string): Promise<void> {
  await db
    .prepare("UPDATE promo_redemptions SET status = 'void', note = ? WHERE order_id = ?")
    .bind(note, orderId)
    .run()
    .catch(() => {});
}

/**
 * The free year, granted at order completion. Returns the club
 * signup id granted or extended, or null when the redemption is
 * void (not a first purchase, already redeemed, cap reached): the
 * discount the buyer already received stands either way, but the
 * club year follows the rules exactly.
 */
export async function grantPromoClubYear(
  db: DBLike,
  site: string,
  args: { order: any; session: any; stripe?: any }
): Promise<string | null> {
  const { order, session, stripe } = args;
  const code = normalizePromoCode(session?.metadata?.promo_code || order?.promo_code || "");
  const email = String(order?.email || "").trim().toLowerCase();
  if (!code || !email || !order?.id) return null;
  await ensurePromoTables(db);
  const promo: any = await db.prepare("SELECT * FROM promo_codes WHERE code = ?").bind(code).first();
  if (!promo) return null;

  let redemption: any = await db
    .prepare("SELECT * FROM promo_redemptions WHERE order_id = ?")
    .bind(String(order.id))
    .first();
  if (redemption?.status === "completed") return redemption.club_signup_id || null;
  if (!redemption) {
    await reservePromo(db, {
      code,
      orderId: String(order.id),
      email,
      userId: String(order.user_id || ""),
      discountCents: Number(order.promo_discount_cents || 0),
    });
    redemption = await db.prepare("SELECT * FROM promo_redemptions WHERE order_id = ?").bind(String(order.id)).first();
  }

  // The two rules a guest could not be checked against at checkout.
  if (await hasRedeemed(db, code, { email, userId: String(order.user_id || "") })) {
    await voidRedemption(db, String(order.id), "already_redeemed");
    return null;
  }
  if (await hasCompletedOrder(db, { email, userId: String(order.user_id || "") }, String(order.id))) {
    await voidRedemption(db, String(order.id), "not_first_purchase");
    return null;
  }
  const counts = await redemptionCounts(db, code);
  if (counts.completed >= Number(promo.max_redemptions || 0)) {
    await voidRedemption(db, String(order.id), "cap_reached");
    return null;
  }

  const { ensureClubTable, getClubSignup, clubPlanOf, clubMembershipActive, grantClubFirstBoxDigital } =
    await import("./club");
  const { generateUpcomingCyclesForMember } = await import("./club-cycles");
  const { chicagoDateString } = await import("./club-cycle-dates");
  const { enqueueEmail, OWNER_NOTIFY_EMAIL } = await import("./orders");
  await ensureClubTable(db);
  // grant_months is 12 for the launch offer: exactly one 365-day year.
  const yearSeconds = Math.round(PROMO_YEAR_SECONDS * (Number(promo.grant_months || 12) / 12));
  const existing: any = await getClubSignup(db, email);
  const accountUserId =
    order.user_id && !String(order.user_id).startsWith("guest:") ? String(order.user_id) : null;

  const finishRedemption = async (signupId: string) => {
    await db
      .prepare(
        `UPDATE promo_redemptions SET status = 'completed', email = ?, club_signup_id = ?, completed_at = ?
         WHERE order_id = ?`
      )
      .bind(email, signupId, nowSeconds(), String(order.id))
      .run();
    return signupId;
  };

  // Already a paying Book Club member: the year banks in comp_until
  // and starts when the paid subscription ends (the conversion
  // lives in cancelClubBySubscription).
  if (
    existing &&
    clubPlanOf(existing) === "physical" &&
    clubMembershipActive(existing) &&
    String(existing.subscription_status || "") !== "comp"
  ) {
    const base = Math.max(Number(existing.comp_until || 0), nowSeconds());
    await db
      .prepare("UPDATE club_signups SET comp_until = ? WHERE id = ?")
      .bind(base + yearSeconds, existing.id)
      .run();
    await enqueueEmail(db, {
      orderId: null,
      kind: "club_welcome",
      to: email,
      subject: "A free year of The Book Club is banked on your account",
      text:
        `Your ${code} order earned you a free year of The Book Club. You are already a member, so the free year is banked: it starts automatically when your current paid membership ends, and your boxes roll on with no charge.\n\n` +
        `See your membership: ${site}/account/club`,
      dedupeKey: `promo-banked:${order.id}`,
    }).catch(() => {});
    await enqueueEmail(db, {
      orderId: null,
      kind: "owner_new_subscription",
      to: OWNER_NOTIFY_EMAIL,
      subject: `Promo ${code}: free year banked for a current member`,
      text: `A ${code} redemption banked a free year of The Book Club for a current paying member.\n\nMember: ${email}\nOrder: ${String(order.id).slice(0, 8).toUpperCase()}\n\nClub list: ${site}/admin/club`,
      dedupeKey: `owner-promo:${order.id}`,
    }).catch(() => {});
    return finishRedemption(String(existing.id));
  }

  // Already inside a comp year: extend it.
  if (existing && String(existing.subscription_status || "") === "comp" && clubMembershipActive(existing)) {
    await db
      .prepare("UPDATE club_signups SET comp_until = comp_until + ? WHERE id = ?")
      .bind(yearSeconds, existing.id)
      .run();
    return finishRedemption(String(existing.id));
  }

  // New or revived membership. An Audio Club subscription still
  // billing in Stripe is cancelled first (the physical club
  // includes listening), mirroring the upgrade path.
  if (existing?.stripe_subscription_id && stripe) {
    try {
      await stripe.subscriptions.cancel(String(existing.stripe_subscription_id));
    } catch { /* best effort; the comp grant stands */ }
  }
  const shipName = order.ship_name ? String(order.ship_name) : null;
  const shipAddress = order.ship_address ? String(order.ship_address) : null;
  let member: any;
  if (existing) {
    await db
      .prepare(
        `UPDATE club_signups SET
           status = 'paid', club_plan = 'physical', plan = 'annual',
           subscription_status = 'comp', comp_until = ?,
           paid_at = ?, first_ship_date = ?, canceled_at = NULL,
           stripe_subscription_id = NULL,
           user_id = COALESCE(?, user_id),
           ship_name = COALESCE(?, ship_name), ship_address = COALESCE(?, ship_address)
         WHERE id = ?`
      )
      .bind(
        nowSeconds() + yearSeconds,
        nowSeconds(),
        chicagoDateString(),
        accountUserId,
        shipName,
        shipAddress,
        existing.id
      )
      .run();
    member = await db.prepare("SELECT * FROM club_signups WHERE id = ?").bind(existing.id).first();
  } else {
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO club_signups
           (id, name, email, shelf, status, created_at, user_id, plan, club_plan,
            subscription_status, comp_until, paid_at, first_ship_date,
            stripe_customer_id, ship_name, ship_address)
         VALUES (?, ?, ?, 'tech', 'paid', ?, ?, 'annual', 'physical',
                 'comp', ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        shipName || email.split("@")[0],
        email,
        nowSeconds(),
        accountUserId,
        nowSeconds() + yearSeconds,
        nowSeconds(),
        chicagoDateString(),
        session?.customer ? String(session.customer) : null,
        shipName,
        shipAddress
      )
      .run();
    member = await db.prepare("SELECT * FROM club_signups WHERE id = ?").bind(id).first();
  }

  // Boxes and the day-one digital grant, the same post-steps a paid
  // join gets. Failures are logged, never fatal: the membership
  // itself is already live.
  try {
    if (member) await generateUpcomingCyclesForMember(db, member);
  } catch (err) {
    console.error("promo comp: cycle generation failed", (err as any)?.message || err);
  }
  try {
    if (member) await grantClubFirstBoxDigital(db, member);
  } catch (err) {
    console.error("promo comp: first-box digital grant failed", (err as any)?.message || err);
  }
  await enqueueEmail(db, {
    orderId: null,
    kind: "club_welcome",
    to: email,
    subject: "Welcome to The Book Club: your first year is free",
    text:
      `You are in, and your first year is on us. Redeeming ${code} with your first order started your free year of The Book Club today.\n\n` +
      `Your first box is being put together: the club book as a gift set, a second printed book you pick (or a surprise), and the club book in digital on day one.\n\n` +
      `Pick your second book: ${site}/account/club\n\n` +
      `Nothing is billed for the year. If you want to keep going after it, membership is $199 a year, and we will ask first.`,
    dedupeKey: `promo-welcome:${order.id}`,
  }).catch(() => {});
  await enqueueEmail(db, {
    orderId: null,
    kind: "owner_new_subscription",
    to: OWNER_NOTIFY_EMAIL,
    subject: `New Book Club member via ${code} (free year)`,
    text: `A ${code} redemption started a free year of The Book Club.\n\nMember: ${email}\nOrder: ${String(order.id).slice(0, 8).toUpperCase()}\n\nClub list: ${site}/admin/club`,
    dedupeKey: `owner-promo:${order.id}`,
  }).catch(() => {});
  return finishRedemption(String(member.id));
}
