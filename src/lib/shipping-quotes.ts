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
}

// Stable identity for "the quote the buyer saw": buyer, destination
// (ZIP drives the rate; the street lines are excluded on purpose so
// carrier standardization between preview and pay, which rewrites
// line1/zip formatting, cannot break the match), and the cart with
// quantities.
export function shippingQuoteFingerprint(input: {
  buyerKey: string;
  state: string;
  zip: string;
  country: string;
  items: { slug: string; format: string; qty?: number }[];
}): string {
  const items = input.items
    .map((i) => `${i.slug}|${i.format}|${Math.max(1, Math.floor(Number(i.qty) || 1))}`)
    .sort()
    .join(",");
  const raw = [
    String(input.buyerKey || ""),
    String(input.state || "").trim().toUpperCase(),
    String(input.zip || "").trim().slice(0, 5),
    String(input.country || "").trim().toUpperCase(),
    items,
  ].join("~");
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
  fingerprint: string
): Promise<string> {
  await ensureShippingQuotesTable(db);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO checkout_shipping_quotes
         (id, fingerprint, carrier, service, amount_cents, estimated_days, shipment_id, rate_id, validated_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  } as LabelQuote;
}
