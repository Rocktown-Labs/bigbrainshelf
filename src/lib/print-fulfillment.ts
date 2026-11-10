import { releasedPrintable, recordPrintReleaseItem, verifyPrintReleaseItem } from './print-release';
import { openReleaseArtifact } from './artifact-releases';
// Print fulfillment (Lulu lane): the registry of print-ready files,
// the print jobs built from paid orders and locked club boxes, and
// the passes that submit those jobs to Lulu and mirror their
// progress back onto our rows. Placement is automatic: order
// completion and the club box lock build and submit immediately
// (autoPlacePrintJobForOrder, the lock hooks in club-cycles and the
// club admin route), the cron pass retries and syncs, and the Lulu
// webhook (handleLuluWebhookPost) is the fast path into the same
// sync. Sync also enqueues the per-parcel customer emails
// (print_shipped / print_delivered).
//
// Model:
//   printables       one row per (book slug, kind): the POD package,
//                    page count, and R2 keys of the validated print
//                    files. Seeded in code (seedPrintables), not by
//                    data migration, so a new book's files land by
//                    editing one list after they validate.
//   print_jobs       one row per order (or per club box), guarded by
//                    a unique idempotency key. Our status lifecycle:
//                    queued -> submitted -> (canceled | failed), plus
//                    blocked_no_printable when a needed file is not
//                    registered yet. Lulu's own status name rides in
//                    lulu_status once the job is submitted.
//   print_job_items  one row per physical book in the job. A gift
//                    set is two items (story + coloring) in the SAME
//                    job so the set ships as one parcel set. Every
//                    story item is personalized: its interior is a
//                    per-copy file with the dedication page (and the
//                    copy's serial) printed inside, because the
//                    serial is minted here, at job creation, before
//                    the book exists.
//   shipments        one row per shipped line item (Lulu ships per
//                    line item, so parcels are tracked per item).
//   print_file_tokens  unguessable, expiring URLs Lulu fetches the
//                    print files from (/api/print-file/{token}); the
//                    buyer download route is never handed to Lulu.
//
// Schema lands through the runtime ensure pattern (lib/schema-cache),
// like serials and the outbox columns: no migration.sql edits, and
// test databases bootstrap themselves on first call.
//
// Order physical_status is DERIVED here for Lulu orders and written
// to the column directly. The home flow's setPhysicalStatus (which
// enqueues the physical_update_* emails about a home-packed parcel)
// is never used for Lulu orders: their books are not packed at home.

import { enqueueEmail, type DBLike } from "./orders";
import { ensureOnce } from "./schema-cache";
import { getOrMintSerial, mintOrderPrintSerials, serialLabel, type BookSerial } from "./serials";
import { stampPdfForPrint } from "./pdf-stamp";
import {
  cancelPrintJob as luluCancelPrintJob,
  costCalculation,
  createPrintJob,
  getPrintJob,
  getPrintJobStatus,
  luluConfigured,
  luluCredsPresent,
  luluEnvName,
  luluStatusName,
  normalizeLuluAddress,
  sha256Hex,
  verifyLuluWebhookSignature,
  LULU_TERMINAL_STATUSES,
  type LuluAddress,
  type LuluCostLineItem,
} from "./lulu";
import type { LabelQuote } from "./shippo";

export { luluConfigured };

const nowSeconds = () => Math.floor(Date.now() / 1000);
const PRODUCTION_DELAY_MINUTES = 120;
const SHIPPING_LEVEL = "MAIL";
const MAX_SUBMIT_ATTEMPTS = 5;
const FILE_TOKEN_TTL_SECONDS = 7 * 24 * 3600;
const CONTACT_EMAIL = "cg@rocktownlabs.com";

// ---------------------------------------------------------------------------
// Schema + registry

export async function ensurePrintSchema(db: DBLike): Promise<void> {
  await ensureOnce(db, "print_fulfillment", async () => {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS printables (
         slug TEXT NOT NULL,
         kind TEXT NOT NULL,
         pod_package_id TEXT NOT NULL,
         interior_pages INTEGER NOT NULL,
         interior_key TEXT NOT NULL,
         cover_key TEXT NOT NULL,
         validation_status TEXT,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (slug, kind)
       )`
    ).bind().run();
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS print_jobs (
         id TEXT PRIMARY KEY,
         order_id TEXT,
         club_box_id TEXT,
         idempotency_key TEXT NOT NULL UNIQUE,
         contact_email TEXT,
         ship_name TEXT,
         ship_address TEXT,
         shipping_level TEXT NOT NULL DEFAULT 'MAIL',
         production_delay INTEGER NOT NULL DEFAULT 120,
         status TEXT NOT NULL DEFAULT 'queued',
         lulu_job_id TEXT,
         lulu_status TEXT,
         has_partial INTEGER NOT NULL DEFAULT 0,
         total_cost_incl_tax TEXT,
         currency TEXT,
         attempts INTEGER NOT NULL DEFAULT 0,
         last_error TEXT,
         notes TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`
    ).bind().run();
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS print_job_items (
         id TEXT PRIMARY KEY,
         job_id TEXT NOT NULL,
         external_id TEXT NOT NULL,
         slug TEXT NOT NULL,
         kind TEXT NOT NULL,
         title TEXT,
         unit_index INTEGER NOT NULL DEFAULT 1,
         dedication_name TEXT,
         serial_label TEXT,
         serial_code TEXT,
         pod_package_id TEXT,
         interior_key TEXT,
         cover_key TEXT,
         interior_pages INTEGER,
         personalized INTEGER NOT NULL DEFAULT 0,
         lulu_line_item_id TEXT,
         status TEXT NOT NULL DEFAULT 'queued',
         tracking_id TEXT,
         tracking_url TEXT,
         carrier_name TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         UNIQUE (job_id, external_id)
       )`
    ).bind().run();
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS shipments (
         id TEXT PRIMARY KEY,
         job_id TEXT NOT NULL,
         job_item_id TEXT NOT NULL UNIQUE,
         order_id TEXT,
         club_box_id TEXT,
         provider TEXT NOT NULL DEFAULT 'lulu',
         carrier_name TEXT,
         tracking_id TEXT,
         tracking_url TEXT,
         status TEXT,
         shipped_at INTEGER,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`
    ).bind().run();
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS print_file_tokens (
         token TEXT PRIMARY KEY,
         r2_key TEXT NOT NULL,
         job_id TEXT,
         job_item_id TEXT,
         expires_at INTEGER NOT NULL,
         created_at INTEGER NOT NULL
       )`
    ).bind().run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_print_jobs_order ON print_jobs (order_id)").bind().run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_print_jobs_box ON print_jobs (club_box_id)").bind().run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_print_job_items_job ON print_job_items (job_id)").bind().run();
  });
}

export interface PrintableSeed {
  slug: string;
  kind: "story" | "coloring";
  podPackageId: string;
  interiorPages: number;
  interiorKey: string;
  coverKey: string;
  validationStatus: string;
}

// The print files that exist and have passed Lulu validation. New
// books join this list only after their files validate in the
// sandbox (slice 1's gate); a job needing an unlisted printable is
// recorded as blocked_no_printable, never guessed at.
export const PRINTABLE_SEEDS: PrintableSeed[] = [
  {
    slug: "mira-the-heron-and-the-still-water",
    kind: "story",
    podPackageId: "0850X1100.FC.STD.PB.060UW444.GXX",
    interiorPages: 43,
    interiorKey: "books/mira-the-heron-and-the-still-water/print/story-interior.pdf",
    coverKey: "books/mira-the-heron-and-the-still-water/print/story-cover.pdf",
    validationStatus: "NORMALIZED",
  },
  {
    slug: "mira-the-heron-and-the-still-water",
    kind: "coloring",
    podPackageId: "0850X1100.BW.STD.PB.060UW444.GXX",
    interiorPages: 44,
    interiorKey: "books/mira-the-heron-and-the-still-water/print/coloring-interior.pdf",
    coverKey: "books/mira-the-heron-and-the-still-water/print/coloring-cover.pdf",
    validationStatus: "NORMALIZED",
  },
  {
    slug: "richdadpoordad",
    kind: "story",
    podPackageId: "0850X1100.FC.STD.PB.060UW444.GXX",
    interiorPages: 43,
    interiorKey: "books/richdadpoordad/print/story-interior.pdf",
    coverKey: "books/richdadpoordad/print/story-cover.pdf",
    validationStatus: "NORMALIZED",
  },
];

export async function seedPrintables(db: DBLike): Promise<void> {
  await ensurePrintSchema(db);
  const ts = nowSeconds();
  for (const seed of PRINTABLE_SEEDS) {
    await db.prepare(
      `INSERT INTO printables (slug, kind, pod_package_id, interior_pages, interior_key, cover_key, validation_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slug, kind) DO UPDATE SET
         pod_package_id = excluded.pod_package_id,
         interior_pages = excluded.interior_pages,
         interior_key = excluded.interior_key,
         cover_key = excluded.cover_key,
         validation_status = excluded.validation_status,
         updated_at = excluded.updated_at`
    ).bind(seed.slug, seed.kind, seed.podPackageId, seed.interiorPages, seed.interiorKey, seed.coverKey, seed.validationStatus, ts).run();
  }
}

export interface Printable {
  slug: string;
  kind: string;
  podPackageId: string;
  interiorPages: number;
  interiorKey: string;
  coverKey: string;
  validationStatus: string | null;
}

export async function getPrintable(db: DBLike, slug: string, kind: string): Promise<Printable | null> {
  await ensurePrintSchema(db);
  const row = await db.prepare("SELECT * FROM printables WHERE slug = ? AND kind = ?").bind(slug, kind).first() as any;
  if (!row) return null;
  return {
    slug: String(row.slug),
    kind: String(row.kind),
    podPackageId: String(row.pod_package_id),
    interiorPages: Number(row.interior_pages),
    interiorKey: String(row.interior_key),
    coverKey: String(row.cover_key),
    validationStatus: row.validation_status ? String(row.validation_status) : null,
  };
}

// ---------------------------------------------------------------------------
// Checkout quoting (slice 2). When the Lulu lane is on, a physical
// cart prices its shipping from Lulu's own cost calculation for the
// exact destination: the printables registry supplies the POD
// package and page count of every physical unit (a gift set is its
// story + coloring pair in the one calculation, mirroring the one
// job it ships as). The buyer's shipping charge is Lulu's shipping
// total including tax plus our $2/order fulfilment fee, and the
// checkout route applies its usual whole-dollar round-up on top.
// The quote rides the checkout flow in the Shippo LabelQuote shape
// (carrier "Lulu", service the shipping level, no rate ids: there is
// no label to buy later, Lulu prints and ships the job itself).

export const LULU_FULFILMENT_FEE_CENTS = 200;
export const LULU_CHECKOUT_SHIPPING_LEVEL = "MAIL";

export interface LuluShippingQuoteDetail {
  provider: "lulu";
  level: string;
  currency: string | null;
  shippingExclTaxCents: number | null;
  shippingTaxCents: number | null;
  shippingInclTaxCents: number;
  fulfillmentFeeCents: number;
  /** Shipping incl. tax + our fee: the pre-round-up charge. */
  chargeCents: number;
}

const dollarsToCents = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * Expand cart lines into Lulu cost line items (grouped by POD
 * package + page count, quantities summed). Returns null when ANY
 * physical unit has no registered printable: the caller fails
 * closed back to the Shippo quote rather than erroring checkout.
 */
export async function resolveLuluQuoteLineItems(
  db: DBLike,
  items: { slug: string; format: string; qty?: number }[]
): Promise<LuluCostLineItem[] | null> {
  await seedPrintables(db);
  const grouped = new Map<string, LuluCostLineItem>();
  const add = async (slug: string, kind: string, qty: number): Promise<boolean> => {
    const p = await getPrintable(db, slug, kind);
    if (!p) return false;
    const key = `${p.podPackageId}|${p.interiorPages}`;
    const cur = grouped.get(key);
    if (cur) cur.quantity = (cur.quantity ?? 1) + qty;
    else grouped.set(key, { pageCount: p.interiorPages, podPackageId: p.podPackageId, quantity: qty });
    return true;
  };
  for (const it of items || []) {
    const qty = itemQty(it);
    if (it.format === "printed") {
      if (!(await add(it.slug, "story", qty))) return null;
    } else if (it.format === "giftset") {
      if (!(await add(it.slug, "story", qty))) return null;
      if (!(await add(it.slug, "coloring", qty))) return null;
    }
  }
  return [...grouped.values()];
}

/**
 * Quote a physical cart's shipping from Lulu. Null when a needed
 * printable is missing (fail closed to Shippo); a Lulu API failure
 * throws, and the caller decides the fallback.
 */
export async function quoteLuluShipping(
  db: DBLike,
  env: any,
  args: {
    items: { slug: string; format: string; qty?: number }[];
    name?: string | null;
    address: {
      line1?: string | null;
      line2?: string | null;
      city?: string | null;
      state?: string | null;
      postal_code?: string | null;
      country?: string | null;
    };
    phone?: string | null;
  }
): Promise<{ quote: LabelQuote; detail: LuluShippingQuoteDetail } | null> {
  const lineItems = await resolveLuluQuoteLineItems(db, args.items);
  if (!lineItems || !lineItems.length) return null;
  const { address } = normalizeLuluAddress({
    name: args.name,
    line1: args.address?.line1,
    line2: args.address?.line2,
    city: args.address?.city,
    state: args.address?.state,
    postal_code: args.address?.postal_code,
    country: args.address?.country,
    phone: args.phone,
  });
  const cost = await costCalculation(env, {
    lineItems,
    shippingAddress: address,
    shippingOption: LULU_CHECKOUT_SHIPPING_LEVEL,
  });
  const shippingInclTaxCents = dollarsToCents(cost.shippingCost);
  if (shippingInclTaxCents === null) {
    throw new Error("Lulu cost calculation returned no shipping cost.");
  }
  const detail: LuluShippingQuoteDetail = {
    provider: "lulu",
    level: LULU_CHECKOUT_SHIPPING_LEVEL,
    currency: cost.currency,
    shippingExclTaxCents: dollarsToCents(cost.shippingCostExclTax),
    shippingTaxCents: dollarsToCents(cost.shippingTax),
    shippingInclTaxCents,
    fulfillmentFeeCents: LULU_FULFILMENT_FEE_CENTS,
    chargeCents: shippingInclTaxCents + LULU_FULFILMENT_FEE_CENTS,
  };
  const quote: LabelQuote = {
    carrier: "Lulu",
    service: LULU_CHECKOUT_SHIPPING_LEVEL,
    amount: (detail.chargeCents / 100).toFixed(2),
    amountCents: detail.chargeCents,
    currency: "usd",
    estimatedDays: null,
    shipmentId: "",
    rateId: "",
    twoDay: false,
    validatedAddress: null,
  };
  return { quote, detail };
}

// ---------------------------------------------------------------------------
// Full job costing (admin cost-price ordering, CG 2026-11-10). The
// shipping quote above reads only the shipping slice of Lulu's cost
// calculation; an admin self-order prices from the WHOLE job cost
// (printing + shipping + fulfilment, tax included) for the cart's
// physical units as the one job they ship as. Unlike the shipping
// quote this reads the cost calculation whenever Lulu credentials
// are configured for the selected environment (sandbox today), even
// while the fulfilment lane itself is off: it places nothing and
// changes no fulfilment state, it only prices. Null when no
// credential pair is configured or any physical unit has no
// registered printable (the caller fails the admin checkout with
// the reason rather than silently charging retail); a Lulu API
// failure throws, same as the shipping quote.

export interface LuluJobCost {
  /** Which Lulu environment priced the job ("sandbox" | "production"). */
  envName: string;
  currency: string | null;
  totalInclTaxCents: number;
  totalExclTaxCents: number | null;
  totalTaxCents: number | null;
  fulfillmentInclTaxCents: number | null;
  shippingInclTaxCents: number | null;
}

export async function quoteLuluJobCost(
  db: DBLike,
  env: any,
  args: {
    items: { slug: string; format: string; qty?: number }[];
    name?: string | null;
    address: {
      line1?: string | null;
      line2?: string | null;
      city?: string | null;
      state?: string | null;
      postal_code?: string | null;
      country?: string | null;
    };
    phone?: string | null;
  }
): Promise<LuluJobCost | null> {
  if (!luluCredsPresent(env)) return null;
  const lineItems = await resolveLuluQuoteLineItems(db, args.items);
  if (!lineItems || !lineItems.length) return null;
  const { address } = normalizeLuluAddress({
    name: args.name,
    line1: args.address?.line1,
    line2: args.address?.line2,
    city: args.address?.city,
    state: args.address?.state,
    postal_code: args.address?.postal_code,
    country: args.address?.country,
    phone: args.phone,
  });
  const cost = await costCalculation(env, {
    lineItems,
    shippingAddress: address,
    shippingOption: LULU_CHECKOUT_SHIPPING_LEVEL,
  });
  const totalInclTaxCents = dollarsToCents(cost.totalCostInclTax);
  if (totalInclTaxCents === null) {
    throw new Error("Lulu cost calculation returned no total cost.");
  }
  return {
    envName: luluEnvName(env),
    currency: cost.currency,
    totalInclTaxCents,
    totalExclTaxCents: dollarsToCents(cost.totalCostExclTax),
    totalTaxCents: dollarsToCents(cost.totalTax),
    fulfillmentInclTaxCents: dollarsToCents(cost.fulfillmentCost),
    shippingInclTaxCents: dollarsToCents(cost.shippingCost),
  };
}

// ---------------------------------------------------------------------------
// Row shapes

export interface PrintJob {
  id: string;
  orderId: string | null;
  clubBoxId: string | null;
  idempotencyKey: string;
  contactEmail: string | null;
  shipName: string | null;
  shipAddress: string | null;
  shippingLevel: string;
  productionDelay: number;
  status: string;
  luluJobId: string | null;
  luluStatus: string | null;
  hasPartial: boolean;
  totalCostInclTax: string | null;
  currency: string | null;
  attempts: number;
  lastError: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PrintJobItem {
  id: string;
  jobId: string;
  externalId: string;
  slug: string;
  kind: string;
  title: string | null;
  unitIndex: number;
  dedicationName: string | null;
  serialLabel: string | null;
  serialCode: string | null;
  podPackageId: string | null;
  interiorKey: string | null;
  coverKey: string | null;
  interiorPages: number | null;
  personalized: boolean;
  luluLineItemId: string | null;
  status: string;
  trackingId: string | null;
  trackingUrl: string | null;
  carrierName: string | null;
}

export interface Shipment {
  id: string;
  jobId: string;
  jobItemId: string;
  orderId: string | null;
  clubBoxId: string | null;
  provider: string;
  carrierName: string | null;
  trackingId: string | null;
  trackingUrl: string | null;
  status: string | null;
  shippedAt: number | null;
}

function rowToJob(row: any): PrintJob {
  return {
    id: String(row.id),
    orderId: row.order_id ? String(row.order_id) : null,
    clubBoxId: row.club_box_id ? String(row.club_box_id) : null,
    idempotencyKey: String(row.idempotency_key),
    contactEmail: row.contact_email ? String(row.contact_email) : null,
    shipName: row.ship_name ? String(row.ship_name) : null,
    shipAddress: row.ship_address ? String(row.ship_address) : null,
    shippingLevel: String(row.shipping_level || "MAIL"),
    productionDelay: Number(row.production_delay || 120),
    status: String(row.status),
    luluJobId: row.lulu_job_id ? String(row.lulu_job_id) : null,
    luluStatus: row.lulu_status ? String(row.lulu_status) : null,
    hasPartial: Number(row.has_partial || 0) === 1,
    totalCostInclTax: row.total_cost_incl_tax ? String(row.total_cost_incl_tax) : null,
    currency: row.currency ? String(row.currency) : null,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error ? String(row.last_error) : null,
    notes: row.notes ? String(row.notes) : null,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

function rowToItem(row: any): PrintJobItem {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    externalId: String(row.external_id),
    slug: String(row.slug),
    kind: String(row.kind),
    title: row.title ? String(row.title) : null,
    unitIndex: Number(row.unit_index || 1),
    dedicationName: row.dedication_name ? String(row.dedication_name) : null,
    serialLabel: row.serial_label ? String(row.serial_label) : null,
    serialCode: row.serial_code ? String(row.serial_code) : null,
    podPackageId: row.pod_package_id ? String(row.pod_package_id) : null,
    interiorKey: row.interior_key ? String(row.interior_key) : null,
    coverKey: row.cover_key ? String(row.cover_key) : null,
    interiorPages: row.interior_pages === null || row.interior_pages === undefined ? null : Number(row.interior_pages),
    personalized: Number(row.personalized || 0) === 1,
    luluLineItemId: row.lulu_line_item_id ? String(row.lulu_line_item_id) : null,
    status: String(row.status),
    trackingId: row.tracking_id ? String(row.tracking_id) : null,
    trackingUrl: row.tracking_url ? String(row.tracking_url) : null,
    carrierName: row.carrier_name ? String(row.carrier_name) : null,
  };
}

function rowToShipment(row: any): Shipment {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    jobItemId: String(row.job_item_id),
    orderId: row.order_id ? String(row.order_id) : null,
    clubBoxId: row.club_box_id ? String(row.club_box_id) : null,
    provider: String(row.provider || "lulu"),
    carrierName: row.carrier_name ? String(row.carrier_name) : null,
    trackingId: row.tracking_id ? String(row.tracking_id) : null,
    trackingUrl: row.tracking_url ? String(row.tracking_url) : null,
    status: row.status ? String(row.status) : null,
    shippedAt: row.shipped_at ? Number(row.shipped_at) : null,
  };
}

export async function getPrintJobById(db: DBLike, jobId: string): Promise<PrintJob | null> {
  await ensurePrintSchema(db);
  const row = await db.prepare("SELECT * FROM print_jobs WHERE id = ?").bind(jobId).first();
  return row ? rowToJob(row) : null;
}

export async function listPrintJobItems(db: DBLike, jobId: string): Promise<PrintJobItem[]> {
  await ensurePrintSchema(db);
  const { results } = await db.prepare(
    "SELECT * FROM print_job_items WHERE job_id = ? ORDER BY created_at ASC, external_id ASC"
  ).bind(jobId).all();
  return (results || []).map(rowToItem);
}

export async function listShipmentsForJob(db: DBLike, jobId: string): Promise<Shipment[]> {
  await ensurePrintSchema(db);
  const { results } = await db.prepare(
    "SELECT * FROM shipments WHERE job_id = ? ORDER BY created_at ASC"
  ).bind(jobId).all();
  return (results || []).map(rowToShipment);
}

export interface PrintJobWithItems extends PrintJob {
  items: PrintJobItem[];
  shipments: Shipment[];
}

async function withItems(db: DBLike, job: PrintJob): Promise<PrintJobWithItems> {
  const [items, shipments] = await Promise.all([
    listPrintJobItems(db, job.id),
    listShipmentsForJob(db, job.id),
  ]);
  return { ...job, items, shipments };
}

/** Every print job recorded against a store order, newest first. */
export async function getPrintJobsForOrder(db: DBLike, orderId: string): Promise<PrintJobWithItems[]> {
  await ensurePrintSchema(db);
  const { results } = await db.prepare(
    "SELECT * FROM print_jobs WHERE order_id = ? ORDER BY created_at DESC"
  ).bind(orderId).all();
  const out: PrintJobWithItems[] = [];
  for (const row of (results || []) as any[]) out.push(await withItems(db, rowToJob(row)));
  return out;
}

/** The print job for a club box, if one has been built. */
export async function getPrintJobForBox(db: DBLike, clubBoxId: string): Promise<PrintJobWithItems | null> {
  await ensurePrintSchema(db);
  const row = await db.prepare("SELECT * FROM print_jobs WHERE club_box_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(clubBoxId).first();
  return row ? withItems(db, rowToJob(row)) : null;
}

async function jobByIdempotencyKey(db: DBLike, key: string): Promise<PrintJob | null> {
  const row = await db.prepare("SELECT * FROM print_jobs WHERE idempotency_key = ?").bind(key).first();
  return row ? rowToJob(row) : null;
}

// ---------------------------------------------------------------------------
// Job building

interface UnitSpec {
  slug: string;
  kind: "story" | "coloring";
  unitIndex: number;
  dedicationName: string | null;
  serial: BookSerial | null;
}

async function bookTitle(db: DBLike, slug: string): Promise<string> {
  const row = await db.prepare("SELECT title FROM books WHERE slug = ?").bind(slug).first() as any;
  return row?.title ? String(row.title) : slug;
}

function producedOnLabel(createdAtSec: number | null | undefined): string | null {
  if (!createdAtSec) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(Number(createdAtSec) * 1000));
  } catch {
    return null;
  }
}


/**
 * Shared builder: one job row plus its item rows from a unit list.
 * Missing printables never throw: the job is recorded as
 * blocked_no_printable with the gap named, so admin can see exactly
 * what to produce next. Story units are personalized (dedication
 * page + serial) into R2 before the job can dispatch.
 */
async function createJobFromUnits(
  db: DBLike,
  env: any,
  args: {
    orderId?: string | null;
    clubBoxId?: string | null;
    idempotencyKey: string;
    contactEmail: string | null;
    shipName: string | null;
    shipAddressRaw: any;
    units: UnitSpec[];
    producedOn: string | null;
  }
): Promise<PrintJobWithItems> {
  await seedPrintables(db);
  const existing = await jobByIdempotencyKey(db, args.idempotencyKey);
  if (existing) return withItems(db, existing);

  const ts = nowSeconds();
  const jobId = crypto.randomUUID();
  const { address, warnings } = normalizeLuluAddress({
    name: args.shipName,
    ...(args.shipAddressRaw && typeof args.shipAddressRaw === "object" ? args.shipAddressRaw : {}),
  });

  // Lulu requires a phone number on the shipping address. Checkout
  // does not collect one yet, so a phone-less order borrows the store
  // fallback carried in the worker env (LULU_FALLBACK_PHONE) and the
  // job notes say so. With no fallback configured the job builds as
  // before and Lulu's own rejection surfaces at dispatch.
  if (!address.phone_number) {
    const fallbackPhone = String(env?.LULU_FALLBACK_PHONE || "").trim().slice(0, 20);
    if (fallbackPhone) {
      address.phone_number = fallbackPhone;
      warnings.push("Shipping phone: store fallback used (order carried no phone).");
    }
  }

  // Resolve printables up front; a single missing file blocks the
  // whole job (a partial parcel set would split the shipment story).
  const printables = new Map<string, Awaited<ReturnType<typeof releasedPrintable>> | null>();
  const missing: string[] = [];
  const missingReasons: string[] = [];
  for (const unit of args.units) {
    const key = `${unit.slug}|${unit.kind}`;
    if (!printables.has(key)) printables.set(key, await releasedPrintable(db, env?.BOOKS, unit.slug, unit.kind).catch((error) => {
      missingReasons.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }));
    if (!printables.get(key) && !missing.includes(key)) missing.push(key);
  }
  const blocked = missing.length > 0;

  await db.prepare(
    `INSERT INTO print_jobs (id, order_id, club_box_id, idempotency_key, contact_email, ship_name,
       ship_address, shipping_level, production_delay, status, last_error, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    jobId,
    args.orderId || null,
    args.clubBoxId || null,
    args.idempotencyKey,
    args.contactEmail,
    address.name || args.shipName || null,
    JSON.stringify(address),
    SHIPPING_LEVEL,
    PRODUCTION_DELAY_MINUTES,
    blocked ? "blocked_no_printable" : "queued",
    blocked ? `No verified frozen printable available for: ${missing.join(", ")}. ${missingReasons.join("; ")}` : null,
    warnings.length ? warnings.join("; ") : null,
    ts,
    ts
  ).run();

  const notes: string[] = warnings.slice();
  let seq = 0;
  for (const unit of args.units) {
    seq += 1;
    const itemId = crypto.randomUUID();
    const printable = printables.get(`${unit.slug}|${unit.kind}`) || null;
    const title = await bookTitle(db, unit.slug);
    let interiorKey: string | null = printable ? printable.interiorKey : null;
    let interiorPages: number | null = printable ? printable.interiorPages : null;
    let personalized = false;
    if (printable && unit.kind === "story" && !blocked) {
      // Personalize: the dedication page goes at the front of the
      // print interior, carrying the dedication name (or the blank
      // write-in line) and the copy's serial. Failure here must not
      // lose the job: fall back to the stock interior and note it.
      try {
        const stock = new Uint8Array(await (await openReleaseArtifact(env?.BOOKS, printable.interior)).arrayBuffer());
        const stamped = await stampPdfForPrint(stock, {
          childName: unit.dedicationName,
          bookTitle: title,
          serialLabel: unit.serial ? serialLabel(unit.serial.volume, unit.serial.serial) : null,
          serialCode: unit.serial ? unit.serial.code : null,
          producedOn: args.producedOn,
        });
        const key = `books/${unit.slug}/print/personalized/${itemId}.pdf`;
        if (!env?.BOOKS || typeof env.BOOKS.put !== "function") throw new Error("R2 BOOKS binding unavailable");
        await env.BOOKS.put(key, stamped, { httpMetadata: { contentType: "application/pdf" } });
        interiorKey = key;
        interiorPages = printable.interiorPages + 1;
        personalized = true;
      } catch (err: any) {
        notes.push(`Personalization failed for ${unit.slug} unit ${unit.unitIndex}: ${err?.message || err}. Stock interior will print.`);
      }
    }
    await db.prepare(
      `INSERT INTO print_job_items (id, job_id, external_id, slug, kind, title, unit_index,
         dedication_name, serial_label, serial_code, pod_package_id, interior_key, cover_key,
         interior_pages, personalized, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      itemId,
      jobId,
      `${jobId}-item-${seq}`,
      unit.slug,
      unit.kind,
      title,
      unit.unitIndex,
      unit.dedicationName,
      unit.serial ? serialLabel(unit.serial.volume, unit.serial.serial) : null,
      unit.serial ? unit.serial.code : null,
      printable ? printable.podPackageId : null,
      interiorKey,
      printable ? printable.coverKey : null,
      interiorPages,
      personalized ? 1 : 0,
      blocked ? "blocked_no_printable" : "queued",
      ts,
      ts
    ).run();
    if (printable) await recordPrintReleaseItem(db, itemId, printable, personalized ? interiorKey : null);
  }
  if (notes.length) {
    await db.prepare("UPDATE print_jobs SET notes = ?, updated_at = ? WHERE id = ?")
      .bind(notes.join("; "), nowSeconds(), jobId).run();
  }
  const job = await getPrintJobById(db, jobId);
  return withItems(db, job!);
}

function parseItemsJson(order: any): any[] {
  try {
    const parsed = JSON.parse(order?.items || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseAddressJson(order: any): any {
  if (order?.ship_address && typeof order.ship_address === "object") return order.ship_address;
  try {
    return JSON.parse(order?.ship_address || "{}");
  } catch {
    return {};
  }
}

const itemQty = (it: any): number => Math.max(1, Math.floor(Number(it?.qty ?? it?.quantity ?? 1)) || 1);

/**
 * Build (or read back) the print job for a paid store order.
 * printed xN -> N story items; giftset xN -> per set one story item
 * and one coloring item in the SAME job. Serials mint here, at job
 * creation, reusing the order mint so the number that prints inside
 * the book is the number the registry already holds for that unit.
 * Returns null when the order has no physical lines.
 */
export async function buildJobsForOrder(
  db: DBLike,
  env: any,
  order: any
): Promise<PrintJobWithItems | null> {
  await ensurePrintSchema(db);
  const key = `order:${order.id}`;
  const existing = await jobByIdempotencyKey(db, key);
  if (existing) return withItems(db, existing);

  const items = parseItemsJson(order);
  const hasPhysical = items.some((it) => it && (it.format === "printed" || it.format === "giftset") && it.slug);
  if (!hasPhysical) return null;

  // Mint first (idempotent): the walk inside mintOrderPrintSerials
  // numbers units per slug in item order, and we re-derive each
  // unit's serial by its grant key below.
  await mintOrderPrintSerials(db, order).catch(() => []);

  const units: UnitSpec[] = [];
  const perSlugCount = new Map<string, number>();
  const nextUnitIndex = (slug: string): number => {
    const idx = (perSlugCount.get(slug) || 0) + 1;
    perSlugCount.set(slug, idx);
    return idx;
  };
  for (const it of items) {
    if (!it || !it.slug) continue;
    const slug = String(it.slug);
    const dedicationName = it.dedicationName ? String(it.dedicationName) : null;
    if (it.format === "printed") {
      for (let n = 0; n < itemQty(it); n++) {
        const unitIndex = nextUnitIndex(slug);
        const serial = await getOrMintSerial(db, {
          bookSlug: slug,
          grantKey: `order:${order.id}:${slug}:print:${unitIndex}`,
          format: "printed",
          orderId: order.id,
        }).catch(() => null);
        units.push({ slug, kind: "story", unitIndex, dedicationName, serial });
      }
    } else if (it.format === "giftset") {
      for (let n = 0; n < itemQty(it); n++) {
        const unitIndex = nextUnitIndex(slug);
        const serial = await getOrMintSerial(db, {
          bookSlug: slug,
          grantKey: `order:${order.id}:${slug}:print:${unitIndex}`,
          format: "giftset",
          orderId: order.id,
        }).catch(() => null);
        units.push({ slug, kind: "story", unitIndex, dedicationName, serial });
        units.push({ slug, kind: "coloring", unitIndex, dedicationName: null, serial: null });
      }
    }
  }
  if (!units.length) return null;

  return createJobFromUnits(db, env, {
    orderId: String(order.id),
    idempotencyKey: key,
    contactEmail: order.email ? String(order.email) : null,
    shipName: order.ship_name ? String(order.ship_name) : null,
    shipAddressRaw: parseAddressJson(order),
    units,
    producedOn: producedOnLabel(order.created_at ? Number(order.created_at) : null),
  });
}

/**
 * Build (or read back) the print job for a locked club box: the two
 * resolved storybooks plus the primary book's coloring book, in one
 * job. The box's own home shipment (the sticker packet) is untouched
 * and stays on the box label flow. Returns null while either slot is
 * unresolved.
 */
export async function buildJobForBox(
  db: DBLike,
  env: any,
  box: any
): Promise<PrintJobWithItems | null> {
  await ensurePrintSchema(db);
  const key = `box:${box.id}`;
  const existing = await jobByIdempotencyKey(db, key);
  if (existing) return withItems(db, existing);

  const slug1 = String(box.resolved_book_slug || box.selected_book_slug || "");
  const slug2 = String(box.second_resolved_book_slug || box.second_selected_book_slug || "");
  if (!slug1 || !slug2) return null;

  const member = await db.prepare(
    "SELECT email, ship_name, ship_address FROM club_signups WHERE id = ?"
  ).bind(String(box.signup_id)).first() as any;

  const serial1 = await getOrMintSerial(db, {
    bookSlug: slug1,
    grantKey: `club-box:${box.id}:${slug1}:slot1`,
    format: "giftset",
    clubBoxId: String(box.id),
  }).catch(() => null);
  const serial2 = await getOrMintSerial(db, {
    bookSlug: slug2,
    grantKey: `club-box:${box.id}:${slug2}:slot2`,
    format: "printed",
    clubBoxId: String(box.id),
  }).catch(() => null);

  const units: UnitSpec[] = [
    { slug: slug1, kind: "story", unitIndex: 1, dedicationName: null, serial: serial1 },
    { slug: slug1, kind: "coloring", unitIndex: 1, dedicationName: null, serial: null },
    { slug: slug2, kind: "story", unitIndex: 1, dedicationName: null, serial: serial2 },
  ];

  let memberAddress: any = {};
  if (member?.ship_address) {
    if (typeof member.ship_address === "object") memberAddress = member.ship_address;
    else { try { memberAddress = JSON.parse(member.ship_address); } catch { memberAddress = {}; } }
  }

  return createJobFromUnits(db, env, {
    clubBoxId: String(box.id),
    idempotencyKey: key,
    contactEmail: member?.email ? String(member.email) : null,
    shipName: member?.ship_name ? String(member.ship_name) : null,
    shipAddressRaw: memberAddress,
    units,
    producedOn: producedOnLabel(box.locked_at ? Number(box.locked_at) : null),
  });
}

/**
 * Auto-place (CG, 2026-11-07: "set the lulu flow so it places the
 * order"): a store order that has completed payment with physical
 * lines builds its print job here and attempts an immediate submit.
 * Called from the completion funnel (processCheckoutCompleted and
 * the $0 in-place completion in /api/checkout). Deliberately total:
 * every failure is logged and swallowed, because the cron dispatcher
 * retries queued jobs on its own tick and a Lulu outage must never
 * fail or stall a customer's completed order. Manual orders
 * (source = 'manual') never auto-place: the admin create_print_job
 * action stays their trigger, so a test order an admin typed in
 * cannot silently spend a print run.
 */
export async function autoPlacePrintJobForOrder(
  db: DBLike,
  env: any,
  order: any,
  site?: string
): Promise<PrintJobWithItems | null> {
  try {
    if (!luluConfigured(env)) return null;
    if (!order || String(order.status || "") !== "complete") return null;
    if (String(order.source || "") === "manual") return null;
    const job = await buildJobsForOrder(db, env, order);
    if (job && job.status === "queued") {
      const outcome = await submitPrintJob(db, env, job, site);
      if (!outcome.ok) {
        console.error("print auto-place submit deferred to cron for job", job.id, outcome.error || "");
      }
      return outcome.job || job;
    }
    return job;
  } catch (err: any) {
    console.error("print auto-place failed for order", String(order?.id || ""), err?.message || err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// File tokens: the URLs Lulu fetches print files from.

/**
 * Resolve a print-file token to its R2 key. Null when the token is
 * unknown or expired; the route turns that into a 404.
 */
export async function resolvePrintFileToken(
  db: DBLike,
  token: string
): Promise<{ r2Key: string; jobId: string | null; jobItemId: string | null } | null> {
  await ensurePrintSchema(db);
  const clean = String(token || "").trim();
  if (!clean) return null;
  const row = await db.prepare("SELECT * FROM print_file_tokens WHERE token = ?").bind(clean).first() as any;
  if (!row) return null;
  if (Number(row.expires_at || 0) <= nowSeconds()) return null;
  return {
    r2Key: String(row.r2_key),
    jobId: row.job_id ? String(row.job_id) : null,
    jobItemId: row.job_item_id ? String(row.job_item_id) : null,
  };
}

async function fileUrlFor(
  db: DBLike,
  site: string,
  job: PrintJob,
  item: PrintJobItem,
  r2Key: string
): Promise<string> {
  const ts = nowSeconds();
  const existing = await db.prepare(
    `SELECT token FROM print_file_tokens
     WHERE job_item_id = ? AND r2_key = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`
  ).bind(item.id, r2Key, ts).first() as any;
  if (existing?.token) return `${site}/api/print-file/${existing.token}`;
  const token = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO print_file_tokens (token, r2_key, job_id, job_item_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(token, r2Key, job.id, item.id, ts + FILE_TOKEN_TTL_SECONDS, ts).run();
  return `${site}/api/print-file/${token}`;
}

function siteBase(env: any, site?: string): string {
  return String(site || env?.BETTER_AUTH_URL || "https://bigbrainshelf.com").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Dispatch: submit queued jobs to Lulu.

export interface SubmitOutcome {
  ok: boolean;
  error?: string;
  job?: PrintJobWithItems;
}

/** Submit one queued job to Lulu now (dispatcher and admin share this). */
export async function submitPrintJob(
  db: DBLike,
  env: any,
  job: PrintJob,
  site?: string
): Promise<SubmitOutcome> {
  await ensurePrintSchema(db);
  if (job.status !== "queued") {
    return { ok: false, error: `job is ${job.status}, not queued`, job: await withItems(db, job) };
  }
  const items = await listPrintJobItems(db, job.id);
  if (!items.length) return { ok: false, error: "job has no items" };
  const base = siteBase(env, site);
  try {
    const address = JSON.parse(job.shipAddress || "{}") as LuluAddress;
    const lineItems = [];
    for (const item of items) {
      if (!item.podPackageId || !item.interiorKey || !item.coverKey) {
        throw new Error(`item ${item.externalId} is missing its printable files`);
      }
      await verifyPrintReleaseItem(db, env?.BOOKS, item);
      lineItems.push({
        externalId: item.externalId,
        title: item.title || item.slug,
        podPackageId: item.podPackageId,
        interiorUrl: await fileUrlFor(db, base, job, item, item.interiorKey),
        coverUrl: await fileUrlFor(db, base, job, item, item.coverKey),
        quantity: 1,
      });
    }
    const created = await createPrintJob(env, {
      contactEmail: job.contactEmail || CONTACT_EMAIL,
      externalId: job.idempotencyKey,
      lineItems,
      shippingAddress: address,
      shippingLevel: job.shippingLevel || SHIPPING_LEVEL,
      productionDelay: job.productionDelay || PRODUCTION_DELAY_MINUTES,
    });
    const luluJobId = created?.id ? String(created.id) : null;
    const luluStatus = luluStatusName(created?.status) || "CREATED";
    const ts = nowSeconds();
    await db.prepare(
      `UPDATE print_jobs SET status = 'submitted', lulu_job_id = ?, lulu_status = ?,
         total_cost_incl_tax = ?, currency = ?, last_error = NULL, updated_at = ? WHERE id = ?`
    ).bind(
      luluJobId,
      luluStatus,
      created?.costs?.total_cost_incl_tax ? String(created.costs.total_cost_incl_tax) : null,
      created?.costs?.currency ? String(created.costs.currency) : null,
      ts,
      job.id
    ).run();
    const createdItems = Array.isArray(created?.line_items) ? created.line_items : [];
    for (const item of items) {
      const match = createdItems.find((li: any) => String(li?.external_id || "") === item.externalId);
      await db.prepare(
        "UPDATE print_job_items SET status = ?, lulu_line_item_id = ?, updated_at = ? WHERE id = ?"
      ).bind(
        match ? luluStatusName(match.status) || "CREATED" : "CREATED",
        match?.id ? String(match.id) : item.luluLineItemId,
        ts,
        item.id
      ).run();
    }
    const fresh = await getPrintJobById(db, job.id);
    return { ok: true, job: fresh ? await withItems(db, fresh) : undefined };
  } catch (err: any) {
    const attempts = job.attempts + 1;
    const ts = nowSeconds();
    await db.prepare(
      `UPDATE print_jobs SET attempts = ?, last_error = ?, status = ?, updated_at = ? WHERE id = ?`
    ).bind(
      attempts,
      String(err?.message || err).slice(0, 900),
      attempts >= MAX_SUBMIT_ATTEMPTS ? "failed" : "queued",
      ts,
      job.id
    ).run();
    const fresh = await getPrintJobById(db, job.id);
    return { ok: false, error: String(err?.message || err), job: fresh ? await withItems(db, fresh) : undefined };
  }
}

export interface DispatchSummary {
  submitted: number;
  failed: number;
  errors: number;
}

export async function dispatchPrintJobs(
  db: DBLike,
  env: any,
  opts: { site?: string; batch?: number } = {}
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { submitted: 0, failed: 0, errors: 0 };
  if (!luluConfigured(env)) return summary;
  await seedPrintables(db);
  const batch = opts.batch ?? 10;
  const { results } = await db.prepare(
    "SELECT * FROM print_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?"
  ).bind(batch).all();
  for (const row of (results || []) as any[]) {
    const job = rowToJob(row);
    try {
      const outcome = await submitPrintJob(db, env, job, opts.site);
      if (outcome.ok) summary.submitted += 1;
      else if (outcome.job?.status === "failed") summary.failed += 1;
      else summary.errors += 1;
    } catch (err: any) {
      summary.errors += 1;
      console.error("print dispatch failed for job", job.id, err?.message || err);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Customer notifications: one email per shipped or delivered parcel.
//
// Print parcels ride the outbox on dedupe keys (print_shipped:{id} /
// print_delivered:{id}, keyed by the shipments row), with order_id
// left NULL on purpose: the outbox's unique (order_id, kind) index
// would collapse a second parcel's email into the first (the same
// reason club cycle mail keys on its dedupe key instead). The
// shipments row is the parcel of record: it carries the order or
// club box link plus the carrier and tracking the email reports.
// Sync is where parcels change state, so sync is where these emails
// enqueue, identically whether the cron poll or the Lulu webhook
// drove the sync. setPhysicalStatus is never involved: its
// physical_update_* emails describe a home-packed parcel, and a Lulu
// parcel is packed by the printer. Sender follows the package-mail
// convention (senderForKind has no print override, so these send
// from the orders@ default, like physical_update_*).

export type PrintParcelEmailKind = "print_shipped" | "print_delivered";

export const PRINT_PARCEL_EMAIL_KINDS: readonly string[] = ["print_shipped", "print_delivered"];

export interface PrintParcelEmailModel {
  kind: PrintParcelEmailKind;
  subject: string;
  headline: string;
  body: string;
  titles: string[];
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  // The email's one call to action: the tracking page while the
  // parcel travels, the library once it has arrived.
  button: { label: string; href: string } | null;
  clubBox: boolean;
}

function parcelTitle(item: { title?: string | null; slug: string; kind: string }): string {
  const title = item.title ? String(item.title) : item.slug;
  return item.kind === "coloring" ? `${title} (coloring book)` : title;
}

/** Structured content for a print parcel email; the plain-text
 *  builder below and the React Email template render from this. */
export function buildPrintParcelEmailModel(args: {
  kind: PrintParcelEmailKind;
  item: { title?: string | null; slug: string; kind: string };
  carrier?: string | null;
  trackingId?: string | null;
  trackingUrl?: string | null;
  clubBox: boolean;
  site: string;
}): PrintParcelEmailModel {
  const site = String(args.site || "https://bigbrainshelf.com").replace(/\/+$/, "");
  const title = parcelTitle(args.item);
  if (args.kind === "print_shipped") {
    return {
      kind: args.kind,
      subject: args.clubBox ? "A Book Club book has shipped" : "Your printed book has shipped",
      headline: args.clubBox
        ? "A book from your Book Club box is on its way."
        : "Your book is on its way.",
      body: args.clubBox
        ? "The printed books in your Book Club box ship straight from the printer, so this one may arrive separately from the rest of your box. We will email you when it is delivered."
        : "It has left the printer and is heading to you. We will email you when it is delivered.",
      titles: [title],
      carrier: args.carrier ? String(args.carrier) : undefined,
      trackingNumber: args.trackingId ? String(args.trackingId) : undefined,
      trackingUrl: args.trackingUrl ? String(args.trackingUrl) : undefined,
      button: args.trackingUrl
        ? { label: "Track your package", href: String(args.trackingUrl) }
        : null,
      clubBox: args.clubBox,
    };
  }
  return {
    kind: args.kind,
    subject: args.clubBox ? "A Book Club book has been delivered" : "Your printed book has been delivered",
    headline: args.clubBox
      ? "A book from your Book Club box has arrived."
      : "Your book has arrived.",
    body: "It should be at your door now. We hope it gets read to pieces and loved. Thank you for being part of the Shelf.",
    titles: [title],
    button: { label: "Open your library", href: `${site}/account/library` },
    clubBox: args.clubBox,
  };
}

export function buildPrintParcelEmail(
  model: PrintParcelEmailModel
): { subject: string; text: string } {
  const lines: string[] = [];
  lines.push(model.headline);
  lines.push("");
  for (const t of model.titles) lines.push(`- ${t}`);
  lines.push("");
  lines.push(model.body);
  if (model.trackingNumber) {
    lines.push("");
    if (model.carrier) lines.push(`Carrier: ${model.carrier}`);
    lines.push(`Tracking number: ${model.trackingNumber}`);
  }
  if (model.button) {
    lines.push("");
    lines.push(`${model.button.label}: ${model.button.href}`);
  }
  lines.push("");
  lines.push("Big Brain Shelf");
  return { subject: model.subject, text: lines.join("\n") };
}

/**
 * Rebuild a parcel email's render model from its outbox row (the
 * HTML renderer's entry point). The dedupe key carries the shipment
 * id; everything else reads off the shipment and its job item.
 */
export async function loadPrintParcelEmailModel(
  db: DBLike,
  site: string,
  row: { kind: string; dedupe_key?: string | null }
): Promise<PrintParcelEmailModel | null> {
  const kind =
    row.kind === "print_shipped" || row.kind === "print_delivered"
      ? (row.kind as PrintParcelEmailKind)
      : null;
  if (!kind) return null;
  const dedupeKey = String(row.dedupe_key || "");
  if (!dedupeKey.startsWith(`${kind}:`)) return null;
  const shipmentId = dedupeKey.slice(kind.length + 1);
  if (!shipmentId) return null;
  await ensurePrintSchema(db);
  const shipRow = await db.prepare("SELECT * FROM shipments WHERE id = ?").bind(shipmentId).first() as any;
  if (!shipRow) return null;
  const shipment = rowToShipment(shipRow);
  const itemRow = await db.prepare("SELECT * FROM print_job_items WHERE id = ?").bind(shipment.jobItemId).first() as any;
  if (!itemRow) return null;
  return buildPrintParcelEmailModel({
    kind,
    item: rowToItem(itemRow),
    carrier: shipment.carrierName,
    trackingId: shipment.trackingId,
    trackingUrl: shipment.trackingUrl,
    clubBox: !!shipment.clubBoxId,
    site,
  });
}

async function enqueuePrintParcelEmail(
  db: DBLike,
  job: PrintJob,
  item: PrintJobItem,
  shipment: Shipment,
  kind: PrintParcelEmailKind,
  site: string
): Promise<void> {
  const to = job.contactEmail ? String(job.contactEmail) : "";
  if (!to) return;
  const model = buildPrintParcelEmailModel({
    kind,
    item,
    carrier: shipment.carrierName,
    trackingId: shipment.trackingId,
    trackingUrl: shipment.trackingUrl,
    clubBox: !!job.clubBoxId,
    site,
  });
  const { subject, text } = buildPrintParcelEmail(model);
  await enqueueEmail(db, {
    orderId: null,
    kind,
    to,
    subject,
    text,
    dedupeKey: `${kind}:${shipment.id}`,
    clubBoxId: job.clubBoxId,
  });
}

// ---------------------------------------------------------------------------
// Sync: mirror Lulu progress back onto jobs, items, shipments, orders.

const ORDER_FLOW = ["preorder_received", "in_print", "packed", "shipped", "delivered"];

async function deriveOrderPhysicalStatus(db: DBLike, job: PrintJob, items: PrintJobItem[]): Promise<void> {
  if (!job.orderId) return;
  const order = await db.prepare("SELECT physical_status FROM orders WHERE id = ?").bind(job.orderId).first() as any;
  if (!order) return;
  const current = String(order.physical_status || "");
  const currentIdx = ORDER_FLOW.indexOf(current);
  const shippedCount = items.filter((i) => i.status === "SHIPPED").length;
  let target: string | null = null;
  let partial = false;
  if (job.luluStatus === "DELIVERED") {
    target = "delivered";
  } else if (items.length > 0 && shippedCount === items.length) {
    target = "shipped";
  } else if (shippedCount > 0) {
    partial = true;
    target = currentIdx >= 0 && currentIdx >= ORDER_FLOW.indexOf("in_print") ? current : "in_print";
  } else if (["PRODUCTION_DELAYED", "PRODUCTION_READY", "IN_PRODUCTION"].includes(job.luluStatus || "")) {
    target = "in_print";
  }
  if (partial !== job.hasPartial) {
    await db.prepare("UPDATE print_jobs SET has_partial = ?, updated_at = ? WHERE id = ?")
      .bind(partial ? 1 : 0, nowSeconds(), job.id).run();
  }
  if (!target) return;
  const targetIdx = ORDER_FLOW.indexOf(target);
  // Forward-only, and never backwards through the home stages: a
  // Lulu order may sit at preorder_received or in_print before this
  // derivation moves it; packed is a home stage Lulu never sets.
  if (targetIdx > currentIdx) {
    await db.prepare("UPDATE orders SET physical_status = ? WHERE id = ?").bind(target, job.orderId).run();
  }
}

export interface SyncSummary {
  synced: number;
  shipped: number;
  delivered: number;
  errors: number;
}

/** Sync one submitted job from Lulu. Returns the fresh job. */
export async function syncPrintJob(
  db: DBLike,
  env: any,
  job: PrintJob,
  opts: { site?: string } = {}
): Promise<PrintJobWithItems> {
  if (!job.luluJobId) return withItems(db, job);
  const statusRes = await getPrintJobStatus(env, job.luluJobId);
  const full = await getPrintJob(env, job.luluJobId).catch(() => null);
  const luluStatus = luluStatusName(statusRes) || job.luluStatus;
  const ts = nowSeconds();
  // Parcel notification events gathered during the item walk and
  // enqueued once the mirror writes land, so an email never reports
  // a state the rows do not yet show.
  const parcelEvents: { item: PrintJobItem; shipment: Shipment; kind: PrintParcelEmailKind }[] = [];

  const items = await listPrintJobItems(db, job.id);
  const fullItems: any[] = Array.isArray(full?.line_items) ? full.line_items : [];
  const statusItems: any[] = Array.isArray(statusRes?.line_item_statuses) ? statusRes.line_item_statuses : [];

  for (const item of items) {
    const fullItem =
      fullItems.find((li: any) => String(li?.external_id || "") === item.externalId) ||
      fullItems.find((li: any) => item.luluLineItemId && String(li?.id || "") === item.luluLineItemId);
    const statusItem =
      statusItems.find((li: any) => fullItem && String(li?.line_item_id || "") === String(fullItem.id)) ||
      statusItems.find((li: any) => item.luluLineItemId && String(li?.line_item_id || "") === item.luluLineItemId);
    const messages = statusItem?.messages && typeof statusItem.messages === "object" ? statusItem.messages : {};
    const nextStatus =
      luluStatusName(fullItem?.status) || luluStatusName(statusItem?.name) || item.status;
    const trackingId =
      (fullItem?.tracking_id ? String(fullItem.tracking_id) : null) ||
      (messages.tracking_id ? String(messages.tracking_id) : null) ||
      item.trackingId;
    const trackingUrls = fullItem?.tracking_urls ?? messages.tracking_urls;
    const trackingUrl =
      (Array.isArray(trackingUrls) ? (trackingUrls[0] ? String(trackingUrls[0]) : null) : trackingUrls ? String(trackingUrls) : null) ||
      item.trackingUrl;
    const carrierName =
      (fullItem?.carrier_name ? String(fullItem.carrier_name) : null) ||
      (messages.carrier_name ? String(messages.carrier_name) : null) ||
      item.carrierName;
    const lineItemId = fullItem?.id ? String(fullItem.id) : item.luluLineItemId;
    await db.prepare(
      `UPDATE print_job_items SET status = ?, lulu_line_item_id = ?, tracking_id = ?,
         tracking_url = ?, carrier_name = ?, updated_at = ? WHERE id = ?`
    ).bind(nextStatus, lineItemId, trackingId, trackingUrl, carrierName, ts, item.id).run();
    if (trackingId) {
      // Read the parcel of record BEFORE the upsert: whether this
      // sync is the one that first gives the parcel a tracking
      // number (shipped email) or first marks it delivered
      // (delivered email) is decided against that prior state, so
      // re-syncs of an unchanged parcel enqueue nothing.
      const prevRow = await db.prepare("SELECT * FROM shipments WHERE job_item_id = ?").bind(item.id).first() as any;
      const prevShipment = prevRow ? rowToShipment(prevRow) : null;
      await db.prepare(
        `INSERT INTO shipments (id, job_id, job_item_id, order_id, club_box_id, provider,
           carrier_name, tracking_id, tracking_url, status, shipped_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'lulu', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (job_item_id) DO UPDATE SET
           carrier_name = excluded.carrier_name,
           tracking_id = excluded.tracking_id,
           tracking_url = excluded.tracking_url,
           status = excluded.status,
           updated_at = excluded.updated_at`
      ).bind(
        crypto.randomUUID(),
        job.id,
        item.id,
        job.orderId,
        job.clubBoxId,
        carrierName,
        trackingId,
        trackingUrl,
        nextStatus,
        ts,
        ts,
        ts
      ).run();
      const shipRow = await db.prepare("SELECT * FROM shipments WHERE job_item_id = ?").bind(item.id).first() as any;
      if (shipRow) {
        const shipment = rowToShipment(shipRow);
        if (!prevShipment || !prevShipment.trackingId) {
          parcelEvents.push({ item, shipment, kind: "print_shipped" });
        }
        if (nextStatus === "DELIVERED" && prevShipment?.status !== "DELIVERED") {
          parcelEvents.push({ item, shipment, kind: "print_delivered" });
        }
      }
    }
    item.status = nextStatus;
    item.trackingId = trackingId;
    item.trackingUrl = trackingUrl;
    item.carrierName = carrierName;
    item.luluLineItemId = lineItemId;
  }

  const jobError =
    luluStatus && ["REJECTED", "ERROR"].includes(luluStatus)
      ? String(statusRes?.message || `Lulu reported ${luluStatus}`).slice(0, 900)
      : job.lastError;
  // Terminal Lulu states close the local lifecycle too: a job Lulu
  // canceled is canceled here, and a rejected or errored job is
  // failed, so neither keeps re-entering the submitted work set.
  const localStatus =
    luluStatus === "CANCELED"
      ? "canceled"
      : luluStatus === "REJECTED" || luluStatus === "ERROR"
        ? "failed"
        : job.status;
  await db.prepare(
    `UPDATE print_jobs SET lulu_status = ?, status = ?, total_cost_incl_tax = ?, currency = ?,
       last_error = ?, updated_at = ? WHERE id = ?`
  ).bind(
    luluStatus,
    localStatus,
    full?.costs?.total_cost_incl_tax ? String(full.costs.total_cost_incl_tax) : job.totalCostInclTax,
    full?.costs?.currency ? String(full.costs.currency) : job.currency,
    jobError,
    ts,
    job.id
  ).run();

  const fresh = await getPrintJobById(db, job.id);
  if (fresh) {
    fresh.luluStatus = luluStatus;
    await deriveOrderPhysicalStatus(db, fresh, await listPrintJobItems(db, job.id));
  }
  const done = await getPrintJobById(db, job.id);
  const settled = (done || fresh || job) as PrintJob;
  if (parcelEvents.length) {
    const site = String(opts.site || env?.BETTER_AUTH_URL || "https://bigbrainshelf.com");
    for (const ev of parcelEvents) {
      try {
        await enqueuePrintParcelEmail(db, settled, ev.item, ev.shipment, ev.kind, site);
      } catch (err: any) {
        // A failed enqueue must not fail the sync: the mirror state
        // is already written, and the outbox dedupe key makes any
        // later re-drive safe.
        console.error("print parcel email enqueue failed", settled.id, ev.kind, err?.message || err);
      }
    }
  }
  return withItems(db, settled);
}

export async function syncPrintJobs(
  db: DBLike,
  env: any,
  opts: { orderId?: string; clubBoxId?: string; batch?: number; site?: string } = {}
): Promise<SyncSummary> {
  const summary: SyncSummary = { synced: 0, shipped: 0, delivered: 0, errors: 0 };
  if (!luluConfigured(env)) return summary;
  await ensurePrintSchema(db);
  let sql = "SELECT * FROM print_jobs WHERE lulu_job_id IS NOT NULL AND status = 'submitted'";
  const binds: any[] = [];
  if (opts.orderId) { sql += " AND order_id = ?"; binds.push(opts.orderId); }
  if (opts.clubBoxId) { sql += " AND club_box_id = ?"; binds.push(opts.clubBoxId); }
  sql += " ORDER BY updated_at ASC LIMIT ?";
  binds.push(opts.batch ?? 25);
  const { results } = await db.prepare(sql).bind(...binds).all();
  for (const row of (results || []) as any[]) {
    const job = rowToJob(row);
    if (job.luluStatus && LULU_TERMINAL_STATUSES.has(job.luluStatus)) continue;
    try {
      const before = job.luluStatus;
      const after = await syncPrintJob(db, env, job, { site: opts.site });
      summary.synced += 1;
      if (after.luluStatus === "SHIPPED" && before !== "SHIPPED") summary.shipped += 1;
      if (after.luluStatus === "DELIVERED" && before !== "DELIVERED") summary.delivered += 1;
    } catch (err: any) {
      summary.errors += 1;
      console.error("print sync failed for job", job.id, err?.message || err);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Cancel

export async function cancelPrintJobById(
  db: DBLike,
  env: any,
  jobId: string
): Promise<{ ok: boolean; error?: string; job?: PrintJobWithItems }> {
  await ensurePrintSchema(db);
  const job = await getPrintJobById(db, jobId);
  if (!job) return { ok: false, error: "print job not found" };
  if (job.status === "canceled") return { ok: true, job: await withItems(db, job) };
  const ts = nowSeconds();
  if (job.status === "queued" || !job.luluJobId) {
    await db.prepare("UPDATE print_jobs SET status = 'canceled', updated_at = ? WHERE id = ?").bind(ts, jobId).run();
    const fresh = await getPrintJobById(db, jobId);
    return { ok: true, job: fresh ? await withItems(db, fresh) : undefined };
  }
  const cancellable = ["CREATED", "UNPAID", "PRODUCTION_DELAYED"];
  if (job.luluStatus && !cancellable.includes(job.luluStatus)) {
    return { ok: false, error: `Lulu will not cancel a job in ${job.luluStatus}.`, job: await withItems(db, job) };
  }
  try {
    await luluCancelPrintJob(env, job.luluJobId);
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err), job: await withItems(db, job) };
  }
  await db.prepare(
    "UPDATE print_jobs SET status = 'canceled', lulu_status = 'CANCELED', updated_at = ? WHERE id = ?"
  ).bind(ts, jobId).run();
  const fresh = await getPrintJobById(db, jobId);
  return { ok: true, job: fresh ? await withItems(db, fresh) : undefined };
}

// ---------------------------------------------------------------------------
// Lulu webhook: the fast path into the same sync the cron poll runs.
//
// Lulu POSTs { topic, data } on PRINT_JOB_STATUS_CHANGED, data being
// the full print job, signed with HMAC-SHA256 over the raw body in
// the Lulu-HMAC-SHA256 header. Events are recorded BEFORE processing
// (the Stripe webhook's shape): a redelivery of a fully processed
// event is skipped, a redelivery of one that failed re-runs, and the
// handler returns 500 on error so Lulu's own retries do the rest.
// The endpoint stays dark (404) until LULU_WEBHOOK_SECRET is set on
// the worker, which happens when the webhook is registered with
// Lulu; until then the cron poll carries every update alone.

export async function ensureLuluWebhookSchema(db: DBLike): Promise<void> {
  await ensureOnce(db, "lulu_webhook_events", async () => {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS lulu_webhook_events (
         event_key TEXT PRIMARY KEY,
         topic TEXT,
         lulu_job_id TEXT,
         status_name TEXT,
         payload_hash TEXT,
         received_at INTEGER NOT NULL,
         processed_at INTEGER,
         result TEXT
       )`
    ).bind().run();
  });
}

/**
 * Record a Lulu webhook event before processing it. Returns "new"
 * for a first sighting (or a replay of an event that never finished,
 * which must re-run) and "duplicate" for a replay of a fully
 * processed event. The key binds the Lulu job id, the job's new
 * status, and a hash of the raw payload, so byte-identical
 * redeliveries dedupe exactly.
 */
export async function recordLuluWebhookEvent(
  db: DBLike,
  event: {
    key: string;
    topic: string;
    luluJobId: string | null;
    statusName: string;
    payloadHash: string;
  }
): Promise<"new" | "duplicate"> {
  await ensureLuluWebhookSchema(db);
  await db
    .prepare(
      "INSERT OR IGNORE INTO lulu_webhook_events (event_key, topic, lulu_job_id, status_name, payload_hash, received_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(event.key, event.topic, event.luluJobId, event.statusName, event.payloadHash, nowSeconds())
    .run();
  const row = await db
    .prepare("SELECT processed_at FROM lulu_webhook_events WHERE event_key = ?")
    .bind(event.key)
    .first() as any;
  if (!row) return "new";
  return row.processed_at ? "duplicate" : "new";
}

export async function markLuluWebhookEventProcessed(
  db: DBLike,
  key: string,
  result: string
): Promise<void> {
  await ensureLuluWebhookSchema(db);
  await db
    .prepare("UPDATE lulu_webhook_events SET processed_at = ?, result = ? WHERE event_key = ?")
    .bind(nowSeconds(), result, key)
    .run();
}

async function findJobForWebhook(
  db: DBLike,
  luluJobId: string | null,
  externalId: string | null
): Promise<PrintJob | null> {
  if (luluJobId) {
    const row = await db.prepare("SELECT * FROM print_jobs WHERE lulu_job_id = ?").bind(luluJobId).first() as any;
    if (row) return rowToJob(row);
  }
  if (externalId) {
    // Our create body sends the job's idempotency key as Lulu's
    // external_id, so an event for a job whose create response never
    // reached us still resolves to its local row.
    const row = await db.prepare("SELECT * FROM print_jobs WHERE idempotency_key = ?").bind(externalId).first() as any;
    if (row) return rowToJob(row);
  }
  return null;
}

/**
 * The POST /api/lulu/webhook handler, kept in the lib so the route
 * file is a thin env adapter (and the behavior is unit-testable
 * without a worker). Response contract: 404 while no webhook secret
 * is configured, 401 on a bad signature, 400 on an unparseable body,
 * 500 on a processing error (Lulu retries), 200 otherwise.
 */
export async function handleLuluWebhookPost(
  db: DBLike,
  env: any,
  request: Request,
  site?: string
): Promise<Response> {
  const secret = String(env?.LULU_WEBHOOK_SECRET || "");
  if (!secret) return new Response("not found", { status: 404 });
  const rawBody = await request.text();
  const signature = request.headers.get("Lulu-HMAC-SHA256");
  if (!(await verifyLuluWebhookSignature(secret, rawBody, signature))) {
    return new Response("bad signature", { status: 401 });
  }
  let payload: any = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("bad payload", { status: 400 });
  }
  const topic = String(payload?.topic || "");
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const luluJobId = data?.id !== undefined && data?.id !== null ? String(data.id) : null;
  const statusName = luluStatusName(data?.status);
  const payloadHash = await sha256Hex(rawBody);
  const eventKey = `${luluJobId || "none"}:${statusName || "none"}:${payloadHash}`;
  const seen = await recordLuluWebhookEvent(db, {
    key: eventKey,
    topic,
    luluJobId,
    statusName,
    payloadHash,
  });
  if (seen === "duplicate") return new Response("ok (duplicate)");
  try {
    if (topic !== "PRINT_JOB_STATUS_CHANGED") {
      await markLuluWebhookEventProcessed(db, eventKey, `ignored topic: ${topic || "(none)"}`);
      return new Response("ok");
    }
    if (!luluConfigured(env)) {
      // A signed event we cannot act on: the cron poll owns status
      // while the lane is off, and a 500 here would only spend
      // Lulu's retries against a worker that cannot sync.
      await markLuluWebhookEventProcessed(db, eventKey, "ignored: lulu lane not configured");
      return new Response("ok");
    }
    const externalId = data?.external_id ? String(data.external_id) : null;
    const job = await findJobForWebhook(db, luluJobId, externalId);
    if (!job) {
      await markLuluWebhookEventProcessed(db, eventKey, "ignored: unknown print job");
      return new Response("ok");
    }
    if (!job.luluJobId && luluJobId) {
      // Lulu knows this job but our row never recorded its id (a
      // create response lost in transit): adopt the id so the sync
      // below can run against it.
      await db
        .prepare(
          `UPDATE print_jobs SET lulu_job_id = ?,
             status = CASE WHEN status = 'queued' THEN 'submitted' ELSE status END,
             updated_at = ? WHERE id = ?`
        )
        .bind(luluJobId, nowSeconds(), job.id)
        .run();
      job.luluJobId = luluJobId;
      if (job.status === "queued") job.status = "submitted";
    }
    await syncPrintJob(db, env, job, { site });
    await markLuluWebhookEventProcessed(db, eventKey, "synced");
    return new Response("ok");
  } catch (err: any) {
    // Leave processed_at null so a Lulu retry re-runs the
    // (idempotent) processing instead of being skipped as a duplicate.
    console.error("lulu webhook processing failed", eventKey, err?.message || err);
    return new Response("processing error", { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// The cron pass: dispatch, then sync. Quiet no-op when the lane is off.

export interface PrintFulfillmentSummary {
  dispatched: DispatchSummary;
  synced: SyncSummary;
}

export async function runPrintFulfillmentPass(
  db: DBLike,
  env: any,
  opts: { site?: string; batch?: number } = {}
): Promise<PrintFulfillmentSummary> {
  const empty: PrintFulfillmentSummary = {
    dispatched: { submitted: 0, failed: 0, errors: 0 },
    synced: { synced: 0, shipped: 0, delivered: 0, errors: 0 },
  };
  if (!luluConfigured(env)) return empty;
  const dispatched = await dispatchPrintJobs(db, env, { site: opts.site, batch: opts.batch });
  const synced = await syncPrintJobs(db, env, { batch: opts.batch, site: opts.site });
  return { dispatched, synced };
}
