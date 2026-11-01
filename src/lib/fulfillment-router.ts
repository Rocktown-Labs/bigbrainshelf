// Pillar 4: Smart Physical Fulfillment Router & Phygital QR/NFC Toy/Book Unlocks
//
// Sits alongside `src/lib/shippo.ts` and routes physical orders (`printed` $20,
// `giftset` $25, quarterly Book Club boxes $60/qtr | $199/yr, and `merch` plushies)
// across three fulfillment modes:
//   - Mode A (`mode_a_home_shippo`): Home studio Shippo label flow (default for
//     US single printed books, signed Gift Sets, and small-batch test runs).
//   - Mode B (`mode_b_pod`): Global Print-on-Demand (Lulu / Gelato API) for
//     international orders (non-US country codes) so international shipping
//     doesn't eat margin on a $20 printed book or $25 Gift Set.
//   - Mode C (`mode_c_3pl`): 3PL Warehouse (ShipBob / Amazon MCF) for bulk
//     quarterly Book Club box waves (2 printed books per box) and plush toys.
//
// Also manages `phygital_claims`: QR / NFC tags inside physical books and plush
// toys (`/claim/[token]`) that unlock the book's digital bundle + bonus audio
// story in the family's `/account` library.

import type { DBLike } from "./orders";
import { ensureOnce } from "./schema-cache";
import {
  GIFT_SET_PRICE_CENTS,
  STANDARD_PRINT_PRICE_CENTS,
  CLUB_PRICE_CENTS,
} from "./offers";

export type FulfillmentMode = "mode_a_home_shippo" | "mode_b_pod" | "mode_c_3pl";

export interface FulfillmentRouteDecision {
  order_id: string;
  mode: FulfillmentMode;
  provider: "shippo" | "lulu_pod" | "gelato_pod" | "shipbob_3pl";
  country_code: string;
  sku_summary: string;
  estimated_cogs_cents: number;
  status: "routed" | "submitted" | "shipped" | "delivered";
  reason: string;
  phygital_tokens: string[];
}

export interface PhygitalClaimRecord {
  token: string;
  sku_type: "printed" | "giftset" | "plush_toy" | "club_box";
  book_slug: string;
  character_slug: string | null;
  bonus_title: string;
  claimed_by_user_id: string | null;
  claimed_by_email: string | null;
  claimed_at: number | null;
  created_at: number;
}

export async function ensureFulfillmentRouterTables(db: DBLike): Promise<void> {
  await ensureOnce(db, "fulfillment_router_tables_v1", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS fulfillment_routes (
          order_id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          provider TEXT NOT NULL,
          country_code TEXT DEFAULT 'US',
          sku_summary TEXT NOT NULL,
          estimated_cogs_cents INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'routed',
          external_reference TEXT,
          payload_json TEXT DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`
      )
      .run();
    await db
      .prepare("CREATE INDEX IF NOT EXISTS fulfillment_routes_mode_idx ON fulfillment_routes(mode, status)")
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS phygital_claims (
          token TEXT PRIMARY KEY,
          sku_type TEXT NOT NULL DEFAULT 'giftset',
          book_slug TEXT NOT NULL,
          character_slug TEXT,
          bonus_title TEXT NOT NULL,
          claimed_by_user_id TEXT,
          claimed_by_email TEXT,
          claimed_at INTEGER,
          created_at INTEGER NOT NULL
        )`
      )
      .run();
    await db
      .prepare("CREATE INDEX IF NOT EXISTS phygital_claims_book_idx ON phygital_claims(book_slug)")
      .run();
    await db
      .prepare("CREATE INDEX IF NOT EXISTS phygital_claims_user_idx ON phygital_claims(claimed_by_user_id)")
      .run();
  });
}

// Route a completed order into Mode A (Home Shippo), Mode B (Global POD), or Mode C (3PL)
// and mint Phygital QR/NFC claim tokens for any physical book, Gift Set ($25), or plush toy.
export async function routePhysicalOrderFulfillment(
  db: DBLike,
  order: {
    id: string;
    book_slugs?: string;
    items?: string | any[];
    shipping_country?: string | null;
    shipping_address?: string | null;
    has_physical?: number | boolean;
    amount?: number;
  },
  opts: { force3plForGiftSets?: boolean } = {}
): Promise<FulfillmentRouteDecision | null> {
  await ensureFulfillmentRouterTables(db);

  let parsedItems: any[] = [];
  if (Array.isArray(order.items)) {
    parsedItems = order.items;
  } else if (typeof order.items === "string" && order.items.trim()) {
    try {
      const p = JSON.parse(order.items);
      if (Array.isArray(p)) parsedItems = p;
    } catch {}
  }

  const physicalFormats = new Set(["printed", "giftset", "merch", "plush", "club_box"]);
  const physItems = parsedItems.filter((it) => physicalFormats.has(String(it?.format || "").toLowerCase()));
  const hasPhysical = Boolean(order.has_physical) || physItems.length > 0;
  if (!hasPhysical) return null;

  let country = String(order.shipping_country || "").toUpperCase().trim();
  if (!country && order.shipping_address) {
    try {
      const addr = JSON.parse(order.shipping_address);
      country = String(addr?.country || "US").toUpperCase().trim();
    } catch {}
  }
  if (!country) country = "US";

  const hasPlushOrClubBox = physItems.some((it) =>
    ["merch", "plush", "club_box"].includes(String(it?.format || "").toLowerCase())
  );
  const totalPhysQty = physItems.reduce((acc, it) => acc + Number(it?.quantity || 1), 0) || 1;
  const isInternational = country !== "US" && country !== "USA";

  let mode: FulfillmentMode = "mode_a_home_shippo";
  let provider: FulfillmentRouteDecision["provider"] = "shippo";
  let reason = `US order (${totalPhysQty} unit${totalPhysQty === 1 ? "" : "s"}) routed to Home Studio Shippo (${STANDARD_PRINT_PRICE_CENTS / 100}/${GIFT_SET_PRICE_CENTS / 100} tier)`;
  let estimatedCogsCents = totalPhysQty * 550; // ~$5.50 home print + media mail label

  if (isInternational) {
    mode = "mode_b_pod";
    provider = "gelato_pod";
    estimatedCogsCents = totalPhysQty * 680; // Local country POD print + local domestic post
    reason = `International destination (${country}) routed to Global Print-on-Demand to eliminate cross-border shipping costs`;
  } else if (hasPlushOrClubBox || totalPhysQty >= 3 || opts.force3plForGiftSets) {
    mode = "mode_c_3pl";
    provider = "shipbob_3pl";
    estimatedCogsCents = totalPhysQty * 390; // Offset bulk print (~$2.50) + 3PL pick/pack
    reason = `Multi-unit / Club / Merch order routed to 3PL Warehouse ($${CLUB_PRICE_CENTS / 100}/qtr box & bulk SKU tier)`;
  }

  const slugs = String(order.book_slugs || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const skuSummary =
    physItems.length > 0
      ? physItems.map((it) => `${it.slug || "item"}:${it.format || "printed"}`).join(", ")
      : slugs.map((s) => `${s}:printed`).join(", ") || "physical_order";

  // Mint Phygital QR/NFC claim tokens for each book in the physical shipment
  const mintedTokens: string[] = [];
  for (const slug of slugs.length > 0 ? slugs : ["mastery"]) {
    const token = `bbs-${slug.slice(0, 8)}-${order.id.slice(-6)}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
    const skuType: PhygitalClaimRecord["sku_type"] = physItems.some((i) => i.format === "giftset")
      ? "giftset"
      : "printed";
    await mintPhygitalClaimToken(db, {
      token,
      skuType,
      bookSlug: slug,
      bonusTitle: `Bonus Read-Along & Printable Pack (${slug})`,
    });
    mintedTokens.push(token);
  }

  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO fulfillment_routes
        (order_id, mode, provider, country_code, sku_summary, estimated_cogs_cents, status, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'routed', ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         mode = excluded.mode,
         provider = excluded.provider,
         country_code = excluded.country_code,
         sku_summary = excluded.sku_summary,
         estimated_cogs_cents = excluded.estimated_cogs_cents,
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`
    )
    .bind(
      order.id,
      mode,
      provider,
      country,
      skuSummary,
      estimatedCogsCents,
      JSON.stringify({ reason, phygitalTokens: mintedTokens }),
      now,
      now
    )
    .run();

  return {
    order_id: order.id,
    mode,
    provider,
    country_code: country,
    sku_summary: skuSummary,
    estimated_cogs_cents: estimatedCogsCents,
    status: "routed",
    reason,
    phygital_tokens: mintedTokens,
  };
}

export async function mintPhygitalClaimToken(
  db: DBLike,
  params: {
    token?: string;
    skuType?: PhygitalClaimRecord["sku_type"];
    bookSlug: string;
    characterSlug?: string | null;
    bonusTitle?: string;
  }
): Promise<PhygitalClaimRecord> {
  await ensureFulfillmentRouterTables(db);
  const now = Math.floor(Date.now() / 1000);
  const token =
    params.token ||
    `claim-${params.bookSlug.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
  const skuType = params.skuType || "giftset";
  const bonusTitle =
    params.bonusTitle || `Bonus Character Audio & Full-Color Read-Along (${params.bookSlug})`;

  await db
    .prepare(
      `INSERT INTO phygital_claims
        (token, sku_type, book_slug, character_slug, bonus_title, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(token) DO NOTHING`
    )
    .bind(token, skuType, params.bookSlug, params.characterSlug || null, bonusTitle, now)
    .run();

  const row: any = await db
    .prepare("SELECT * FROM phygital_claims WHERE token = ?")
    .bind(token)
    .first();

  return {
    token: String(row?.token || token),
    sku_type: (row?.sku_type as PhygitalClaimRecord["sku_type"]) || skuType,
    book_slug: String(row?.book_slug || params.bookSlug),
    character_slug: row?.character_slug ? String(row.character_slug) : null,
    bonus_title: String(row?.bonus_title || bonusTitle),
    claimed_by_user_id: row?.claimed_by_user_id ? String(row.claimed_by_user_id) : null,
    claimed_by_email: row?.claimed_by_email ? String(row.claimed_by_email) : null,
    claimed_at: row?.claimed_at ? Number(row.claimed_at) : null,
    created_at: Number(row?.created_at || now),
  };
}

export async function getPhygitalClaim(
  db: DBLike,
  token: string
): Promise<PhygitalClaimRecord | null> {
  await ensureFulfillmentRouterTables(db);
  const clean = String(token || "").trim().toLowerCase();
  if (!clean) return null;
  const row: any = await db
    .prepare("SELECT * FROM phygital_claims WHERE token = ?")
    .bind(clean)
    .first();
  if (!row) return null;
  return {
    token: String(row.token),
    sku_type: row.sku_type as PhygitalClaimRecord["sku_type"],
    book_slug: String(row.book_slug),
    character_slug: row.character_slug ? String(row.character_slug) : null,
    bonus_title: String(row.bonus_title),
    claimed_by_user_id: row.claimed_by_user_id ? String(row.claimed_by_user_id) : null,
    claimed_by_email: row.claimed_by_email ? String(row.claimed_by_email) : null,
    claimed_at: row.claimed_at ? Number(row.claimed_at) : null,
    created_at: Number(row.created_at),
  };
}

// Redeem a QR/NFC Phygital token for a signed-in parent account: marks the token
// claimed and creates a $0 completed order row for `book_slug` so `getDigitalEntitlements`
// (`src/lib/library.ts`) immediately unlocks the full Digital Bundle + Read-Along in `/account`!
export async function redeemPhygitalClaim(
  db: DBLike,
  token: string,
  user: { id: string; email: string }
): Promise<{
  ok: boolean;
  error?: string;
  alreadyClaimedByYou?: boolean;
  claim?: PhygitalClaimRecord;
}> {
  const claim = await getPhygitalClaim(db, token);
  if (!claim) {
    return { ok: false, error: "This QR/NFC claim code was not found." };
  }
  const email = String(user.email || "").trim().toLowerCase();
  if (claim.claimed_by_user_id && claim.claimed_by_user_id !== user.id && claim.claimed_by_email !== email) {
    return { ok: false, error: "This QR/NFC code has already been claimed by another family account." };
  }
  if (claim.claimed_by_user_id === user.id || (email && claim.claimed_by_email === email)) {
    return { ok: true, alreadyClaimedByYou: true, claim };
  }

  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "UPDATE phygital_claims SET claimed_by_user_id = ?, claimed_by_email = ?, claimed_at = ? WHERE token = ?"
    )
    .bind(user.id, email, now, claim.token)
    .run();

  // Grant ownership in `orders` so `src/lib/library.ts` unlocks the digital bundle & audio
  try {
    const orderId = `phygital_${claim.token}`;
    const itemsJson = JSON.stringify([
      { slug: claim.book_slug, format: "digital", price: 0, quantity: 1 },
    ]);
    await db
      .prepare(
        `INSERT INTO orders (id, user_id, email, book_slugs, amount, currency, status, created_at, items)
         VALUES (?, ?, ?, ?, 0, 'usd', 'complete', ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .bind(orderId, user.id, email, claim.book_slug, now, itemsJson)
      .run();
  } catch {}

  const updated = await getPhygitalClaim(db, claim.token);
  return { ok: true, claim: updated || claim };
}

export async function getFulfillmentRouterSummary(
  db: DBLike
): Promise<{
  byMode: Record<FulfillmentMode, { count: number; cogsCents: number }>;
  recentRoutes: any[];
  phygitalStats: { totalMinted: number; totalClaimed: number };
}> {
  await ensureFulfillmentRouterTables(db);
  const byMode: Record<FulfillmentMode, { count: number; cogsCents: number }> = {
    mode_a_home_shippo: { count: 0, cogsCents: 0 },
    mode_b_pod: { count: 0, cogsCents: 0 },
    mode_c_3pl: { count: 0, cogsCents: 0 },
  };

  const routesRes = await db
    .prepare("SELECT * FROM fulfillment_routes ORDER BY created_at DESC LIMIT 50")
    .all()
    .catch(() => ({ results: [] }));
  const recentRoutes = (routesRes.results || (routesRes as any).rows || []) as any[];
  for (const r of recentRoutes) {
    const m = (r.mode as FulfillmentMode) || "mode_a_home_shippo";
    if (byMode[m]) {
      byMode[m].count += 1;
      byMode[m].cogsCents += Number(r.estimated_cogs_cents || 0);
    }
  }

  const claimsRes = await db
    .prepare(
      "SELECT COUNT(*) as total, SUM(CASE WHEN claimed_at IS NOT NULL THEN 1 ELSE 0 END) as claimed FROM phygital_claims"
    )
    .first()
    .catch(() => null) as any;

  return {
    byMode,
    recentRoutes: recentRoutes.slice(0, 12),
    phygitalStats: {
      totalMinted: Number(claimsRes?.total || 0),
      totalClaimed: Number(claimsRes?.claimed || 0),
    },
  };
}
