// Shippo integration: shipping quotes at checkout, and label buying
// for physical fulfillment.
//
// Shipping is charged to the buyer (CG, 2026-10-28: "the customer
// should pay the shipping fee lol. whatever it is, it can be ups or
// usps, idc."), at the quoted carrier rate rounded UP to the next
// whole dollar (CG, 2026-11-03; the round-up covers the label and the
// small drift between a quote and a purchase). At checkout the buyer
// enters a US destination, the hub quotes Shippo server-side for the
// cart's combined parcels, picks a rate with pickRate (cheapest
// qualifying USPS/UPS), and the rounded charge is what the buyer pays.
// The quote (carrier, service, real amount, Shippo shipment + rate
// ids) is stored on the order; at fulfillment the admin buys that
// stored rate at its REAL amount when it is still purchasable, and any
// label-cost difference against what the buyer
// paid is surfaced on the order, never silently absorbed into a
// re-charge.
//
// Label buying stays fully gated on configuration: with no
// SHIPPO_API_KEY worker secret set, shippoConfigured() is false and the
// admin shows a precise checklist of what is missing instead of label
// actions. Labels are only ever bought from an explicit admin click in
// /admin/orders (quote first, then confirm); nothing auto-buys.

import type { DBLike } from "./orders";
import { ensureOnce } from "./schema-cache";

// Parcel defaults per physical format (CG, 2026-10-28: "a few pounds").
// One printed 8.5x11 book ships at 2 lb in an 11.25 x 8.75 mailer; the
// gift set (printed storybook + coloring book + extras) at 3 lb in a
// 12 x 9 x 3 box.
export const PARCEL_BY_FORMAT: Record<
  string,
  { length: string; width: string; height: string; distance_unit: string; weight: string; mass_unit: string }
> = {
  printed: { length: "11.25", width: "8.75", height: "0.75", distance_unit: "in", weight: "2", mass_unit: "lb" },
  giftset: { length: "12", width: "9", height: "3", distance_unit: "in", weight: "3", mass_unit: "lb" },
};

const PHYSICAL_FORMATS = Object.keys(PARCEL_BY_FORMAT);

// The parcel for an order: weights COMBINE across physical items (two
// printed books are 4 lb, not 2), the footprint is the largest item's,
// and heights add because books stack. Digital/audio items add nothing.
// A line's qty multiplies its stack (local clamp mirrors
// lib/orders itemQty; kept local to avoid an import cycle).
export function parcelForItems(items: { format: string; qty?: unknown }[]) {
  const physical = items.filter((i) => PHYSICAL_FORMATS.includes(i.format));
  const pool = physical.length ? physical : [{ format: "printed" }];
  let length = 0, width = 0, height = 0, weight = 0;
  for (const item of pool) {
    const p = PARCEL_BY_FORMAT[item.format] || PARCEL_BY_FORMAT.printed;
    const n = Math.floor(Number((item as any).qty));
    const q = Number.isFinite(n) && n > 1 ? Math.min(99, n) : 1;
    length = Math.max(length, Number(p.length));
    width = Math.max(width, Number(p.width));
    height += Number(p.height) * q;
    weight += Number(p.weight) * q;
  }
  const fmt = (n: number) => String(Math.round(n * 100) / 100);
  return {
    length: fmt(length), width: fmt(width), height: fmt(height),
    distance_unit: "in", weight: fmt(weight), mass_unit: "lb",
  };
}

const SHIPPO_API = "https://api.goshippo.com";

// Every worker var the Shippo setup needs, in checklist order. The admin
// orders page renders shippoStatus().missing verbatim so CG can see
// exactly which pieces are still missing.
export const SHIPPO_ENV_VARS = [
  "SHIPPO_API_KEY",
  "SHIPPO_FROM_NAME",
  "SHIPPO_FROM_STREET1",
  "SHIPPO_FROM_CITY",
  "SHIPPO_FROM_STATE",
  "SHIPPO_FROM_ZIP",
  "SHIPPO_FROM_PHONE",
  "SHIPPO_FROM_EMAIL",
] as const;

export function shippoConfigured(e: any): boolean {
  return Boolean(String(e?.SHIPPO_API_KEY || "").trim());
}

export function shippoMissing(e: any): string[] {
  return SHIPPO_ENV_VARS.filter((k) => !String(e?.[k] || "").trim());
}

export function shippoStatus(e: any): {
  configured: boolean;
  originConfigured: boolean;
  ready: boolean;
  missing: string[];
} {
  const missing = shippoMissing(e);
  return {
    configured: shippoConfigured(e),
    originConfigured: Boolean(shippoOrigin(e)),
    ready: missing.length === 0,
    missing,
  };
}

// Origin (the store's ship-from address) comes from worker env. Returns
// null when any required part is missing so callers can report that the
// origin needs configuring before a label can be bought. Phone and
// email ride along when set (UPS wants a sender phone on the label).
export function shippoOrigin(e: any): {
  name: string; street1: string; city: string; state: string; zip: string; country: string;
  phone: string; email: string;
} | null {
  const origin = {
    name: String(e?.SHIPPO_FROM_NAME || "").trim(),
    // SHIPPO_FROM_STREET1 is the canonical name; STREET is the legacy
    // spelling from the Phase 5 stub and still honored as a fallback.
    street1: String(e?.SHIPPO_FROM_STREET1 || e?.SHIPPO_FROM_STREET || "").trim(),
    city: String(e?.SHIPPO_FROM_CITY || "").trim(),
    state: String(e?.SHIPPO_FROM_STATE || "").trim(),
    zip: String(e?.SHIPPO_FROM_ZIP || "").trim(),
    country: "US",
    phone: String(e?.SHIPPO_FROM_PHONE || "").trim(),
    email: String(e?.SHIPPO_FROM_EMAIL || "").trim(),
  };
  if (!origin.name || !origin.street1 || !origin.city || !origin.state || !origin.zip) return null;
  return origin;
}

async function shippoFetch(e: any, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SHIPPO_API}${path}`, {
    ...init,
    headers: {
      Authorization: `ShippoToken ${e.SHIPPO_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data as any)?.detail || (data as any)?.__all__?.[0] || `Shippo request failed (${res.status})`;
    throw new Error(String(detail));
  }
  return data;
}

export interface ShippoRate {
  object_id: string;
  provider: string;
  servicelevel: { name?: string; token?: string };
  amount: string;
  currency: string;
  estimated_days?: number | null;
  delivery_days?: number | null;
  attributes?: string[];
}

// A rate slower than this only wins when nothing faster exists at all.
export const MAX_SENSIBLE_RATE_DAYS = 7;

// "Cheapest sensible": USPS or UPS only, and among those the cheapest
// rate that is not absurdly slow (a faster-or-equal pool wins first;
// the slow pool is used only when every rate is slow). Shippo rates
// are all tracked for USPS/UPS labels.
export function pickRate(rates: ShippoRate[]): ShippoRate | null {
  const carriers = rates.filter((r) => ["USPS", "UPS"].includes(String(r.provider || "")));
  const pool = carriers.length ? carriers : rates;
  if (!pool.length) return null;
  const timely = pool.filter((r) => r.estimated_days == null || Number(r.estimated_days) <= MAX_SENSIBLE_RATE_DAYS);
  const choose = timely.length ? timely : pool;
  return [...choose].sort((a, b) => Number(a.amount) - Number(b.amount))[0];
}

// A rate's delivery estimate in days: Shippo's newer delivery_days
// wins when present, else the classic estimated_days.
export function rateDays(rate: ShippoRate): number | null {
  return rate.delivery_days ?? rate.estimated_days ?? null;
}

// The FULFILLMENT rate rule (owner, 2026-10-29): 2-day shipping,
// whichever is cheaper between USPS and UPS. Considers only USPS/UPS
// rates that deliver in 2 days (delivery_days / estimated_days <= 2)
// and picks the cheapest. When no 2-day USPS/UPS rate exists, falls
// back to the cheapest USPS/UPS rate overall and says so via
// twoDay: false, so the operator UI surfaces the fallback instead of
// silently shipping slower. Checkout quotes keep pickRate above;
// this rule governs admin label quotes and purchases.
export function chooseRate(rates: ShippoRate[]): { rate: ShippoRate | null; twoDay: boolean } {
  const carriers = rates.filter((r) => ["USPS", "UPS"].includes(String(r.provider || "")));
  if (!carriers.length) return { rate: null, twoDay: false };
  const byPrice = (a: ShippoRate, b: ShippoRate) => Number(a.amount) - Number(b.amount);
  const twoDayPool = carriers.filter((r) => {
    const d = rateDays(r);
    return d != null && d <= 2;
  });
  if (twoDayPool.length) return { rate: [...twoDayPool].sort(byPrice)[0], twoDay: true };
  return { rate: [...carriers].sort(byPrice)[0], twoDay: false };
}

function parseShipAddress(order: any): any | null {
  try {
    const a = JSON.parse(order?.ship_address || "null");
    if (a && (a.line1 || a.city || a.postal_code)) return a;
  } catch { /* fall through */ }
  return null;
}

// The stored address is Stripe Checkout's shipping_details address
// ({line1, line2, city, state, postal_code, country}). Name the fields
// a label actually needs when they are absent, so the admin UI can say
// exactly what is wrong instead of letting Shippo reject a shipment.
export function missingAddressFields(addr: any): string[] {
  if (!addr) return ["line1", "city", "state", "postal_code"];
  const missing: string[] = [];
  if (!String(addr.line1 || "").trim()) missing.push("line1");
  if (!String(addr.city || "").trim()) missing.push("city");
  if (!String(addr.state || "").trim()) missing.push("state");
  if (!String(addr.postal_code || "").trim()) missing.push("postal_code");
  return missing;
}

// Build a ShipDestination from a stored ship_name + ship_address pair
// (the shape both orders and club signups store). Exported for the
// club box label flow, which ships to the member's saved club address.
export function destinationFromStored(
  shipName: unknown,
  shipAddress: unknown
): { ok: true; dest: ShipDestination } | { ok: false; missing: string[] } {
  const addr = parseShipAddress({ ship_address: shipAddress });
  const missing = missingAddressFields(addr);
  if (!addr || missing.length) return { ok: false, missing };
  return {
    ok: true,
    dest: {
      name: String(shipName || ""),
      address: {
        line1: String(addr.line1 || ""),
        line2: String(addr.line2 || ""),
        city: String(addr.city || ""),
        state: String(addr.state || ""),
        postal_code: String(addr.postal_code || ""),
        country: String(addr.country || "US"),
      },
    },
  };
}

function orderItems(order: any): { format: string }[] {
  try {
    const items = JSON.parse(order?.items || "[]");
    return Array.isArray(items) ? items : [];
  } catch { return []; }
}

// Columns the label flow stores beyond the Phase 5 set (chosen service
// level + what the label actually cost). Mirrored in migration.sql and
// ensured at runtime with the same pragma pattern as the outbox
// columns in orders.ts, so a fresh environment self-heals.
const ORDER_LABEL_COLUMNS: Record<string, string> = {
  carrier_service: "TEXT",
  label_cost_cents: "INTEGER",
};

export async function ensureOrderLabelColumns(db: DBLike): Promise<void> {
  await ensureOnce(db, "orders.label_columns", async () => {
    const { results } = await db
      .prepare("SELECT name FROM pragma_table_info('orders')")
      .bind()
      .all();
    const have = new Set((results || []).map((r: any) => String(r.name)));
    for (const [name, type] of Object.entries(ORDER_LABEL_COLUMNS)) {
      if (!have.has(name)) {
        await db.prepare(`ALTER TABLE orders ADD COLUMN ${name} ${type}`).bind().run();
      }
    }
  });
}

// A shipping destination in the store's stored shape: the address half
// matches Stripe Checkout's shipping_details address ({line1, line2,
// city, state, postal_code, country}), which is what orders have
// always stored in ship_address, so parseShipAddress /
// missingAddressFields / the label flow keep working unchanged.
export interface ShipDestination {
  name: string;
  email?: string;
  address: {
    line1: string;
    line2: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  };
}

// Normalize whatever the checkout client sent into a ShipDestination.
// Accepts the stored field names (line1, postal_code) and the common
// aliases (street1, zip). Anything absent stays empty and is reported
// by missingAddressFields at the call site; unknown extra fields (a
// client-sent shipping amount, say) are dropped here and never read
// anywhere in the quote path.
export function normalizeShipDestination(input: any): ShipDestination {
  const a = (input && typeof input === "object" ? input.address ?? input : {}) || {};
  const str = (v: any) => String(v ?? "").trim();
  return {
    name: str(input?.name ?? a?.name),
    email: str(input?.email ?? a?.email) || undefined,
    address: {
      line1: str(a.line1 ?? a.street1),
      line2: str(a.line2 ?? a.street2),
      city: str(a.city),
      state: str(a.state).toUpperCase(),
      postal_code: str(a.postal_code ?? a.zip),
      country: (str(a.country) || "US").toUpperCase(),
    },
  };
}

// Shared shipment creation for checkout quotes and the label quote/buy
// steps. Throws Error with a readable message on any blocker (not
// configured, no origin, incomplete address, no rates upstream).
async function createShipment(
  e: any,
  dest: ShipDestination,
  items: { format: string }[]
): Promise<{ shipment: any; rates: ShippoRate[] }> {
  if (!shippoConfigured(e)) throw new Error("Shippo is not connected yet.");
  const origin = shippoOrigin(e);
  if (!origin) {
    const missing = shippoMissing(e).filter((k) => k !== "SHIPPO_API_KEY");
    throw new Error(
      "Shippo ship-from address is not configured." +
      (missing.length ? ` Missing: ${missing.join(", ")}.` : "")
    );
  }
  const missingFields = missingAddressFields(dest.address);
  if (missingFields.length) {
    throw new Error(`The shipping address is missing: ${missingFields.join(", ")}.`);
  }

  const shipment = await shippoFetch(e, "/shipments/", {
    method: "POST",
    body: JSON.stringify({
      address_from: origin,
      address_to: {
        name: dest.name || dest.email || "Customer",
        street1: dest.address.line1,
        street2: dest.address.line2,
        city: dest.address.city,
        state: dest.address.state,
        zip: dest.address.postal_code,
        country: dest.address.country || "US",
        email: dest.email || "",
        // Opt the destination into Shippo address validation
        // (CG, 2026-10-30): the created Address object comes back
        // stamped with validation_results, which the checkout quote
        // path reads (readAddressValidation below). Validation never
        // blocks the shipment itself; acting on the verdict is the
        // quote path's decision, and fulfillment keeps quoting as
        // before.
        validate: true,
      },
      parcels: [parcelForItems(items)],
      async: false,
    }),
  });
  const rates: ShippoRate[] = Array.isArray(shipment?.rates) ? shipment.rates : [];
  return { shipment, rates };
}

async function createShipmentForOrder(
  e: any,
  order: any
): Promise<{ shipment: any; rates: ShippoRate[] }> {
  const addr = parseShipAddress(order);
  if (!addr) throw new Error("This order has no stored shipping address.");
  return createShipment(
    e,
    {
      name: String(order.ship_name || ""),
      email: String(order.email || ""),
      address: {
        line1: String(addr.line1 || ""),
        line2: String(addr.line2 || ""),
        city: String(addr.city || ""),
        state: String(addr.state || ""),
        postal_code: String(addr.postal_code || ""),
        country: String(addr.country || "US"),
      },
    },
    orderItems(order)
  );
}

export interface LabelQuote {
  carrier: string;
  service: string;
  amount: string;
  amountCents: number;
  currency: string;
  estimatedDays: number | null;
  shipmentId: string;
  rateId: string;
  // True when this quote is the rate the buyer was quoted (and charged)
  // at checkout, recovered from the order's stored Shippo ids rather
  // than from a fresh shipment.
  stored?: boolean;
  // Fulfillment rate rule (chooseRate): true when the quoted rate is
  // a 2-day USPS/UPS rate; false when the quote fell back to the
  // cheapest USPS/UPS rate because no 2-day rate exists for the
  // address. The admin UI surfaces the fallback; never silent.
  twoDay: boolean;
  // Checkout quotes only: Shippo's standardized destination, present
  // when address validation ran on the quote's shipment (the address
  // was created with validate: true). The checkout page adopts these
  // components, so what the buyer confirms is the deliverable address
  // the label is later bought against. Null when Shippo returned no
  // verdict (validation absent, e.g. a non-US passthrough).
  validatedAddress?: ShipDestination["address"] | null;
}

function quoteFromRate(shipment: any, rate: ShippoRate): LabelQuote {
  const days = rateDays(rate);
  return {
    carrier: String(rate.provider || ""),
    service: String(rate.servicelevel?.name || rate.servicelevel?.token || ""),
    amount: String(rate.amount || ""),
    amountCents: Math.round(Number(rate.amount || 0) * 100),
    currency: String(rate.currency || "USD"),
    estimatedDays: days,
    shipmentId: String(shipment?.object_id || ""),
    rateId: String(rate.object_id || ""),
    twoDay: ["USPS", "UPS"].includes(String(rate.provider || "")) && days != null && days <= 2,
  };
}

// ---------------------------------------------------------------------------
// Checkout quotes. The rate a buyer is QUOTED comes ONLY from a Shippo
// rate picked here, server-side, with the same pickRate rule
// fulfillment uses; the checkout route rounds that rate up to the next
// whole dollar for the CHARGE (see the file header). Nothing the
// client sends can name or influence either amount.

// ---------------------------------------------------------------------------
// Address validation (CG, 2026-10-30). createShipment asks Shippo to
// validate the destination (validate: true on address_to), and the
// verdict rides back ON the shipment response: address_to comes back
// as the full created Address object, validation_results included
// (proven live 2026-10-30; neither follow-up read works — a plain
// GET /addresses/{id}/ returns the object WITHOUT the verdict, and
// GET /addresses/{id}/validate/ 404s on this account's API version).
// An explicit "not valid" verdict is a buyer-fixable problem and
// fails the quote with Shippo's own explanation (see
// addressInvalidError; the checkout route maps it to a 400, not the
// generic 503, and the retry wrapper never retries it). A MISSING
// verdict (validation not returned, e.g. a non-US passthrough in
// test mode) never blocks a quote: behavior is then exactly what it
// was before validation existed.

export interface AddressValidation {
  isValid: boolean;
  message: string | null;
  cleaned: ShipDestination["address"];
}

// Buyer-facing error for an address Shippo says is not deliverable.
// Marked so the checkout route can tell it apart from an upstream
// failure and the retry wrapper can refuse to burn a second shipment
// creation on an address that will fail the same way.
export function addressInvalidError(message: string | null): Error {
  const err = new Error(
    "We could not verify that shipping address" +
      (message ? `: ${message}` : ". Please check it and try again.")
  );
  (err as any).addressInvalid = true;
  return err;
}

export function isAddressInvalidError(err: any): boolean {
  return Boolean(err && (err as any).addressInvalid);
}

async function readAddressValidation(e: any, shipment: any): Promise<AddressValidation | null> {
  try {
    // The verdict is read off the shipment response itself:
    // address_to is the created Address object, and its
    // validation_results + standardized fields are the answer. No
    // extra Shippo call is made (see the section comment above for
    // why the follow-up reads do not work on this account).
    const addr =
      shipment?.address_to && typeof shipment.address_to === "object"
        ? shipment.address_to
        : null;
    if (!addr) return null;
    const vr = (addr as any)?.validation_results;
    if (!vr || typeof vr.is_valid !== "boolean") return null;
    const messages = Array.isArray(vr.messages) ? vr.messages : [];
    const first =
      messages.find((m: any) => m && m.type === "address_error") || messages[0];
    return {
      isValid: vr.is_valid,
      message: first?.text ? String(first.text) : null,
      cleaned: {
        line1: String(addr.street1 || ""),
        line2: String(addr.street2 || ""),
        city: String(addr.city || ""),
        state: String(addr.state || ""),
        postal_code: String(addr.zip || ""),
        country: String(addr.country || "US"),
      },
    };
  } catch {
    // The verdict read is a courtesy on top of a successful shipment;
    // it must never be the reason a good quote fails.
    return null;
  }
}

// Quote shipping for a cart headed to a destination. Single attempt;
// callers that face buyers use quoteShippingWithRetry.
export async function quoteShipping(
  e: any,
  dest: ShipDestination,
  items: { format: string }[]
): Promise<LabelQuote> {
  const { shipment, rates } = await createShipment(e, dest, items);
  // The address verdict is read BEFORE the rate pick on purpose: for
  // an undeliverable address the useful answer is Shippo's "why", not
  // a bare "no rates" (and carriers may happily rate a bad address,
  // which is exactly what the gate exists to stop the buyer paying
  // on).
  const validation = await readAddressValidation(e, shipment);
  if (validation && !validation.isValid) {
    throw addressInvalidError(validation.message);
  }
  const rate = pickRate(rates);
  if (!rate) throw new Error("Shippo returned no usable USPS or UPS rates for this address.");
  const quote = quoteFromRate(shipment, rate);
  if (validation) quote.validatedAddress = validation.cleaned;
  return quote;
}

// Checkout-facing quote: one retry on any failure (a transient Shippo
// or network error should not dead-end a sale), then the last error
// propagates so the route can fail the checkout plainly instead of
// ever guessing a fee.
export async function quoteShippingWithRetry(
  e: any,
  dest: ShipDestination,
  items: { format: string }[],
  attempts = 2
): Promise<LabelQuote> {
  let lastErr: any = null;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      return await quoteShipping(e, dest, items);
    } catch (err) {
      // An undeliverable address fails identically on every attempt;
      // retrying would only double the shipment creations (and the
      // wait) before surfacing the same explanation.
      if (isAddressInvalidError(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Shipping quote failed.");
}

// Columns that store the checkout quote on the order: what the buyer
// was told (carrier + service), what they were charged (shipping_cents,
// which predates this change), and the Shippo ids fulfillment needs to
// buy that exact rate later. Same runtime-migration pattern as the
// label columns above; mirrored in migration.sql.
const ORDER_QUOTE_COLUMNS: Record<string, string> = {
  quoted_carrier: "TEXT",
  quoted_service: "TEXT",
  shippo_rate_id: "TEXT",
};

export async function ensureOrderQuoteColumns(db: DBLike): Promise<void> {
  await ensureOnce(db, "orders.quote_columns", async () => {
    const { results } = await db
      .prepare("SELECT name FROM pragma_table_info('orders')")
      .bind()
      .all();
    const have = new Set((results || []).map((r: any) => String(r.name)));
    for (const [name, type] of Object.entries(ORDER_QUOTE_COLUMNS)) {
      if (!have.has(name)) {
        await db.prepare(`ALTER TABLE orders ADD COLUMN ${name} ${type}`).bind().run();
      }
    }
  });
}

// Persist a checkout quote (and the destination it was quoted for) on
// the pending order, together with the order amount the buyer agreed
// to (items + this shipping). Pending-only: a completed order's
// amounts are never rewritten by a later checkout attempt.
export async function storeCheckoutQuote(
  db: DBLike,
  orderId: string,
  args: {
    dest: ShipDestination;
    quote: LabelQuote;
    amount: number;
    // The shipping CHARGE stored on the order (orders.shipping_cents).
    // Since 2026-11-03 the charge is the quoted rate rounded up to the
    // next whole dollar, while the stored shippo_rate_id still buys
    // the label at the quote's real amount. Defaults to the quote
    // amount (the pre-rounding behavior) when a caller does not pass
    // it; the checkout route always passes it.
    shippingCents?: number;
  }
): Promise<void> {
  await ensureOrderQuoteColumns(db);
  await db
    .prepare(
      `UPDATE orders SET
         ship_name = ?, ship_address = ?,
         shipping_cents = ?, quoted_carrier = ?, quoted_service = ?,
         shippo_shipment_id = ?, shippo_rate_id = ?,
         amount = ?
       WHERE id = ? AND status = 'pending'`
    )
    .bind(
      args.dest.name || null,
      JSON.stringify(args.dest.address),
      args.shippingCents ?? args.quote.amountCents,
      args.quote.carrier || null,
      args.quote.service || null,
      args.quote.shipmentId || null,
      args.quote.rateId || null,
      args.amount,
      orderId
    )
    .run();
}

// Rates-only preview (the admin's first step; never purchases).
// Continuity rule: when the order carries a rate quoted at checkout,
// that rate is offered first (it is what the buyer paid for). If the
// stored shipment/rate can no longer be read back, a fresh shipment is
// quoted instead and the admin sees the fresh rate; the difference
// against shipping_cents is displayed on the order either way. The
// shipment id is stored on the order so the confirm step can buy the
// exact rate that was quoted.
export async function getLabelQuote(
  db: DBLike,
  e: any,
  order: any
): Promise<LabelQuote> {
  if (order.label_url) throw new Error("A label has already been bought for this order.");
  if (order.shippo_rate_id && order.shippo_shipment_id && shippoConfigured(e)) {
    try {
      const shipment = await shippoFetch(e, `/shipments/${encodeURIComponent(String(order.shippo_shipment_id))}/`);
      const rates: ShippoRate[] = Array.isArray(shipment?.rates) ? shipment.rates : [];
      const rate = rates.find((r) => String(r.object_id) === String(order.shippo_rate_id));
      if (rate) return { ...quoteFromRate(shipment, rate), stored: true };
    } catch { /* stored rate unreadable: fall through to a fresh quote */ }
  }
  const { shipment, rates } = await createShipmentForOrder(e, order);
  // Fresh fulfillment quotes follow the 2-day rule (chooseRate), not
  // the checkout pickRate rule.
  const picked = chooseRate(rates);
  if (!picked.rate) throw new Error("Shippo returned no usable USPS or UPS rates for this address.");
  await ensureOrderLabelColumns(db);
  await db
    .prepare("UPDATE orders SET shippo_shipment_id = ? WHERE id = ?")
    .bind(String(shipment.object_id || ""), order.id)
    .run();
  return { ...quoteFromRate(shipment, picked.rate), twoDay: picked.twoDay };
}

// Buy the label for an order. With quoteIds (from getLabelQuote) the
// exact quoted rate is purchased; without them a fresh shipment is
// created and its best rate bought. Persists carrier, service,
// tracking number, label URL, label cost and the Shippo ids on the
// order row. Advancing physical_status (and with it the shipped
// email) is the caller's step, via setPhysicalStatus in orders.ts.
export async function buyLabelForOrder(
  db: DBLike,
  e: any,
  order: any,
  quoteIds?: { shipmentId?: string; rateId?: string }
): Promise<{ carrier: string; service: string; trackingNumber: string; labelUrl: string; amountCents: number; rate: ShippoRate }> {
  if (order.label_url) throw new Error("A label has already been bought for this order.");

  let shipment: any = null;
  let rate: ShippoRate | null = null;
  if (quoteIds?.rateId) {
    if (!shippoConfigured(e)) throw new Error("Shippo is not connected yet.");
    shipment = await shippoFetch(e, `/shipments/${encodeURIComponent(String(quoteIds.shipmentId || order.shippo_shipment_id || ""))}/`);
    const rates: ShippoRate[] = Array.isArray(shipment?.rates) ? shipment.rates : [];
    rate = rates.find((r) => String(r.object_id) === String(quoteIds.rateId)) || null;
    if (!rate) throw new Error("That rate is no longer available. Get a fresh rate and try again.");
  } else {
    const created = await createShipmentForOrder(e, order);
    shipment = created.shipment;
    // A direct purchase (no prior quote) follows the same 2-day
    // fulfillment rule as getLabelQuote.
    rate = chooseRate(created.rates).rate;
    if (!rate) throw new Error("Shippo returned no usable USPS or UPS rates for this address.");
  }

  const tx = await shippoFetch(e, "/transactions/", {
    method: "POST",
    body: JSON.stringify({ rate: rate.object_id, label_file_type: "PDF", async: false }),
  });
  if (tx?.status !== "SUCCESS" || !tx?.label_url) {
    const msg = Array.isArray(tx?.messages) && tx.messages.length
      ? String(tx.messages[0]?.text || "Label purchase failed.")
      : "Label purchase failed.";
    throw new Error(msg);
  }
  const carrier = String(rate.provider || "");
  const service = String(rate.servicelevel?.name || rate.servicelevel?.token || "");
  const trackingNumber = String(tx.tracking_number || "");
  const labelUrl = String(tx.label_url || "");
  const amountCents = Math.round(Number(rate.amount || 0) * 100);
  await ensureOrderLabelColumns(db);
  await db
    .prepare(
      `UPDATE orders SET carrier = ?, carrier_service = ?, tracking_number = ?, label_url = ?,
         label_cost_cents = ?, shippo_shipment_id = ?, shippo_transaction_id = ? WHERE id = ?`
    )
    .bind(carrier, service, trackingNumber, labelUrl, amountCents, String(shipment.object_id || ""), String(tx.object_id || ""), order.id)
    .run();
  return { carrier, service, trackingNumber, labelUrl, amountCents, rate };
}

// ---------------------------------------------------------------------------
// Tracking sync (2026-10-29). The scheduled worker poll asks Shippo
// for the carrier status of shipped orders; DELIVERED advances the
// order (in the scheduler, via setPhysicalStatus) and every poll
// stores the carrier's latest human-readable status text here.

const ORDER_TRACKING_COLUMNS: Record<string, string> = {
  tracking_status: "TEXT",
};

export async function ensureOrderTrackingColumns(db: DBLike): Promise<void> {
  await ensureOnce(db, "orders.tracking_columns", async () => {
    const { results } = await db
      .prepare("SELECT name FROM pragma_table_info('orders')")
      .bind()
      .all();
    const have = new Set((results || []).map((r: any) => String(r.name)));
    for (const [name, type] of Object.entries(ORDER_TRACKING_COLUMNS)) {
      if (!have.has(name)) {
        await db.prepare(`ALTER TABLE orders ADD COLUMN ${name} ${type}`).bind().run();
      }
    }
  });
}

// One tracking lookup: GET /tracks/{carrier}/{tracking_number}.
// Returns Shippo's status enum (UNKNOWN, PRE_TRANSIT, TRANSIT,
// DELIVERED, RETURNED, FAILURE) plus the carrier's latest detail
// text. Throws on transport/API errors; the poll catches per order.
export async function getShippoTracking(
  e: any,
  carrier: string,
  trackingNumber: string
): Promise<{ status: string; statusDetails: string }> {
  const token = String(carrier || "").trim().toLowerCase();
  const data = await shippoFetch(
    e,
    `/tracks/${encodeURIComponent(token)}/${encodeURIComponent(String(trackingNumber || ""))}/`
  );
  const ts = (data as any)?.tracking_status || {};
  return {
    status: String(ts.status || "").toUpperCase(),
    statusDetails: String(ts.status_details || ""),
  };
}

// ---------------------------------------------------------------------------
// Carrier pickups (admin redesign S4, 2026-11-03). Shippo's POST
// /pickups exists but covers ONLY USPS and DHL Express carrier
// accounts; UPS and FedEx pickups are NOT offered through Shippo at
// all (docs checked 2026-11-03). USPS pickups are eligible only for
// Priority Mail Express, Priority Mail, international, or return
// parcels: NOT Ground Advantage. The store's labels are typically UPS
// Ground Saver, so in practice the pickup button shows only on a
// USPS Priority-class (or DHL Express) label; everything else is pack
// and drop off, and tracking takes over. One pickup per day max per
// address; a scheduled pickup cannot be edited or canceled through
// Shippo (the carrier and the confirmation code handle changes).

export function pickupEligibleFor(carrier: string, service: string): boolean {
  const c = String(carrier || "").toLowerCase();
  const s = String(service || "").toLowerCase();
  if (c.includes("dhl")) return true;
  if (c.includes("usps")) {
    if (s.includes("ground advantage")) return false;
    return /priority|express|international|return/.test(s);
  }
  return false;
}

// The stored pickup summary a fulfillment view renders: whether the
// button shows (a purchased label of an eligible class), and the
// confirmation once one is scheduled.
export interface PickupState {
  eligible: boolean;
  confirmation: string | null;
  window: string | null;
  scheduledAt: number | null;
}

export function pickupStateFor(row: {
  label_url?: string | null;
  carrier?: string | null;
  carrier_service?: string | null;
  pickup_confirmation?: string | null;
  pickup_window?: string | null;
  pickup_scheduled_at?: number | null;
}): PickupState {
  return {
    eligible: Boolean(row.label_url) && pickupEligibleFor(String(row.carrier || ""), String(row.carrier_service || "")),
    confirmation: row.pickup_confirmation ? String(row.pickup_confirmation) : null,
    window: row.pickup_window ? String(row.pickup_window) : null,
    scheduledAt: row.pickup_scheduled_at ? Number(row.pickup_scheduled_at) : null,
  };
}

// Runtime-ensured pickup columns on orders (the label columns pattern).
const ORDER_PICKUP_COLUMNS: Record<string, string> = {
  pickup_confirmation: "TEXT",
  pickup_window: "TEXT",
  pickup_scheduled_at: "INTEGER",
};

export async function ensureOrderPickupColumns(db: DBLike): Promise<void> {
  await ensureOnce(db, "orders.pickup_columns", async () => {
    const { results } = await db
      .prepare("SELECT name FROM pragma_table_info('orders')")
      .bind()
      .all();
    const have = new Set((results || []).map((r: any) => String(r.name)));
    for (const [name, type] of Object.entries(ORDER_PICKUP_COLUMNS)) {
      if (!have.has(name)) {
        await db.prepare(`ALTER TABLE orders ADD COLUMN ${name} ${type}`).bind().run();
      }
    }
  });
}

// Schedule a pickup for a purchased label through Shippo. Returns the
// confirmation (USPS confirms by email; the response's object id /
// confirmation code is what we keep) and the requested window in words.
// Caller persists; this function only talks to Shippo.
export async function requestPickup(
  e: any,
  args: { carrier: string; transactionId: string; buildingLocationType?: string }
): Promise<{ confirmation: string; windowLabel: string; pickupDate: string }> {
  if (!shippoConfigured(e)) throw new Error("Shippo is not connected yet.");
  const carrier = String(args.carrier || "");
  const accounts = await shippoFetch(e, "/carrier_accounts/");
  const list: any[] = Array.isArray(accounts?.results) ? accounts.results : Array.isArray(accounts) ? accounts : [];
  const want = carrier.toLowerCase();
  const account =
    list.find((a) => String(a?.provider || "").toLowerCase() === want && a?.active !== false) ||
    list.find((a) => String(a?.provider || "").toLowerCase().includes(want.split(" ")[0] || want));
  if (!account?.object_id) throw new Error(`No ${carrier} carrier account is connected in Shippo.`);
  // Tomorrow, Chicago time, inside the carrier's daytime window.
  const now = new Date();
  const chicago = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const start = new Date(chicago);
  start.setDate(start.getDate() + 1);
  start.setHours(8, 0, 0, 0);
  const end = new Date(start);
  end.setHours(16, 0, 0, 0);
  const pickupDate = start.toISOString().slice(0, 10);
  const body = {
    carrier_account: String(account.object_id),
    transactions: [String(args.transactionId || "")],
    requested_start_time: start.toISOString(),
    requested_end_time: end.toISOString(),
    building_location_type: args.buildingLocationType || "front_door",
    instructions: "Packages are packed and labeled at the front door.",
  };
  const res = await shippoFetch(e, "/pickups/", { method: "POST", body: JSON.stringify(body) });
  const confirmation = String(res?.confirmation_code || res?.object_id || "");
  if (!confirmation) throw new Error("Shippo did not confirm the pickup. Try again in a moment.");
  const windowLabel = `${pickupDate} between 8 AM and 4 PM`;
  return { confirmation, windowLabel, pickupDate };
}

export async function schedulePickupForOrder(
  db: DBLike,
  e: any,
  order: any
): Promise<{ confirmation: string; windowLabel: string }> {
  if (!order?.label_url || !order?.shippo_transaction_id) {
    throw new Error("Buy the shipping label first, then request the pickup.");
  }
  if (!pickupEligibleFor(String(order.carrier || ""), String(order.carrier_service || ""))) {
    throw new Error("Shippo pickups cover USPS Priority-class and DHL Express labels only. This label is pack and drop off.");
  }
  if (order.pickup_confirmation) {
    return { confirmation: String(order.pickup_confirmation), windowLabel: String(order.pickup_window || "") };
  }
  const r = await requestPickup(e, {
    carrier: String(order.carrier || ""),
    transactionId: String(order.shippo_transaction_id),
  });
  await ensureOrderPickupColumns(db);
  await db
    .prepare("UPDATE orders SET pickup_confirmation = ?, pickup_window = ?, pickup_scheduled_at = ? WHERE id = ?")
    .bind(r.confirmation, r.windowLabel, Date.now(), order.id)
    .run();
  return { confirmation: r.confirmation, windowLabel: r.windowLabel };
}

// ---------------------------------------------------------------------------
// Labels for an arbitrary destination parcel set: the club box flow.
// A club box ships ONE parcel (the one-parcel combined quote passed
// its gate 2026-10-31) to the member's saved club address. The quote
// and purchase mirror the order versions (createShipment + chooseRate,
// then POST /transactions/) but persist NOTHING: the club API writes
// the result onto the club_cycle_boxes row, whose label columns are
// ensured by lib/club-cycles.ts.

export async function getDestinationLabelQuote(
  e: any,
  dest: ShipDestination,
  items: { format: string }[]
): Promise<LabelQuote> {
  if (!shippoConfigured(e)) throw new Error("Shippo is not connected yet.");
  const { shipment, rates } = await createShipment(e, dest, items);
  const { rate, twoDay } = chooseRate(rates);
  if (!rate) throw new Error("Shippo returned no usable USPS or UPS rates for this address.");
  return { ...quoteFromRate(shipment, rate), twoDay };
}

export async function buyDestinationLabel(
  e: any,
  args: { shipmentId: string; rateId: string }
): Promise<{ carrier: string; service: string; trackingNumber: string; labelUrl: string; amountCents: number; shipmentId: string; transactionId: string }> {
  if (!shippoConfigured(e)) throw new Error("Shippo is not connected yet.");
  const shipment = await shippoFetch(e, `/shipments/${encodeURIComponent(String(args.shipmentId || ""))}/`);
  const rates: ShippoRate[] = Array.isArray(shipment?.rates) ? shipment.rates : [];
  const rate = rates.find((r) => String(r.object_id) === String(args.rateId)) || null;
  if (!rate) throw new Error("That rate is no longer available. Get a fresh rate and try again.");
  const tx = await shippoFetch(e, "/transactions/", {
    method: "POST",
    body: JSON.stringify({ rate: rate.object_id, label_file_type: "PDF", async: false }),
  });
  if (tx?.status !== "SUCCESS" || !tx?.label_url) {
    const msg = Array.isArray(tx?.messages) && tx.messages.length
      ? String(tx.messages[0]?.text || "Label purchase failed.")
      : "Label purchase failed.";
    throw new Error(msg);
  }
  return {
    carrier: String(rate.provider || ""),
    service: String(rate.servicelevel?.name || rate.servicelevel?.token || ""),
    trackingNumber: String(tx.tracking_number || ""),
    labelUrl: String(tx.label_url || ""),
    amountCents: Math.round(Number(rate.amount || 0) * 100),
    shipmentId: String(shipment.object_id || ""),
    transactionId: String(tx.object_id || ""),
  };
}
