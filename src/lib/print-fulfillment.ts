// Print fulfillment (Lulu lane): the registry of print-ready files,
// the print jobs built from paid orders and locked club boxes, and
// the cron passes that submit those jobs to Lulu and mirror their
// progress back onto our rows.
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

import type { DBLike } from "./orders";
import { ensureOnce } from "./schema-cache";
import { getOrMintSerial, mintOrderPrintSerials, serialLabel, type BookSerial } from "./serials";
import { stampPdfForPrint } from "./pdf-stamp";
import {
  cancelPrintJob as luluCancelPrintJob,
  createPrintJob,
  getPrintJob,
  getPrintJobStatus,
  luluConfigured,
  luluStatusName,
  normalizeLuluAddress,
  LULU_TERMINAL_STATUSES,
  type LuluAddress,
} from "./lulu";

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

async function readR2Bytes(books: any, key: string): Promise<Uint8Array | null> {
  if (!books || typeof books.get !== "function") return null;
  const obj = await books.get(key).catch(() => null);
  if (!obj) return null;
  if (typeof obj.arrayBuffer === "function") return new Uint8Array(await obj.arrayBuffer());
  if (obj.body instanceof Uint8Array) return obj.body;
  if (obj.body) return new Uint8Array(await new Response(obj.body as any).arrayBuffer());
  return null;
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
  const printables = new Map<string, Printable | null>();
  const missing: string[] = [];
  for (const unit of args.units) {
    const key = `${unit.slug}|${unit.kind}`;
    if (!printables.has(key)) printables.set(key, await getPrintable(db, unit.slug, unit.kind));
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
    blocked ? `No printable registered for: ${missing.join(", ")}` : null,
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
        const stock = await readR2Bytes(env?.BOOKS, printable.interiorKey);
        if (!stock) throw new Error(`stock interior not readable: ${printable.interiorKey}`);
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
export async function syncPrintJob(db: DBLike, env: any, job: PrintJob): Promise<PrintJobWithItems> {
  if (!job.luluJobId) return withItems(db, job);
  const statusRes = await getPrintJobStatus(env, job.luluJobId);
  const full = await getPrintJob(env, job.luluJobId).catch(() => null);
  const luluStatus = luluStatusName(statusRes) || job.luluStatus;
  const ts = nowSeconds();

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
  return withItems(db, (done || job) as PrintJob);
}

export async function syncPrintJobs(
  db: DBLike,
  env: any,
  opts: { orderId?: string; clubBoxId?: string; batch?: number } = {}
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
      const after = await syncPrintJob(db, env, job);
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
  const synced = await syncPrintJobs(db, env, { batch: opts.batch });
  return { dispatched, synced };
}
