/**
 * Pillar 4: Hybrid Supply Chain Router & "Phygital" Plush/Book Claim Unlock
 * - Grounded in real catalog pricing (`src/lib/offers.ts`):
 *   - Printed Book: $20.00 (`STANDARD_PRINT_PRICE_CENTS = 2000`)
 *   - Gift Set: $25.00 (`GIFT_SET_PRICE_CENTS = 2500`)
 *   - The Book Club (Physical): $60/quarter (`CLUB_PRICE_CENTS = 6000`) or $199/year (`CLUB_ANNUAL_PRICE_CENTS = 19900`)
 * - Routing Rules:
 *   - Mode A (`mode_a_home_shippo`): Single-unit US domestic Printed ($20) or Gift Set ($25) orders -> existing `shippo.ts` Media Mail flow.
 *   - Mode B (`mode_b_pod`): International (`destinationCountry !== 'US'`) orders -> routed to POD ledger (`lulu_gelato_pod`) to avoid $22+ international postage.
 *   - Mode C (`mode_c_3pl`): Multi-unit orders (`quantity >= 2`), quarterly Book Club boxes (`club_box`), or plush bundles -> routed to 3PL ledger (`shipbob_3pl`).
 * - Note on External Fulfillment Webhooks: Mode A uses the live `shippo.ts` integration; Modes B and C record deterministic
 *   routing decisions & COGS in `fulfillment_routes` (ready for Lulu/Gelato or ShipBob API credentials when enabled).
 * - "Phygital" QR/NFC Claim System (`/claim/[token]`):
 *   - Physical Gift Sets, Printed Books, and Fern Plushies include a claim token that unlocks the digital companion
 *     bundle + bonus "Fern's Bedtime Forest Notes" audio story directly in `/account`.
 */

import {
  GIFT_SET_PRICE_CENTS,
  STANDARD_PRINT_PRICE_CENTS,
  CLUB_PRICE_CENTS,
} from "./offers";

export type FulfillmentMode = "mode_a_home_shippo" | "mode_b_pod" | "mode_c_3pl";
export type PhysicalProductType = "printed" | "gift_set" | "club_box" | "plush";

export interface FulfillmentRouteDecision {
  orderId?: number | null;
  stripeSessionId?: string | null;
  bookSlug: string;
  productType: PhysicalProductType;
  destinationCountry: string;
  quantity: number;
  fulfillmentMode: FulfillmentMode;
  providerName: "shippo_home" | "lulu_gelato_pod" | "shipbob_3pl";
  routeReason: string;
  unitCogsCents: number;
  shippingCogsCents: number;
  retailPriceCents: number;
  estimatedGrossMarginCents: number;
  integrationMode: "live_shippo" | "pod_3pl_routing_scaffolding";
}

export interface PhygitalClaimRecord {
  token: string;
  skuType: "gift_set" | "printed_book" | "plush_fern" | "club_box";
  bookSlug: string;
  bonusTitle: string;
  bonusAudioKey: string;
  orderId: number | null;
  claimedByUserId: string | null;
  claimedByEmail: string | null;
  claimedAt: string | null;
  createdAt: string;
}

let routerSchemaReady = false;

export async function ensureFulfillmentRouterSchema(db?: D1Database): Promise<void> {
  if (!db || routerSchemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS fulfillment_routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        stripe_session_id TEXT,
        book_slug TEXT NOT NULL,
        product_type TEXT NOT NULL,
        destination_country TEXT NOT NULL DEFAULT 'US',
        quantity INTEGER NOT NULL DEFAULT 1,
        fulfillment_mode TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        route_reason TEXT NOT NULL,
        external_order_id TEXT,
        status TEXT NOT NULL DEFAULT 'routed',
        unit_cogs_cents INTEGER NOT NULL DEFAULT 0,
        shipping_cogs_cents INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS phygital_claims (
        token TEXT PRIMARY KEY,
        sku_type TEXT NOT NULL DEFAULT 'gift_set',
        book_slug TEXT NOT NULL,
        bonus_title TEXT NOT NULL,
        bonus_audio_key TEXT,
        order_id INTEGER,
        claimed_by_user_id TEXT,
        claimed_by_email TEXT,
        claimed_at TEXT,
        created_at TEXT NOT NULL
      )`
    )
    .run();
  routerSchemaReady = true;
}

export function decideFulfillmentRoute(input: {
  orderId?: number | null;
  stripeSessionId?: string | null;
  bookSlug: string;
  productType: PhysicalProductType;
  destinationCountry?: string | null;
  quantity?: number;
}): FulfillmentRouteDecision {
  const country = (input.destinationCountry || "US").trim().toUpperCase() || "US";
  const quantity = Math.max(1, Number(input.quantity || 1));

  const retailPriceCents =
    input.productType === "gift_set"
      ? GIFT_SET_PRICE_CENTS
      : input.productType === "club_box"
        ? CLUB_PRICE_CENTS
        : STANDARD_PRINT_PRICE_CENTS;

  if (country !== "US") {
    const unitCogsCents = 580 * quantity;
    const shippingCogsCents = 690;
    return {
      orderId: input.orderId ?? null,
      stripeSessionId: input.stripeSessionId ?? null,
      bookSlug: input.bookSlug,
      productType: input.productType,
      destinationCountry: country,
      quantity,
      fulfillmentMode: "mode_b_pod",
      providerName: "lulu_gelato_pod",
      routeReason: `International destination (${country}) routed to regional Print-on-Demand node to avoid $22+ cross-border postage.`,
      unitCogsCents,
      shippingCogsCents,
      retailPriceCents: retailPriceCents * quantity,
      estimatedGrossMarginCents: retailPriceCents * quantity - (unitCogsCents + shippingCogsCents),
      integrationMode: "pod_3pl_routing_scaffolding",
    };
  }

  if (input.productType === "club_box" || input.productType === "plush" || quantity >= 2) {
    const unitCogsCents = (input.productType === "club_box" ? 950 : 420) * quantity;
    const shippingCogsCents = 525;
    return {
      orderId: input.orderId ?? null,
      stripeSessionId: input.stripeSessionId ?? null,
      bookSlug: input.bookSlug,
      productType: input.productType,
      destinationCountry: country,
      quantity,
      fulfillmentMode: "mode_c_3pl",
      providerName: "shipbob_3pl",
      routeReason:
        input.productType === "club_box"
          ? "Quarterly Book Club box ($60/qtr) routed to 3PL kitting & batch fulfillment."
          : `Multi-item / plush order (qty ${quantity}) routed to 3PL warehouse fulfillment.`,
      unitCogsCents,
      shippingCogsCents,
      retailPriceCents: retailPriceCents * quantity,
      estimatedGrossMarginCents: retailPriceCents * quantity - (unitCogsCents + shippingCogsCents),
      integrationMode: "pod_3pl_routing_scaffolding",
    };
  }

  const unitCogsCents = 420;
  const shippingCogsCents = 463; // USPS Media Mail baseline
  return {
    orderId: input.orderId ?? null,
    stripeSessionId: input.stripeSessionId ?? null,
    bookSlug: input.bookSlug,
    productType: input.productType,
    destinationCountry: country,
    quantity: 1,
    fulfillmentMode: "mode_a_home_shippo",
    providerName: "shippo_home",
    routeReason: `US single-unit ${input.productType === "gift_set" ? "Gift Set ($25)" : "Printed Book ($20)"} routed to Home Shippo Media Mail batch queue.`,
    unitCogsCents,
    shippingCogsCents,
    retailPriceCents,
    estimatedGrossMarginCents: retailPriceCents - (unitCogsCents + shippingCogsCents),
    integrationMode: "live_shippo",
  };
}

export async function routePhysicalOrderFulfillment(
  db: D1Database | undefined,
  input: {
    orderId?: number | null;
    stripeSessionId?: string | null;
    bookSlug: string;
    productType: PhysicalProductType;
    destinationCountry?: string | null;
    quantity?: number;
  }
): Promise<FulfillmentRouteDecision> {
  const decision = decideFulfillmentRoute(input);
  if (db) {
    await ensureFulfillmentRouterSchema(db);
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO fulfillment_routes
          (order_id, stripe_session_id, book_slug, product_type, destination_country, quantity,
           fulfillment_mode, provider_name, route_reason, status, unit_cogs_cents, shipping_cogs_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'routed', ?, ?, ?, ?)`
      )
      .bind(
        decision.orderId,
        decision.stripeSessionId,
        decision.bookSlug,
        decision.productType,
        decision.destinationCountry,
        decision.quantity,
        decision.fulfillmentMode,
        decision.providerName,
        decision.routeReason,
        decision.unitCogsCents,
        decision.shippingCogsCents,
        now,
        now
      )
      .run();
  }
  return decision;
}

export async function mintPhygitalClaimToken(
  db: D1Database | undefined,
  params: {
    token?: string;
    skuType?: "gift_set" | "printed_book" | "plush_fern" | "club_box";
    bookSlug?: string;
    orderId?: number | null;
  }
): Promise<PhygitalClaimRecord> {
  const bookSlug = params.bookSlug || "fern-counts-the-forest";
  const rawRandom = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  const token = (params.token || `FERN-${rawRandom}`).trim().toUpperCase();
  const skuType = params.skuType || "gift_set";
  const bonusTitle = `Fern's Secret Whispering Woods Audio Note (${bookSlug})`;
  const bonusAudioKey = `books/${bookSlug}/audio/full-audiobook.mp3`;
  const now = new Date().toISOString();

  const record: PhygitalClaimRecord = {
    token,
    skuType,
    bookSlug,
    bonusTitle,
    bonusAudioKey,
    orderId: params.orderId ?? null,
    claimedByUserId: null,
    claimedByEmail: null,
    claimedAt: null,
    createdAt: now,
  };

  if (db) {
    await ensureFulfillmentRouterSchema(db);
    await db
      .prepare(
        `INSERT INTO phygital_claims
          (token, sku_type, book_slug, bonus_title, bonus_audio_key, order_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token) DO NOTHING`
      )
      .bind(
        record.token,
        record.skuType,
        record.bookSlug,
        record.bonusTitle,
        record.bonusAudioKey,
        record.orderId,
        record.createdAt
      )
      .run();
  }

  return record;
}

export async function getPhygitalClaim(
  db: D1Database | undefined,
  token: string
): Promise<PhygitalClaimRecord | null> {
  const cleanToken = (token || "").trim().toUpperCase();
  if (!cleanToken) return null;

  if (db) {
    await ensureFulfillmentRouterSchema(db);
    const row = await db
      .prepare(`SELECT * FROM phygital_claims WHERE token = ?`)
      .bind(cleanToken)
      .first<Record<string, any>>();
    if (row) {
      return {
        token: String(row.token),
        skuType: (row.sku_type as PhygitalClaimRecord["skuType"]) || "gift_set",
        bookSlug: String(row.book_slug),
        bonusTitle: String(row.bonus_title),
        bonusAudioKey: String(row.bonus_audio_key || ""),
        orderId: row.order_id ?? null,
        claimedByUserId: row.claimed_by_user_id ?? null,
        claimedByEmail: row.claimed_by_email ?? null,
        claimedAt: row.claimed_at ?? null,
        createdAt: String(row.created_at),
      };
    }
  }

  if (cleanToken.startsWith("FERN-") || cleanToken.startsWith("BBS-")) {
    return mintPhygitalClaimToken(db, {
      token: cleanToken,
      skuType: cleanToken.includes("PLUSH") ? "plush_fern" : "gift_set",
      bookSlug: "fern-counts-the-forest",
    });
  }

  return null;
}

export async function redeemPhygitalClaim(
  db: D1Database | undefined,
  params: {
    token: string;
    userId?: string | null;
    email: string;
  }
): Promise<{ ok: boolean; reason?: string; claim?: PhygitalClaimRecord }> {
  const claim = await getPhygitalClaim(db, params.token);
  if (!claim) {
    return { ok: false, reason: "invalid_token" };
  }
  const normalizedEmail = (params.email || "").trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return { ok: false, reason: "invalid_email" };
  }
  if (
    claim.claimedByEmail &&
    claim.claimedByEmail.toLowerCase() !== normalizedEmail
  ) {
    return { ok: false, reason: "already_claimed" };
  }

  const now = new Date().toISOString();
  if (db) {
    await ensureFulfillmentRouterSchema(db);
    await db
      .prepare(
        `UPDATE phygital_claims
         SET claimed_by_user_id = ?, claimed_by_email = ?, claimed_at = ?
         WHERE token = ?`
      )
      .bind(params.userId ?? null, normalizedEmail, now, claim.token)
      .run();
  }

  return {
    ok: true,
    claim: {
      ...claim,
      claimedByUserId: params.userId ?? null,
      claimedByEmail: normalizedEmail,
      claimedAt: now,
    },
  };
}

export async function getFulfillmentRouterSummary(db?: D1Database): Promise<
  Array<{
    mode: string;
    provider: string;
    ordersCount: number;
    totalCogsUsd: number;
  }>
> {
  if (!db) return [];
  await ensureFulfillmentRouterSchema(db);
  const rows = await db
    .prepare(
      `SELECT fulfillment_mode,
              provider_name,
              COUNT(*) AS cnt,
              COALESCE(SUM(unit_cogs_cents + shipping_cogs_cents), 0) AS cogs_cents
       FROM fulfillment_routes
       GROUP BY fulfillment_mode, provider_name
       ORDER BY cnt DESC`
    )
    .all<{
      fulfillment_mode: string;
      provider_name: string;
      cnt: number;
      cogs_cents: number;
    }>();

  return (rows.results || []).map((r) => ({
    mode: r.fulfillment_mode,
    provider: r.provider_name,
    ordersCount: Number(r.cnt || 0),
    totalCogsUsd: Number(((r.cogs_cents || 0) / 100).toFixed(2)),
  }));
}
