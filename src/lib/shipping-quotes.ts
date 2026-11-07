// Checkout shipping quotes, persisted between the preview and the
// pay call (fix, 2026-10-31). Before this, checkout.ts quoted Shippo
// twice: once for the preview the buyer confirmed, and again fresh
// inside the pay call. Two live quotes minutes apart can pick
// different cheapest rates (a gift set previewed at UPS Ground Saver
// $6.28 was charged as USPS Ground Advantage $6.36), so the buyer
// was shown one carrier and price and charged another. Now the
// preview quote is stored under an unguessable id, and the pay call
// reuses that exact quote (carrier, service, amount, and Shippo
// rate id) when it is fresh and was issued for the same buyer, cart
// and destination ZIP/state. The charge always matches the preview.
import type { LabelQuote } from "./shippo";
import { ensureOnce } from "./schema-cache";

export const SHIPPING_QUOTE_TTL_SECONDS = 30 * 60;

export async function ensureShippingQuotesTable(db: any): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS checkout_shipping_quotes (
         id TEXT PRIMARY KEY,
         fingerprint TEXT NOT NULL,
         carrier TEXT NOT NULL DEFAULT '',
         service TEXT NOT NULL DEFAULT '',
         amount_cents INTEGER NOT NULL DEFAULT 0,
         estimated_days INTEGER,
         shipment_id TEXT NOT NULL DEFAULT '',
         rate_id TEXT NOT NULL DEFAULT '',
         validated_address TEXT,
         created_at INTEGER NOT NULL
       )`
    )
    .run()
    .catch(() => {});
  // The provider breakdown (slice 2): a Lulu quote's components
  // (shipping, tax, our fulfilment fee) ride the stored quote so
  // the pay call can stamp the exact breakdown on the order even
  // when it reuses the preview instead of re-quoting.
  await ensureOnce(db, "checkout_shipping_quotes.detail", async () => {
    const { results } = await db
      .prepare("SELECT name FROM pragma_table_info('checkout_shipping_quotes')")
      .bind()
      .all()
      .catch(() => ({ results: [] }));
    const have = new Set((results || []).map((r: any) => String(r.name)));
    if (!have.has("detail")) {
      await db.prepare("ALTER TABLE checkout_shipping_quotes ADD COLUMN detail TEXT").bind().run().catch(() => {});
    }
  });
}

// Stable identity for "the quote the buyer saw": buyer, destination
// (ZIP drives the rate; the street lines are excluded on purpose so
// carrier standardization between preview and pay, which rewrites
// line1/zip formatting, cannot break the match), and the cart with
// quantities.
//
// Provider namespacing (slice 2): with no provider named, the raw
// string is byte-for-byte the original Shippo form, so quotes stored
// before the Lulu lane keep matching. A Lulu quote names its
// provider AND keys on the full normalized address (street lines +
// phone): Lulu prices by exact address, so a quote taken for one
// street address must never be reused for another, and a Lulu quote
// can never collide with a Shippo quote for the same cart.
export function shippingQuoteFingerprint(input: {
  buyerKey: string;
  state: string;
  zip: string;
  country: string;
  items: { slug: string; format: string; qty?: number }[];
  provider?: string;
  addressKey?: string;
}): string {
  const items = input.items
    .map((i) => `${i.slug}|${i.format}|${Math.max(1, Math.floor(Number(i.qty) || 1))}`)
    .sort()
    .join(",");
  const parts = [
    String(input.buyerKey || ""),
    String(input.state || "").trim().toUpperCase(),
    String(input.zip || "").trim().slice(0, 5),
    String(input.country || "").trim().toUpperCase(),
    items,
  ];
  if (input.provider) parts.push(`provider=${String(input.provider).trim().toLowerCase()}`);
  if (input.addressKey) parts.push(`addr=${String(input.addressKey).trim()}`);
  const raw = parts.join("~");
  // FNV-1a: the fingerprint only ever compares for equality.
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + ":" + raw.length;
}

export function shippingQuoteFresh(createdAtSec: number, nowSec: number): boolean {
  return createdAtSec > 0 && nowSec - createdAtSec <= SHIPPING_QUOTE_TTL_SECONDS && createdAtSec <= nowSec + 300;
}

export async function storeShippingQuote(
  db: any,
  quote: LabelQuote,
  fingerprint: string,
  detail?: any
): Promise<string> {
  await ensureShippingQuotesTable(db);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO checkout_shipping_quotes
         (id, fingerprint, carrier, service, amount_cents, estimated_days, shipment_id, rate_id, validated_address, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      fingerprint,
      quote.carrier,
      quote.service,
      quote.amountCents,
      quote.estimatedDays,
      quote.shipmentId,
      quote.rateId,
      quote.validatedAddress ? JSON.stringify(quote.validatedAddress) : null,
      detail != null ? JSON.stringify(detail) : null,
      now
    )
    .run();
  // Opportunistic cleanup so the table stays a working set.
  await db
    .prepare("DELETE FROM checkout_shipping_quotes WHERE created_at < ?")
    .bind(now - 24 * 3600)
    .run()
    .catch(() => {});
  return id;
}

export async function loadShippingQuote(
  db: any,
  id: string,
  fingerprint: string
): Promise<LabelQuote | null> {
  if (!id) return null;
  await ensureShippingQuotesTable(db);
  const row: any = await db
    .prepare("SELECT * FROM checkout_shipping_quotes WHERE id = ?")
    .bind(id)
    .first()
    .catch(() => null);
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (String(row.fingerprint) !== fingerprint) return null;
  if (!shippingQuoteFresh(Number(row.created_at) || 0, now)) return null;
  let validatedAddress: any = null;
  try {
    validatedAddress = row.validated_address ? JSON.parse(String(row.validated_address)) : null;
  } catch { /* a bad stored address never blocks the reuse */ }
  let quoteDetail: any = null;
  try {
    quoteDetail = row.detail ? JSON.parse(String(row.detail)) : null;
  } catch { /* a bad stored detail never blocks the reuse */ }
  return {
    carrier: String(row.carrier || ""),
    service: String(row.service || ""),
    amount: ((Number(row.amount_cents) || 0) / 100).toFixed(2),
    amountCents: Number(row.amount_cents) || 0,
    currency: "usd",
    estimatedDays: row.estimated_days == null ? null : Number(row.estimated_days),
    shipmentId: String(row.shipment_id || ""),
    rateId: String(row.rate_id || ""),
    validatedAddress,
    stored: true,
    ...(quoteDetail ? { quoteDetail } : {}),
  } as LabelQuote & { quoteDetail?: any };
}

// ---------------------------------------------------------------------------
// The quote breakdown on the order (slice 2): provider, level,
// shipping, tax, our fulfilment fee, the charged total, and the
// fingerprint the quote was taken under, as one JSON column on the
// order row. Runtime-ensured like the other order quote columns.

export async function ensureOrderShippingDetailColumn(db: any): Promise<void> {
  await ensureOnce(db, "orders.shipping_quote_detail", async () => {
    const { results } = await db
      .prepare("SELECT name FROM pragma_table_info('orders')")
      .bind()
      .all();
    const have = new Set((results || []).map((r: any) => String(r.name)));
    if (!have.has("shipping_quote_detail")) {
      await db.prepare("ALTER TABLE orders ADD COLUMN shipping_quote_detail TEXT").bind().run();
    }
  });
}

export async function storeOrderShippingQuoteDetail(
  db: any,
  orderId: string,
  detail: Record<string, any>
): Promise<void> {
  await ensureOrderShippingDetailColumn(db);
  await db
    .prepare("UPDATE orders SET shipping_quote_detail = ? WHERE id = ? AND status = 'pending'")
    .bind(JSON.stringify(detail), orderId)
    .run();
}
