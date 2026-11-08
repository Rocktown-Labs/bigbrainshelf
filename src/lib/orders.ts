// Order, webhook, and email-outbox logic for the Big Brain Shelf store.
//
// Everything here is written against a minimal D1-shaped interface so the
// same code paths run in the worker (real D1) and in the local idempotency
// test (bun:sqlite behind a thin adapter). No cloudflare:workers imports.
//
// Idempotency design:
// - Checkout: a pending orders row is keyed by (user_id, cart_fingerprint)
//   with a partial unique index, and its id is the Stripe idempotency key.
//   A double click or a retried request reuses the same pending order and
//   the same Stripe session instead of creating a second order.
// - Webhook: every Stripe event id is recorded in webhook_events BEFORE
//   processing. A replayed event whose processed_at is set is skipped
//   entirely. If processing failed mid-way (processed_at still null), a
//   replay safely re-runs because every step below is itself idempotent.
// - Orders converge on stripe_session_id (UNIQUE): completing a session
//   updates the pending row in place, or inserts one row if none exists.
// - Emails live in email_outbox with a unique (order_id, kind) index, so
//   each kind of email is enqueued at most once per order, ever. A row is
//   marked sent (with sent_at) only after the provider accepts it.

import { ensureClubTable, isPaidClubMember } from "./club";
import { ensureOnce } from "./schema-cache";
import { publicSlugFor, ensurePublicSlugColumn, ensureSlugAliasesTable, ensureRenameAliases, resolveInternalSlug } from "./public-slugs";
import { bookCodeForTitle } from "./catalog";
import { coverDerivative, MEDIA_PUBLIC } from "./derivatives";
import {
  clubPriceLabel,
  clubIsLive,
  CLUB_ANNUAL_PRICE_CENTS,
  AUDIO_CLUB_PRICE_CENTS,
  AUDIO_CLUB_ANNUAL_PRICE_CENTS,
  GIFT_SET_PRICE_CENTS,
  AUDIO_PRICE_CENTS,
  STANDARD_DIGITAL_PRICE_CENTS,
  STANDARD_PRINT_PRICE_CENTS,
  giftSetEligible,
  audioEligible,
  isClubCartSlug,
  resolveClubCartLine,
} from "./offers";

export interface DBStatement {
  bind(...args: any[]): {
    run(): Promise<any>;
    first(): Promise<any>;
    all(): Promise<{ results?: any[] }>;
  };
}
export interface DBLike {
  prepare(sql: string): DBStatement;
}

export interface CartItem {
  slug: string;
  // "digital" | "printed" | "giftset" | "audio" for book lines. A
  // CLUB line (CG, 2026-11-07) carries a reserved club slug
  // ("book-club" | "audio-club", lib/offers) and its format is the
  // billing period instead: "quarterly" | "annual" | "monthly".
  format: string;
  // Set at checkout when a server-side credit shaped this line's price.
  // Today the only credit is "audio-upgrade": an audiobook-only owner
  // unlocking the digital edition. Recorded on the order so the
  // discounted charge is auditable after the fact.
  upgrade?: string;
  // Copies of this line (CG, 2026-10-31: quantities belong on the
  // order, the receipts, and the emails). Absent means 1; every
  // reader normalizes through itemQty.
  qty?: number;
  // The per-copy price actually charged for this line, in cents.
  // Manual orders set it (an admin types the price); club lines set
  // it too (a membership has no book row to price from). Every price
  // reader prefers it when present so the line prices at what was
  // charged instead of today's store price.
  priceCents?: number;
  // The dedication name for a physical line (checkout, slice 2):
  // printed inside the copy's dedication page by the print lane
  // (buildJobsForOrder reads it from the items JSON). Absent or
  // blank prints the write-in dedication page instead.
  dedicationName?: string;
  // The buyer marked this book line as a gift (CG, 2026-11-07):
  // toggled per line in the cart and at checkout, highlighted on
  // those screens and in the admin order views. Book lines only;
  // club lines never carry it.
  gift?: boolean;
}

// The stored format for one parsed item: book formats normalize as
// they always have, but a club line's format IS its billing period
// and must survive parsing intact, or the membership the order
// bought (and its price) becomes unrecoverable after checkout.
export function storedItemFormat(slug: string, format: unknown): string {
  if (isClubCartSlug(slug)) {
    const spec = resolveClubCartLine(slug, format);
    if (spec) return spec.period;
  }
  return normalizeFormat(format);
}

// The one quantity rule: an integer from 1 to 99, anything else
// (absent, zero, negative, fractional, junk) reads as 1..99 clamped.
export function itemQty(x: { qty?: unknown } | null | undefined): number {
  const n = Math.floor(Number((x as any)?.qty));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(99, n);
}

// Single-copy formats: a digital bundle or an audiobook can only be
// owned once, and there is no gifting flow, so a second copy is a
// pure double-charge (CG's probe, 2026-10-31: a 2x digital line
// charged $17.98 for one deliverable). Quantities are real only for
// physical formats. The cart and checkout clamp through lineQty;
// parseItems deliberately does NOT, so a historical order keeps
// reading exactly what it charged.
export function isSingleCopyFormat(format: string): boolean {
  return format === "digital" || format === "audio";
}

export function lineQty(x: { format?: unknown; qty?: unknown } | null | undefined): number {
  return isSingleCopyFormat(normalizeFormat((x as any)?.format)) ? 1 : itemQty(x as any);
}

// ---------------------------------------------------------------------------
// Checkout pricing: the single place a (book, format, ownership) triple
// becomes a charge. /api/checkout calls this for every line; the client
// never supplies a price, and the audio upgrade credit is computed here
// from the entitlement layer's answer, never from a client flag.
//
// The credit (CG, 2026-10-28): a buyer who owns the audiobook only for
// a book unlocks its digital edition for the digital price minus the
// $5.99 audio price they already paid (1299 - 599 = 700 today), floored
// at 0. Print and gift set are NEVER discounted by audio ownership.

export interface CheckoutBookLike {
  slug: string;
  price?: number | null;
  price_print?: number | null;
  picture_book_key?: string | null;
  coloring_book_key?: string | null;
  audiobook_key?: string | null;
}

export interface OwnershipLike {
  digital: boolean;
  audio: boolean;
}

export function checkoutItemPrice(
  book: CheckoutBookLike,
  format: string,
  ownership: OwnershipLike
): { cents: number; upgrade?: string } | null {
  if (format === "printed") {
    const cents = Math.round(Number(book.price_print || 0));
    return cents > 0 ? { cents } : null;
  }
  if (format === "giftset") {
    return giftSetEligible(book) ? { cents: GIFT_SET_PRICE_CENTS } : null;
  }
  if (format === "audio") {
    return audioEligible(book) ? { cents: AUDIO_PRICE_CENTS } : null;
  }
  // Digital (and any legacy unknown format, which normalizeFormat has
  // already folded into digital before pricing).
  const full = Math.round(Number(book.price || 0));
  if (ownership.audio && !ownership.digital) {
    // Audiobook-only owner unlocking digital: credit what they paid
    // for the audio edition. Floors at 0, which checkout treats as a
    // free unlock recorded through the same order path.
    return { cents: Math.max(0, full - AUDIO_PRICE_CENTS), upgrade: "audio-upgrade" };
  }
  return full > 0 ? { cents: full } : null;
}

// The physical formats share the printed fulfillment pipeline (physical
// status, update emails). "giftset" is the printed storybook plus the
// printed coloring book in one parcel, digital files included.
export function isPhysicalFormat(format: string): boolean {
  return format === "printed" || format === "giftset";
}

export function normalizeFormat(format: unknown): string {
  return format === "printed" || format === "giftset" || format === "audio" ? format : "digital";
}

const now = () => Math.floor(Date.now() / 1000);
const PENDING_WINDOW_SECONDS = 30 * 60;

export async function cartFingerprint(userId: string, items: CartItem[]): Promise<string> {
  // A line's dedication name joins the canonical form only when one
  // is set, so existing carts fingerprint exactly as before while a
  // dedication edit still mints a fresh pending order (the stored
  // items JSON is what the print lane personalizes from). A gift
  // flag joins the same way: toggling it is a different order.
  const canonical =
    userId + "|" + items.map((i) => `${i.slug}:${i.format}:${itemQty(i)}${i.dedicationName ? `:d=${i.dedicationName}` : ""}${i.gift ? ":gift" : ""}`).sort().join(",");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseItems(order: any): CartItem[] {
  try {
    const raw = JSON.parse(order?.items || "[]");
    if (Array.isArray(raw)) {
      return raw
        .map((x: any) => ({
          slug: String(x?.slug || ""),
          format: storedItemFormat(String(x?.slug || ""), x?.format),
          ...(x?.upgrade ? { upgrade: String(x.upgrade) } : {}),
          qty: itemQty(x),
          ...(Number.isFinite(Number(x?.priceCents)) && Number(x?.priceCents) >= 0
            ? { priceCents: Math.round(Number(x.priceCents)) }
            : {}),
          ...(x?.gift === true ? { gift: true } : {}),
        }))
        .filter((x: CartItem) => x.slug);
    }
  } catch { /* fall through */ }
  try {
    return (JSON.parse(order?.book_slugs || "[]") as any[]).map((s) => ({ slug: String(s), format: "digital" }));
  } catch {
    return [];
  }
}

export function hasPrinted(order: any): boolean {
  return parseItems(order).some((i) => isPhysicalFormat(i.format));
}

// Find the live pending order for this user and cart, or create one.
// INSERT OR IGNORE plus the partial unique index makes concurrent calls
// converge on a single row; the loser of the race re-reads the winner.
export async function getOrCreatePendingOrder(
  db: DBLike,
  args: { userId: string; email: string; items: CartItem[]; amount: number }
): Promise<any> {
  const fp = await cartFingerprint(args.userId, args.items);
  const cutoff = now() - PENDING_WINDOW_SECONDS;
  const find = () =>
    db
      .prepare(
        "SELECT * FROM orders WHERE user_id = ? AND cart_fingerprint = ? AND status = 'pending' AND created_at >= ? ORDER BY created_at DESC LIMIT 1"
      )
      .bind(args.userId, fp, cutoff)
      .first();
  const existing = await find();
  if (existing) return existing;

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT OR IGNORE INTO orders
         (id, user_id, email, book_slugs, items, stripe_session_id, amount, currency, status, delivery_token, cart_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'usd', 'pending', ?, ?, ?)`
    )
    .bind(
      id,
      args.userId,
      args.email,
      JSON.stringify([...new Set(args.items.map((i) => i.slug))]),
      JSON.stringify(args.items),
      "pending:" + id,
      args.amount,
      crypto.randomUUID(),
      fp,
      now()
    )
    .run();
  const row = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  return row ?? (await find());
}

export async function attachStripeSession(db: DBLike, orderId: string, sessionId: string): Promise<void> {
  await db
    .prepare("UPDATE orders SET stripe_session_id = ? WHERE id = ? AND status = 'pending'")
    .bind(sessionId, orderId)
    .run();
}

// Record a Stripe event before processing it. Returns "new" for a first
// sighting, "retry" for a replay of an event that never finished, and
// "duplicate" for a replay of a fully processed event (skip it).
export async function recordWebhookEvent(
  db: DBLike,
  event: { id: string; type: string }
): Promise<"new" | "retry" | "duplicate"> {
  await db
    .prepare("INSERT OR IGNORE INTO webhook_events (event_id, type, received_at) VALUES (?, ?, ?)")
    .bind(event.id, event.type, now())
    .run();
  const row = await db
    .prepare("SELECT processed_at FROM webhook_events WHERE event_id = ?")
    .bind(event.id)
    .first();
  if (!row) return "new";
  return row.processed_at ? "duplicate" : "new";
}

export async function markWebhookEventProcessed(db: DBLike, eventId: string, result: string): Promise<void> {
  await db
    .prepare("UPDATE webhook_events SET processed_at = ?, result = ? WHERE event_id = ?")
    .bind(now(), result, eventId)
    .run();
}

// Converge the order for a paid checkout session to exactly one complete
// row, keyed by stripe_session_id. Updates the pending row created at
// checkout time when there is one; otherwise inserts a fresh row.
export async function completeOrder(
  db: DBLike,
  session: {
    id: string;
    amount_total?: number | null;
    currency?: string | null;
    customer_email?: string | null;
    customer_details?: { email?: string | null } | null;
    metadata?: Record<string, string> | null;
    // Stripe Checkout shipping collection (present for physical orders).
    // Newer Stripe API versions nest it under collected_information.
    shipping_details?: { name?: string | null; address?: Record<string, string | null> | null } | null;
    collected_information?: { shipping_details?: { name?: string | null; address?: Record<string, string | null> | null } | null } | null;
    shipping_cost?: { amount_total?: number | null } | null;
  }
): Promise<any> {
  const items: CartItem[] = (() => {
    try {
      const raw = JSON.parse(session.metadata?.items || "[]");
      if (Array.isArray(raw)) {
        return raw
          .map((x: any) => ({
            slug: String(x?.slug || ""),
            format: storedItemFormat(String(x?.slug || ""), x?.format),
            ...(x?.upgrade ? { upgrade: String(x.upgrade) } : {}),
            // Qty must survive completion: this map used to keep only
            // slug/format/upgrade, so every multi-quantity order was
            // persisted as qty 1 even though Stripe charged the full
            // quantity (found live 2026-10-31, orders 7FC57663 and
            // 54F3CFF5: charged right, recorded wrong, pick lists and
            // receipts then under-reported the order).
            qty: itemQty(x),
            // A club line's charged price rides its priceCents (there
            // is no book row to reprice it from), and a gift flag is
            // part of what the buyer asked for: both survive too.
            ...(Number.isFinite(Number(x?.priceCents)) && Number(x?.priceCents) >= 0
              ? { priceCents: Math.round(Number(x.priceCents)) }
              : {}),
            ...(x?.gift === true ? { gift: true } : {}),
          }))
          .filter((x: CartItem) => x.slug);
    }
    } catch { /* fall through */ }
    return String(session.metadata?.slugs || "")
      .split(",")
      .filter(Boolean)
      .map((slug) => ({ slug, format: "digital" }));
  })();
  const slugs = [...new Set(items.map((i) => i.slug))];
  const email = String(session.customer_email || session.customer_details?.email || "");
  const printed = items.some((i) => isPhysicalFormat(i.format));
  // Pass-through shipping: the destination is collected on the cart
  // page and quoted before payment, so new sessions carry no Stripe
  // shipping_details; the address rides in the session metadata as a
  // fallback for orders with no pending row. Orders converged from
  // their pending row keep the address checkout already stored
  // (COALESCE below never overwrites it with null).
  const metaAddress = (() => {
    try {
      const a = JSON.parse(session.metadata?.ship_address || "null");
      return a && typeof a === "object" ? a : null;
    } catch { return null; }
  })();
  const shipDetails =
    session.shipping_details ||
    session.collected_information?.shipping_details ||
    (metaAddress ? { name: session.metadata?.ship_name || null, address: metaAddress } : null);
  const shipName = shipDetails?.name ? String(shipDetails.name) : null;
  const shipAddress = shipDetails?.address ? JSON.stringify(shipDetails.address) : null;
  const shippingCents = Number(session.shipping_cost?.amount_total ?? session.metadata?.shipping_cents ?? 0) || 0;

  const existing = await db
    .prepare("SELECT * FROM orders WHERE stripe_session_id = ?")
    .bind(session.id)
    .first();
  if (existing) {
    await db
      .prepare(
        `UPDATE orders SET
           status = 'complete',
           email = CASE WHEN ? <> '' THEN ? ELSE email END,
           amount = ?, currency = ?,
           book_slugs = ?, items = ?,
           physical_status = CASE WHEN ? AND physical_status IS NULL THEN 'preorder_received' ELSE physical_status END,
           delivery_token = COALESCE(delivery_token, ?),
           ship_name = COALESCE(?, ship_name),
           ship_address = COALESCE(?, ship_address),
           shipping_cents = CASE WHEN ? > 0 THEN ? ELSE shipping_cents END
         WHERE id = ?`
      )
      .bind(
        email, email,
        session.amount_total || existing.amount || 0,
        session.currency || existing.currency || "usd",
        JSON.stringify(slugs),
        JSON.stringify(items),
        printed ? 1 : 0,
        crypto.randomUUID(),
        shipName,
        shipAddress,
        shippingCents, shippingCents,
        existing.id
      )
      .run();
    return db.prepare("SELECT * FROM orders WHERE id = ?").bind(existing.id).first();
  }

  const id = String(session.metadata?.order_id || "") || crypto.randomUUID();
  await db
    .prepare(
      `INSERT OR IGNORE INTO orders
         (id, user_id, email, book_slugs, items, stripe_session_id, amount, currency, status, delivery_token, physical_status, ship_name, ship_address, shipping_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      String(session.metadata?.user_id || ""),
      email,
      JSON.stringify(slugs),
      JSON.stringify(items),
      session.id,
      session.amount_total || 0,
      session.currency || "usd",
      crypto.randomUUID(),
      printed ? "preorder_received" : null,
      shipName,
      shipAddress,
      shippingCents,
      now()
    )
    .run();
  return db.prepare("SELECT * FROM orders WHERE stripe_session_id = ?").bind(session.id).first();
}

export async function expireOrderBySession(db: DBLike, sessionId: string): Promise<void> {
  await db
    .prepare("UPDATE orders SET status = 'expired' WHERE stripe_session_id = ? AND status = 'pending'")
    .bind(sessionId)
    .run();
}

// ---------------------------------------------------------------------------
// Email content. Buyer-facing copy: warm and plain, no em dashes anywhere.

export interface BookFiles {
  slug: string;
  title: string;
  price?: number | null;
  price_print?: number | null;
  picture_book_key?: string | null;
  coloring_book_key?: string | null;
  epub_key?: string | null;
  color_book_key?: string | null;
  audiobook_key?: string | null;
}

export async function loadBooksForOrder(db: DBLike, order: any): Promise<BookFiles[]> {
  const slugs = [...new Set(parseItems(order).map((i) => i.slug))];
  const books: BookFiles[] = [];
  for (const slug of slugs) {
    // Price columns feed pricedOrderLines; an older schema without
    // them falls back to the bare file columns and the pricing
    // helper uses the catalog constants, so a schema skew can never
    // break the confirmation path.
    let b: any = null;
    try {
      b = await db
        .prepare(
          "SELECT slug, title, price, price_print, picture_book_key, coloring_book_key, epub_key, color_book_key, audiobook_key FROM books WHERE slug = ?"
        )
        .bind(slug)
        .first();
    } catch {
      b = await db
        .prepare(
          "SELECT slug, title, picture_book_key, coloring_book_key, epub_key, color_book_key, audiobook_key FROM books WHERE slug = ?"
        )
        .bind(slug)
        .first();
    }
    if (b) books.push(b as BookFiles);
  }
  return books;
}

// (Removed 2026-10-31: the per-file bearer download URLs the
// confirmation email used to carry. CG's ruling: emailed links are
// auth-backed, pointing at the account library; the files are served
// only by the signed-in /api/download route. /api/order-download now
// just redirects legacy token links into the library.)

// Short, stable display form of an order id for list rows: "#" plus
// the first eight hex characters, uppercased ("#A1B2C3D4"). Derived
// purely from the id, so the same order shows the same short id
// everywhere; the full UUID stays visible on the order detail page.
export function shortOrderId(id: string): string {
  return "#" + String(id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
}

// Human-facing order line labels. A book is always NAMED by its public
// title from the books table, never by its internal slug: the slug is a
// storage/code identifier (it names the source material the story was
// adapted from) and must never appear as a displayed label anywhere,
// admin included. The format wording matches the confirmation email's
// formatLabel mapping in buildConfirmationEmailModel below.
export function orderFormatLabel(format: string): string {
  return format === "printed"
    ? "full color printed book, digital files included"
    : format === "giftset"
      ? "gift set: printed storybook and coloring book, digital files included"
      : format === "audio"
        ? "audiobook only"
        : "digital";
}

// Display identity for a CLUB line on an order (CG, 2026-11-07): the
// club's public name and its billing rhythm, so receipts, the
// confirmation email, and the admin views name the membership
// instead of falling back to a book label (or, worse, the reserved
// cart slug, which is a storage identifier like any other slug).
// Null for book lines.
export function clubLineDisplay(
  slug: string,
  format: string
): { title: string; formatLabel: string } | null {
  const spec = resolveClubCartLine(slug, format);
  if (!spec) return null;
  return { title: spec.title, formatLabel: `membership, ${spec.billedLabel}` };
}

// Batch book lookup keyed by the slug the CALLER recorded, which is
// not always the slug the book wears today: orders written before a
// rename or the Mira slug migration carry retired slug forms
// ("mastery"), and those orders rendered as the neutral "Big Brain
// Shelf book" because the books row no longer answers to the old key.
// Resolution mirrors the public routes (public-slugs.ts): the books
// table by slug first, then by public_slug, then through
// book_slug_aliases. The returned Map is keyed by the REQUESTED slug;
// each row is the canonical book row. Fallback steps are best-effort:
// a schema that predates them degrades to the direct lookup.
export async function loadBooksByAnySlug(
  db: any,
  slugs: string[],
  columns: string
): Promise<Map<string, any>> {
  const wanted = [...new Set(slugs.map((s) => String(s || "")).filter(Boolean))];
  const out = new Map<string, any>();
  if (!wanted.length) return out;
  const ph = (arr: string[]) => arr.map(() => "?").join(",");
  const direct = await db
    .prepare(`SELECT ${columns} FROM books WHERE slug IN (${ph(wanted)})`)
    .bind(...wanted)
    .all();
  for (const r of (direct.results || []) as any[]) out.set(String(r.slug), r);
  let missing = wanted.filter((s) => !out.has(s));
  if (!missing.length) return out;
  try {
    await ensurePublicSlugColumn(db);
    const byPublic = await db
      .prepare(`SELECT ${columns} FROM books WHERE public_slug IN (${ph(missing)})`)
      .bind(...missing)
      .all();
    for (const r of (byPublic.results || []) as any[]) {
      const key = missing.find((s) => s === String(r.public_slug));
      if (key) out.set(key, r);
    }
  } catch { /* public_slug predates this schema: direct lookup stands */ }
  missing = wanted.filter((s) => !out.has(s));
  if (!missing.length) return out;
  try {
    await ensureSlugAliasesTable(db);
    // The known rename aliases are seeded in code (public-slugs.ts):
    // a retired slug like "mastery" must resolve even on a database
    // whose alias table was never hand-populated for it.
    await ensureRenameAliases(db);
    const aliasRows = await db
      .prepare(`SELECT alias, slug FROM book_slug_aliases WHERE alias IN (${ph(missing)})`)
      .bind(...missing)
      .all();
    const canonical = new Map<string, string>();
    for (const r of (aliasRows.results || []) as any[]) canonical.set(String(r.alias), String(r.slug));
    const targets = [...new Set([...canonical.values()])].filter((s) => !out.has(s));
    if (targets.length) {
      const rows = await db
        .prepare(`SELECT ${columns} FROM books WHERE slug IN (${ph(targets)})`)
        .bind(...targets)
        .all();
      const bySlug = new Map(((rows.results || []) as any[]).map((r) => [String(r.slug), r]));
      for (const [alias, slug] of canonical) {
        const row = bySlug.get(slug) || out.get(slug);
        if (row) out.set(alias, row);
      }
    }
  } catch { /* aliases are a rename courtesy, never a hard dependency */ }
  return out;
}

// "Penny the Squirrel and the Acorn Orchard (audiobook only)" style
// labels for a batch of orders, resolving every referenced book's
// title with ONE books query. Orders whose items JSON is absent fall
// back to their book_slugs list (titles only, no format suffix). A
// book row that no longer exists renders as a neutral label, never
// the raw slug. Returns a Map from order id to its label list.
export async function orderItemLabels(
  db: any,
  orders: { id: string; items?: string | null; book_slugs?: string | null }[]
): Promise<Map<string, string[]>> {
  const parsed = new Map<string, { slug: string; format: string; qty?: number }[]>();
  const slugSet = new Set<string>();
  for (const o of orders) {
    let items: { slug: string; format: string; qty?: number }[] = [];
    try {
      const raw = JSON.parse(o.items || "[]");
      if (Array.isArray(raw)) {
        items = raw
          .filter((x: any) => x && x.slug)
          .map((x: any) => ({ slug: String(x.slug), format: String(x.format || "digital"), qty: itemQty(x) }));
      }
    } catch { /* fall through to book_slugs */ }
    if (!items.length) {
      try {
        const raw = JSON.parse(o.book_slugs || "[]");
        if (Array.isArray(raw)) items = raw.map((s: any) => ({ slug: String(s), format: "" }));
      } catch { /* no items at all */ }
    }
    parsed.set(o.id, items);
    for (const i of items) slugSet.add(i.slug);
  }
  const titles = new Map<string, string>();
  if (slugSet.size) {
    const rows = await loadBooksByAnySlug(db, [...slugSet], "slug, title");
    for (const [slug, r] of rows) {
      titles.set(slug, String(r.title || ""));
    }
  }
  const out = new Map<string, string[]>();
  for (const o of orders) {
    const items = parsed.get(o.id) || [];
    out.set(
      o.id,
      items.map((i) => {
        const club = clubLineDisplay(i.slug, i.format);
        const title = club?.title || titles.get(i.slug) || "Big Brain Shelf book";
        const qty = itemQty(i as any) > 1 ? ` ×${itemQty(i as any)}` : "";
        const label = club ? club.formatLabel : orderFormatLabel(i.format);
        return i.format ? `${title} (${label})${qty}` : `${title}${qty}`;
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Admin orders list pick list + detail items (2026-10-29). The list is
// a PICK LIST: the operator fulfills by character name ("we need 1
// Penny, 2 Miras"), so rows summarize with the short name (the title
// up to " the "), a count per slug+format, and the format so a colored
// chip can ride along. The detail page keeps FULL public titles. Both
// resolve titles exactly like orderItemLabels (one books query, a
// neutral fallback label, never the raw slug). Emails are untouched:
// they keep orderItemLabels' full wording.

// "{Name} the {Animal} and ..." -> "{Name}". A title without " the "
// (including the neutral fallback) is returned whole.
export function shortBookName(title: string): string {
  const t = String(title || "").trim();
  const i = t.indexOf(" the ");
  return i > 0 ? t.slice(0, i) : t || "Book";
}

export interface OrderItemGroup {
  title: string; // full public title
  name: string; // short pick-list name
  format: string; // digital | printed | giftset | audio (club lines: the billing period)
  count: number;
  // The buyer marked this line as a gift (CG, 2026-11-07): the
  // admin views badge it so packing treats the copy as one.
  gift?: boolean;
  // Packing code derived from the title (lib/catalog bookCodeForTitle),
  // e.g. "MTH-still-water"; null when the book no longer resolves.
  // Pack lines key off this (never the internal slug, which stays out
  // of every payload by design).
  code: string | null;
  // Template dressing for the order views (Tailwind "Order history"
  // pattern): the book's cover thumbnail URL, the public product
  // page for the row's "View Product" link (the audiobook page for
  // audio-only rows), and the per-unit list price in cents. All
  // nullable: a book row that no longer exists renders its neutral
  // title with no thumbnail, link, or price rather than a slug.
  cover: string | null;
  href: string | null;
  unitCents: number | null;
}

interface OrderBookRow {
  slug: string;
  title: string;
  cover_key?: string | null;
  price?: number | null;
  price_print?: number | null;
  picture_book_key?: string | null;
  coloring_book_key?: string | null;
  audiobook_key?: string | null;
  public_slug?: string | null;
}

// Group one order's items by slug+format with counts, in first-seen
// order. Parses the same items JSON (book_slugs fallback included)
// as orderItemLabels; a legacy item with no recorded format counts
// as digital, matching parseItems.
function groupOrderItems(
  order: { items?: string | null; book_slugs?: string | null },
  books: Map<string, OrderBookRow>
): OrderItemGroup[] {
  let raw: { slug: string; format: string; qty?: number; priceCents?: number; gift?: boolean }[] = [];
  try {
    const parsed = JSON.parse(order.items || "[]");
    if (Array.isArray(parsed)) {
      raw = parsed
        .filter((x: any) => x && x.slug)
        .map((x: any) => ({
          slug: String(x.slug),
          format: storedItemFormat(String(x.slug), x.format || "digital"),
          qty: itemQty(x),
          ...(Number.isFinite(Number(x?.priceCents)) && Number(x?.priceCents) >= 0
            ? { priceCents: Math.round(Number(x.priceCents)) }
            : {}),
          ...(x?.gift === true ? { gift: true as const } : {}),
        }));
    }
  } catch { /* fall through to book_slugs */ }
  if (!raw.length) {
    try {
      const parsed = JSON.parse(order.book_slugs || "[]");
      if (Array.isArray(parsed)) raw = parsed.map((s: any) => ({ slug: String(s), format: "digital" }));
    } catch { /* no items at all */ }
  }
  const groups: OrderItemGroup[] = [];
  const byKey = new Map<string, OrderItemGroup>();
  for (const i of raw) {
    // A stored per-line price (manual orders) is part of the group
    // identity: two lines for the same book at different prices stay
    // separate rows, priced as entered. Checkout book lines never
    // carry one, so their keys are unchanged. A gift flag is part of
    // the identity too: a gift copy and a keeper copy of the same
    // book stay separate rows, because packing treats them so.
    const key = i.slug + "|" + i.format + "|" + (i.priceCents != null ? String(i.priceCents) : "") + "|" + (i.gift ? "gift" : "");
    const existing = byKey.get(key);
    if (existing) {
      existing.count += itemQty(i);
    } else {
      const book = books.get(i.slug);
      const title = clubLineDisplay(i.slug, i.format)?.title || book?.title || "Big Brain Shelf book";
      const pub = book ? publicSlugFor(book) : "";
      const g: OrderItemGroup = {
        title,
        name: shortBookName(title),
        format: i.format,
        count: itemQty(i),
        ...(i.gift ? { gift: true } : {}),
        code: book ? bookCodeForTitle(title) : null,
        cover: book
          ? coverDerivative(String(book.slug), "card", book.cover_key) ||
            (book.cover_key ? MEDIA_PUBLIC + book.cover_key : null)
          : null,
        href: book ? (i.format === "audio" ? `/audiobooks/${pub}` : `/books/${pub}`) : null,
        unitCents: i.priceCents != null
          ? i.priceCents
          : book
            ? checkoutItemPrice(book, i.format, { digital: false, audio: false })?.cents ?? null
            : null,
      };
      byKey.set(key, g);
      groups.push(g);
    }
  }
  return groups;
}

// Pick-list groups for a batch of orders, one books query total.
// Returns a Map from order id to its groups.
export async function orderPickList(
  db: any,
  orders: { id: string; items?: string | null; book_slugs?: string | null }[]
): Promise<Map<string, OrderItemGroup[]>> {
  const slugSet = new Set<string>();
  for (const o of orders) {
    try {
      const parsed = JSON.parse(o.items || "[]");
      if (Array.isArray(parsed)) for (const x of parsed) if (x && x.slug) slugSet.add(String(x.slug));
    } catch { /* book_slugs fallback below is collected too */ }
    try {
      const parsed = JSON.parse(o.book_slugs || "[]");
      if (Array.isArray(parsed)) for (const s of parsed) slugSet.add(String(s));
    } catch { /* no slugs */ }
  }
  const books = (await loadBooksByAnySlug(
    db,
    [...slugSet],
    "slug, title, cover_key, price, price_print, picture_book_key, coloring_book_key, audiobook_key, public_slug"
  )) as Map<string, OrderBookRow>;
  const out = new Map<string, OrderItemGroup[]>();
  for (const o of orders) out.set(o.id, groupOrderItems(o, books));
  return out;
}

// Structured content for the order confirmation. The plain-text builder
// below and the React Email template (emails/) both render from this
// one model, so the words and the facts can never drift apart.
export interface PricedOrderLine {
  title: string;
  format: string;
  formatLabel: string;
  qty: number;
  unitCents: number;
  lineTotalCents: number;
}

// The one place an order's lines get display prices (the account
// receipt and both order emails read these same numbers). Rules
// mirror checkoutItemPrice and receipt.astro: per-book price columns
// win for digital and printed, gift set and audio are the catalog
// constants, quantities multiply, and an audio-upgrade digital line
// is credited the audio price its buyer already paid. A stored
// per-line price (manual orders only) wins over all of it. Lines
// group by slug + format + credit, the way the confirmation has
// always grouped.
export function pricedOrderLines(order: any, books: BookFiles[]): PricedOrderLine[] {
  const bookBySlug = new Map(books.map((b) => [b.slug, b]));
  const unitFor = (item: { slug: string; format: string; upgrade?: string; priceCents?: number }): number => {
    // A stored per-line price (manual orders only) is what was
    // actually charged; it wins over every catalog rule below.
    if (item.priceCents != null) return item.priceCents;
    const b = bookBySlug.get(item.slug);
    const digital = Math.round(Number(b?.price || 0)) || STANDARD_DIGITAL_PRICE_CENTS;
    if (item.upgrade === "audio-upgrade") return Math.max(0, digital - AUDIO_PRICE_CENTS);
    if (item.format === "printed")
      return Math.round(Number(b?.price_print || 0)) || STANDARD_PRINT_PRICE_CENTS;
    if (item.format === "giftset") return GIFT_SET_PRICE_CENTS;
    if (item.format === "audio") return AUDIO_PRICE_CENTS;
    return digital;
  };
  const grouped = new Map<string, PricedOrderLine>();
  for (const i of parseItems(order)) {
    const key = `${i.slug}|${i.format}|${i.upgrade || ""}|${i.priceCents != null ? i.priceCents : ""}`;
    const found = grouped.get(key);
    if (found) {
      found.qty += itemQty(i);
      found.lineTotalCents = found.unitCents * found.qty;
      continue;
    }
    const unitCents = unitFor(i);
    const qty = itemQty(i);
    const club = clubLineDisplay(i.slug, i.format);
    grouped.set(key, {
      // A club line names the club, never its reserved cart slug.
      title: club?.title || bookBySlug.get(i.slug)?.title || i.slug,
      format: i.format,
      formatLabel:
        (club ? club.formatLabel : orderFormatLabel(i.format)) +
        (i.upgrade === "audio-upgrade" ? " · audiobook credit applied" : ""),
      qty,
      unitCents,
      lineTotalCents: unitCents * qty,
    });
  }
  return [...grouped.values()];
}

export interface ConfirmationEmailModel {
  subject: string;
  items: { title: string; formatLabel: string; qty: number; lineTotalCents: number }[];
  downloads: { title: string; links: { label: string; url: string }[] }[];
  libraryUrl: string;
  // True when the order has no account attached (guest checkout):
  // the email then also points at the one-click sign-in link the
  // guest flow sends separately, so the library is one tap away
  // without a password.
  guest: boolean;
  // Pass-through shipping summary for physical orders: the carrier and
  // service the buyer was quoted at checkout and the exact amount they
  // paid for shipping, plus the order total, so the confirmation shows
  // the same numbers as the receipt and the admin order view. Null for
  // digital/audio orders (no shipping was charged).
  shipping: { carrier: string; service: string; cents: number } | null;
  // A promo redemption on this order (lib/promo.ts): the discount
  // line that makes the full-price lines add up to the total.
  promo: { code: string; discountCents: number } | null;
  totalCents: number;
  printed: boolean;
  // True when every physical item in the order is a Gift Set, so the
  // printed section of the email can talk about the gift set instead of
  // a single printed book.
  giftsetOnly: boolean;
  // Book Club pitch block (Workstream 3): present unless the buyer is
  // already a paid club member of either plan. Prices always formatted
  // from the club constants in offers.ts, never hard-coded here. The
  // block pitches both plans: the physical Book Club (boxes) and the
  // Audio Club (listening only, no boxes and no shipping copy).
  club: {
    priceLabel: string;
    annualLabel: string;
    audioMonthlyLabel: string;
    audioAnnualLabel: string;
    url: string;
    live: boolean;
  } | null;
  site: string;
}

// Resolve the confirmation's club block for an order: null for paid
// members (no pitch to people who already joined) and null on any data
// problem, because the club block must never break the confirmation.
export async function resolveClubBlock(
  db: DBLike,
  site: string,
  order: any
): Promise<ConfirmationEmailModel["club"]> {
  try {
    const email = String(order?.email || "").trim();
    if (!email) return null;
    await ensureClubTable(db);
    if (await isPaidClubMember(db, email)) return null;
    return {
      priceLabel: clubPriceLabel(),
      annualLabel: clubPriceLabel(CLUB_ANNUAL_PRICE_CENTS),
      audioMonthlyLabel: clubPriceLabel(AUDIO_CLUB_PRICE_CENTS),
      audioAnnualLabel: clubPriceLabel(AUDIO_CLUB_ANNUAL_PRICE_CENTS),
      url: `${site}/clubs`,
      live: clubIsLive(),
    };
  } catch {
    return null;
  }
}

export function buildConfirmationEmailModel(
  site: string,
  order: any,
  books: BookFiles[],
  club: ConfirmationEmailModel["club"] = null
): ConfirmationEmailModel {
  const items = parseItems(order);
  const downloads: ConfirmationEmailModel["downloads"] = [];
  for (const b of books) {
    // The email names the book; the FILES live behind the account
    // library (CG, 2026-10-31: emailed download links must be
    // auth-backed, not bearer file URLs anyone holding the email can
    // open forever). One library link per book that has files: the
    // library serves exactly the formats the buyer owns, through the
    // signed-in download route.
    const hasFiles =
      b.picture_book_key || b.coloring_book_key || b.epub_key || b.color_book_key || b.audiobook_key;
    if (hasFiles) {
      downloads.push({ title: b.title, links: [{ label: "Open in your library", url: `${site}/account` }] });
    }
  }
  const physical = items.filter((i) => isPhysicalFormat(i.format));
  return {
    subject: "Your Big Brain Shelf order is ready",
    // One line per slug + format the buyer actually paid for, with
    // quantities summed. The old per-book map took the FIRST format
    // found for each book, so a mixed order (digital x2 + printed x1
    // of the same book) rendered as a single digital line and the
    // printed book vanished from the confirmation entirely.
    items: pricedOrderLines(order, books),
    downloads,
    libraryUrl: `${site}/account`,
    guest: !order?.user_id || String(order.user_id).startsWith("guest:"),
    shipping:
      Number(order?.shipping_cents || 0) > 0
        ? {
            carrier: String(order.quoted_carrier || order.carrier || ""),
            service: String(order.quoted_service || order.carrier_service || ""),
            cents: Number(order.shipping_cents),
          }
        : null,
    promo:
      order?.promo_code && Number(order?.promo_discount_cents || 0) > 0
        ? { code: String(order.promo_code), discountCents: Number(order.promo_discount_cents) }
        : null,
    totalCents: Number(order?.amount || 0),
    printed: physical.length > 0,
    giftsetOnly: physical.length > 0 && physical.every((i) => i.format === "giftset"),
    club,
    site,
  };
}

// The order confirmation. For digital and printed orders alike this is
// the email that points the buyer at their library: a printed pre-order
// includes the digital files today, plus a note about the physical
// copy. It carries no file links (CG, 2026-10-31: auth-backed only).
export function buildConfirmationEmail(
  site: string,
  order: any,
  books: BookFiles[],
  club: ConfirmationEmailModel["club"] = null
): { subject: string; text: string } {
  const model = buildConfirmationEmailModel(site, order, books, club);
  const lines: string[] = [];
  lines.push("Thank you for your order from Big Brain Shelf.");
  lines.push("");
  lines.push("Here is what you got:");
  for (const item of model.items) {
    lines.push(
      `- ${item.title} (${item.formatLabel})${item.qty > 1 ? ` ×${item.qty}` : ""}: $${(item.lineTotalCents / 100).toFixed(2)}`
    );
  }
  if (model.shipping) {
    const via = [model.shipping.carrier, model.shipping.service].filter(Boolean).join(" ");
    lines.push(`- Shipping${via ? ` (${via})` : ""}: $${(model.shipping.cents / 100).toFixed(2)}`);
  }
  if (model.promo) {
    // Discount only: whether the free club year granted is the
    // grant path's own email to announce (a redemption can void at
    // completion, e.g. a guest who turns out not to be a first
    // purchase, and this email must never promise it falsely).
    lines.push(`- Promo ${model.promo.code}: -$${(model.promo.discountCents / 100).toFixed(2)}`);
  }
  if (model.totalCents > 0) {
    lines.push(`Total charged: $${(model.totalCents / 100).toFixed(2)}`);
  }
  lines.push("");
  lines.push("Your books are in your library:");
  for (const d of model.downloads) {
    lines.push(`- ${d.title}`);
  }
  lines.push("");
  lines.push("Sign in with the email you used at checkout. Your books are waiting for you on any device:");
  lines.push(model.libraryUrl);
  if (model.guest) {
    lines.push("We also sent you a one-click sign-in link in a separate email, so you do not need a password.");
  }
  if (model.printed) {
    lines.push("");
    if (model.giftsetOnly) {
      lines.push("About your gift set:");
      lines.push("Your gift set is being made: the printed storybook and the printed coloring book are prepared together. We will email you when it is being printed, when it is packed, when it ships, and when it is delivered. The digital files are yours to enjoy right away, in your library.");
    } else {
      lines.push("About your printed book:");
      lines.push("Your printed book is being made. We will email you when it is being printed, when it is packed, when it ships, and when it is delivered. The digital files are yours to enjoy right away, in your library.");
    }
  }
  if (model.club) {
    lines.push("");
    lines.push("About the Book Club:");
    lines.push(
      `Members get a full gift set in every box: the club book as a printed storybook and printed coloring book, a second printed book from the back catalog, a sticker sheet, and a little extra from the cast. The digital editions are in their library from day one. Membership is ${model.club.priceLabel} every 3 months, shipping included, or ${model.club.annualLabel} a year, and your price stays locked while your membership stays active. Your first box ships within 5 to 7 days of joining, and a new box follows every 3 months from your join date.`
    );
    lines.push(
      `Rather just listen? The Audio Club puts every Big Brain Shelf audiobook in your library for ${model.club.audioMonthlyLabel} a month, or ${model.club.audioAnnualLabel} a year, for as long as your membership is active. Listening only: nothing ships on that plan.`
    );
    lines.push(`Join the club: ${model.club.url}`);
  }
  lines.push("");
  lines.push("Happy reading,");
  lines.push("Big Brain Shelf");
  return { subject: model.subject, text: lines.join("\n") };
}

export const PHYSICAL_FLOW = ["preorder_received", "in_print", "packed", "shipped", "delivered"] as const;

const PHYSICAL_COPY: Record<string, { subject: string; headline: string; body: string }> = {
  in_print: {
    subject: "Your printed book is being printed",
    headline: "Good news: your printed book is being printed.",
    body: "It is on the press now. We will email you when it is packed and again as soon as it ships.",
  },
  packed: {
    subject: "Your order is packed",
    headline: "Good news: your order is packed.",
    body: "Your printed book is packed up and ready to go. We will email you as soon as it ships.",
  },
  shipped: {
    subject: "Your printed book has shipped",
    headline: "Your printed book is on its way.",
    body: "It has left the printer and is heading to you. We will email you when it is delivered.",
  },
  delivered: {
    subject: "Your printed book has been delivered",
    headline: "Your printed book has arrived.",
    body: "It should be at your door now. We hope it gets colored in, read to pieces, and loved. Thank you for being part of the Shelf.",
  },
};

// Structured content for a printed pre-order status update; the text
// builder and the React Email template render from this same model.
export interface PhysicalEmailModel {
  subject: string;
  headline: string;
  body: string;
  titles: string[];
  // Present on the shipped email when a Shippo label was bought for the
  // order (carrier + tracking number). Absent otherwise, and the email
  // renders exactly as it did before labels existed.
  carrier?: string;
  trackingNumber?: string;
}

export function buildPhysicalUpdateEmailModel(
  order: any,
  books: BookFiles[],
  status: string
): PhysicalEmailModel | null {
  const copy = PHYSICAL_COPY[status];
  if (!copy) return null;
  // Titles carry their format suffix ("(printed)" / "(gift set)") so the
  // text and HTML renderers print them verbatim.
  const titles: string[] = [];
  for (const item of parseItems(order)) {
    if (!isPhysicalFormat(item.format)) continue;
    const b = books.find((x) => x.slug === item.slug);
    if (b) titles.push(`${b.title} (${item.format === "giftset" ? "gift set" : "printed"})`);
  }
  const model: PhysicalEmailModel = { subject: copy.subject, headline: copy.headline, body: copy.body, titles };
  if (status === "shipped" && order.tracking_number) {
    model.carrier = String(order.carrier || "");
    model.trackingNumber = String(order.tracking_number);
  }
  return model;
}

export function buildPhysicalUpdateEmail(
  order: any,
  books: BookFiles[],
  status: string
): { subject: string; text: string } | null {
  const model = buildPhysicalUpdateEmailModel(order, books, status);
  if (!model) return null;
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
  lines.push("");
  lines.push("Big Brain Shelf");
  return { subject: model.subject, text: lines.join("\n") };
}

// Outbox columns added for the club funnel (Workstream 3): send_after
// delays a row (the day-3 follow-up), from_email overrides the sender
// (marketing sends from news@). Mirrored in migration.sql; applied to
// production D1. Same runtime-migration pattern as ensureClubTable.
const OUTBOX_COLUMNS: Record<string, string> = {
  send_after: "INTEGER",
  from_email: "TEXT",
  // Book Club V2: cycle emails are not order mail. dedupe_key carries a
  // globally unique idempotency key (club_box:{id}:{kind}) with its own
  // unique index; club_box_id links the row to its club_cycle_boxes row
  // so the HTML renderer can rebuild the model at send time.
  dedupe_key: "TEXT",
  club_box_id: "TEXT",
  // Per-row reply-to (contact form forwards carry the sender's
  // address); sends fall back to the support identity without it.
  reply_to: "TEXT",
};

export async function ensureOutboxColumns(db: DBLike): Promise<void> {
  await ensureOnce(db, "email_outbox.columns", async () => {
    const { results } = await db
      .prepare("SELECT name FROM pragma_table_info('email_outbox')")
      .bind()
      .all();
    const have = new Set((results || []).map((r: any) => String(r.name)));
    for (const [name, type] of Object.entries(OUTBOX_COLUMNS)) {
      if (!have.has(name)) {
        await db.prepare(`ALTER TABLE email_outbox ADD COLUMN ${name} ${type}`).bind().run();
      }
    }
    try {
      await db
        .prepare(
          "CREATE UNIQUE INDEX IF NOT EXISTS email_outbox_dedupe_idx ON email_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL"
        )
        .bind()
        .run();
    } catch { /* index is a dedupe guard, never a reason to fail a send */ }
  });
}

// ---------------------------------------------------------------------------
// Pack checklist state (admin redesign S4, 2026-11-03). The fulfillment
// view's pack step ticks lines as books go into the box; the ticks live
// on the order row (pack_json, runtime-ensured like the other late
// columns) so they survive reloads and follow the order, not a browser
// session. Shape: a flat object of line key -> true, plus the reserved
// key PACK_LABEL_KEY for the printed-label confirmation. Line keys are
// built by lib/packing.ts.
export const PACK_LABEL_KEY = "__label";

export async function ensureOrderPackColumns(db: DBLike): Promise<void> {
  await ensureOnce(db, "orders.pack_columns", async () => {
    const { results } = await db
      .prepare("SELECT name FROM pragma_table_info('orders')")
      .bind()
      .all();
    const have = new Set((results || []).map((r: any) => String(r.name)));
    if (!have.has("pack_json")) {
      await db.prepare("ALTER TABLE orders ADD COLUMN pack_json TEXT").bind().run();
    }
  });
}

export type PackState = Record<string, boolean>;

/** Parse a stored pack_json value; junk reads as "nothing ticked". */
export function parsePackState(raw: unknown): PackState {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: PackState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

/** Validate an incoming pack payload: only boolean-true ticks survive. */
export function normalizePackState(input: unknown): PackState | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: PackState = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k.length > 80) return null;
    if (v) out[k] = true;
  }
  return out;
}

export async function setOrderPack(db: DBLike, orderId: string, pack: PackState): Promise<void> {
  await ensureOrderPackColumns(db);
  await db
    .prepare("UPDATE orders SET pack_json = ? WHERE id = ?")
    .bind(JSON.stringify(pack), orderId)
    .run();
}

// ---------------------------------------------------------------------------
// Manual orders (admin redesign fix, 2026-11-03): an operator can
// create a real order by hand for an offline sale, a replacement, or
// a comp. The row is an ordinary completed order in every fulfillment
// respect, marked in its data: source = 'manual', the Stripe session
// slot carries 'manual:<id>' (manual orders have no Stripe objects),
// and an internal admin_note rides along for the detail page. No
// emails are enqueued at creation; the shipped and delivered emails
// fire through the normal fulfillment actions afterwards, exactly as
// for a checkout order. Label purchase on a manual order goes through
// the fresh-quote path (there is no checkout rate to reuse).

export async function ensureOrderManualColumns(db: DBLike): Promise<void> {
  await ensureOnce(db, "orders.manual_columns", async () => {
    const { results } = await db
      .prepare("SELECT name FROM pragma_table_info('orders')")
      .bind()
      .all();
    const have = new Set((results || []).map((r: any) => String(r.name)));
    if (!have.has("source")) {
      await db.prepare("ALTER TABLE orders ADD COLUMN source TEXT").bind().run();
    }
    if (!have.has("admin_note")) {
      await db.prepare("ALTER TABLE orders ADD COLUMN admin_note TEXT").bind().run();
    }
  });
}

export interface ManualOrderLineInput {
  // The book's PUBLIC slug, as picked in the form; the internal slug
  // is resolved server-side and is what the order row stores.
  slug: string;
  format: string;
  qty: number;
  priceCents: number;
}

export interface ManualOrderAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postal_code: string;
  country?: string;
}

/** The catalog the manual-order form picks from: sellable books by
 *  public title, with the store's default price per format (the form
 *  pre-fills these and the admin may edit them per line). */
export async function listManualOrderCatalog(db: DBLike): Promise<
  {
    slug: string;
    title: string;
    prices: { digital: number | null; printed: number | null; giftset: number | null; audio: number | null };
  }[]
> {
  await ensurePublicSlugColumn(db);
  const { results } = await db
    .prepare(
      `SELECT slug, title, price, price_print, picture_book_key, coloring_book_key, audiobook_key, public_slug
       FROM books WHERE status IN ('complete', 'ready_for_qa') ORDER BY title`
    )
    .bind()
    .all();
  return ((results || []) as any[]).map((b) => ({
    slug: publicSlugFor(b),
    title: String(b.title || b.slug),
    prices: {
      digital: checkoutItemPrice(b, "digital", { digital: false, audio: false })?.cents ?? null,
      printed: checkoutItemPrice(b, "printed", { digital: false, audio: false })?.cents ?? null,
      giftset: checkoutItemPrice(b, "giftset", { digital: false, audio: false })?.cents ?? null,
      audio: checkoutItemPrice(b, "audio", { digital: false, audio: false })?.cents ?? null,
    },
  }));
}

export async function createManualOrder(
  db: DBLike,
  args: {
    name?: string;
    email: string;
    address?: ManualOrderAddress | null;
    lines: ManualOrderLineInput[];
    shippingCents?: number;
    note?: string;
  }
): Promise<{ ok: true; order: any } | { ok: false; error: string }> {
  await ensureOrderManualColumns(db);
  const email = String(args.email || "").trim();
  if (!email || !email.includes("@")) {
    return { ok: false, error: "A customer email is required." };
  }
  const rawLines = Array.isArray(args.lines) ? args.lines : [];
  if (!rawLines.length) {
    return { ok: false, error: "Add at least one book to the order." };
  }
  const items: CartItem[] = [];
  for (const line of rawLines) {
    const format = normalizeFormat(line?.format);
    const internal = await resolveInternalSlug(db, String(line?.slug || "")).catch(() => null);
    if (!internal) {
      return { ok: false, error: `That book is not on the shelf: ${String(line?.slug || "")}` };
    }
    const priceCents = Math.round(Number(line?.priceCents));
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      return { ok: false, error: "Every line needs a price of zero or more." };
    }
    items.push({
      slug: internal,
      format,
      qty: lineQty({ format, qty: line?.qty }),
      priceCents,
    });
  }
  const physical = items.some((i) => isPhysicalFormat(i.format));
  let shipAddress: string | null = null;
  if (args.address && (args.address.line1 || args.address.city || args.address.postal_code)) {
    shipAddress = JSON.stringify({
      line1: String(args.address.line1 || ""),
      line2: String(args.address.line2 || ""),
      city: String(args.address.city || ""),
      state: String(args.address.state || ""),
      postal_code: String(args.address.postal_code || ""),
      country: String(args.address.country || "US"),
    });
  }
  if (physical && !shipAddress) {
    return { ok: false, error: "A shipping address is required when the order has printed books." };
  }
  const shippingCents = Math.max(0, Math.round(Number(args.shippingCents || 0)) || 0);
  const amount =
    items.reduce((sum, i) => sum + (i.priceCents || 0) * itemQty(i), 0) + shippingCents;
  const id = "ord_" + crypto.randomUUID();
  const ts = Math.floor(Date.now() / 1000);
  const bookSlugs = [...new Set(items.map((i) => i.slug))];
  await db
    .prepare(
      `INSERT INTO orders (id, user_id, email, book_slugs, items, stripe_session_id, amount, currency, status,
         delivery_token, created_at, physical_status, ship_name, ship_address, shipping_cents, source, admin_note)
       VALUES (?, '', ?, ?, ?, ?, ?, 'usd', 'complete', ?, ?, ?, ?, ?, ?, 'manual', ?)`
    )
    .bind(
      id,
      email,
      JSON.stringify(bookSlugs),
      JSON.stringify(items),
      "manual:" + id,
      amount,
      crypto.randomUUID(),
      ts,
      // Physical lines land on the packing shelf at the first stage,
      // exactly like a completed checkout order; a digital-only
      // manual order carries no physical status and is fulfilled.
      physical ? "preorder_received" : null,
      String(args.name || "").trim() || null,
      shipAddress,
      shippingCents,
      String(args.note || "").trim() || null
    )
    .run();
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  return { ok: true, order };
}

// Enqueue an email. The unique (order_id, kind) index makes this a no-op
// if the same kind was ever enqueued for the order before, which is what
// guarantees exactly one confirmation and one update per status change.
// Scoped sender identities (see the identity map in lib/email.ts; the
// literals here mirror NOREPLY_EMAIL / HELLO_EMAIL there, duplicated
// because email.ts imports from this module). Callers that pass an
// explicit fromEmail (marketing sends from news@) always win; kinds not
// listed here send from the orders@ default at flush time.
const NOREPLY_KINDS = new Set(["magic_link", "password_reset", "contact_form", "admin_digest"]);
const HELLO_KINDS = new Set([
  "family_onboarding",
  "birthday_gift",
  "club_welcome",
  "club_cycle_locked",
  "club_cycle_attention",
  "completion_upsell",
]);

export function senderForKind(kind: string): string | null {
  if (NOREPLY_KINDS.has(kind)) return "noreply@bigbrainshelf.com";
  if (HELLO_KINDS.has(kind)) return "hello@bigbrainshelf.com";
  return null;
}

export async function enqueueEmail(
  db: DBLike,
  args: {
    orderId: string | null;
    kind: string;
    to: string;
    subject: string;
    text: string;
    sendAfter?: number | null;
    fromEmail?: string | null;
    dedupeKey?: string | null;
    clubBoxId?: string | null;
    replyTo?: string | null;
  }
): Promise<void> {
  if (!args.to) return;
  await ensureOutboxColumns(db);
  await db
    .prepare(
      `INSERT OR IGNORE INTO email_outbox (id, order_id, kind, to_email, subject, body_text, status, attempts, created_at, send_after, from_email, dedupe_key, club_box_id, reply_to)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      args.orderId,
      args.kind,
      args.to,
      args.subject,
      args.text,
      now(),
      args.sendAfter ?? null,
      args.fromEmail ?? senderForKind(args.kind),
      args.dedupeKey ?? null,
      args.clubBoxId ?? null,
      args.replyTo ?? null
    )
    .run();
}

export async function enqueueConfirmation(db: DBLike, site: string, order: any): Promise<void> {
  const books = await loadBooksForOrder(db, order);
  const club = await resolveClubBlock(db, site, order);
  const { subject, text } = buildConfirmationEmail(site, order, books, club);
  await enqueueEmail(db, {
    orderId: order.id,
    kind: "order_confirmation",
    to: order.email,
    subject,
    text,
  });
}

// Where new-order notices go (CG, 2026-10-31: "on orders and
// things, send me an email"). The storefront's money ping: one
// short email per paid order, deduped by order so webhook
// retries never send it twice.
export const OWNER_NOTIFY_EMAIL = "cg@rocktownlabs.com";

export async function enqueueOwnerOrderNotice(db: DBLike, site: string, order: any): Promise<void> {
  const books = await loadBooksForOrder(db, order);
  // Lines come from the order's own items (one per slug + format,
  // quantities included). Zipping books[i] against formats[i] broke
  // the moment one book was bought in two formats: the second line
  // silently disappeared from the notice.
  const money = (c: number) => `$${(Number(c || 0) / 100).toFixed(2)}`;
  const lines = pricedOrderLines(order, books).map((l) => {
    // Club lines store their billing period as the format; no book
    // format uses those words, so the period names a membership.
    const label =
      l.format === "quarterly" || l.format === "monthly" || l.format === "annual" ? "Membership"
      : l.format === "printed" ? "Printed book"
      : l.format === "giftset" ? "Gift set"
      : l.format === "audio" ? "Audiobook"
      : "Digital bundle";
    return l.qty > 1
      ? `${l.title} (${label}) ×${l.qty} - ${money(l.lineTotalCents)}`
      : `${l.title} (${label}) - ${money(l.lineTotalCents)}`;
  });
  const short = String(order.id || "").slice(0, 8).toUpperCase();
  const total = money(order.amount);
  const shipping = Number(order.shipping_cents || 0) > 0 ? `\nShipping: ${money(order.shipping_cents)}` : "";
  let shipTo = "";
  try {
    const a = JSON.parse(String(order.ship_address || "null"));
    if (a) {
      const cityLine = [a.city, a.state, a.postal_code || a.zip].filter(Boolean).join(", ").replace(/, ([^,]+)$/, " $1");
      const addr = [a.line1, a.line2, cityLine].filter(Boolean).join(", ");
      if (addr) shipTo = `\nShip to: ${order.ship_name ? String(order.ship_name) + ", " : ""}${addr}`;
    }
  } catch { /* digital orders carry no address */ }
  await enqueueEmail(db, {
    orderId: order.id,
    kind: "owner_new_order",
    to: OWNER_NOTIFY_EMAIL,
    subject: `New order #${short}: ${total}`,
    text:
      `New Big Brain Shelf order #${short} - ${lines.length} ${lines.length === 1 ? "item" : "items"}, ${total} total.\n\n` +
      `${lines.join("\n")}${shipping}\nTotal charged: ${total}\n\n` +
      `Buyer: ${order.email}${shipTo}\n` +
      `Order page: ${site}/admin/orders/${order.id}\n`,
    dedupeKey: `owner-notice:${order.id}`,
  });
}

// Full handling for a paid checkout.session.completed event: converge the
// order, then enqueue its one confirmation email.
export async function processCheckoutCompleted(db: DBLike, site: string, session: any, env?: any): Promise<any> {
  const order = await completeOrder(db, session);
  if (order) {
    // Club line in the cart (CG, 2026-11-07): the membership the
    // buyer just subscribed to activates from the ORDER, keyed to
    // the order's email, before the confirmation email resolves its
    // club pitch block (a brand-new member must not be pitched the
    // club they just joined). Best effort like every hook here: the
    // order stands even if activation hiccups, and a Stripe webhook
    // replay re-runs the (idempotent) activation. The Stripe client
    // exists only to cancel a replaced subscription on an upgrade;
    // without env (test callers) activation still lands and the old
    // sub is left for the lifecycle webhooks to settle.
    if (parseItems(order).some((i) => isClubCartSlug(i.slug))) {
      try {
        const { activateClubFromOrder } = await import("./club");
        let stripe: any = undefined;
        if (env?.STRIPE_SECRET_KEY) {
          try {
            const { default: Stripe } = await import("stripe");
            stripe = new Stripe(env.STRIPE_SECRET_KEY);
          } catch { /* activation proceeds without the cancel step */ }
        }
        await activateClubFromOrder(db, order, session, stripe);
      } catch (err: any) {
        console.error("club activation from order failed", order.id, err?.message || err);
      }
    }
    await enqueueConfirmation(db, site, order);
    await enqueueOwnerOrderNotice(db, site, order).catch(() => {});
    // Lulu lane (CG, 2026-11-07: "set the lulu flow so it places
    // the order"): a paid order with physical lines places its
    // print job automatically. Best effort by design: the helper
    // itself never throws, the cron dispatcher retries anything it
    // leaves queued, and a Lulu outage can never fail a completed
    // order. env is optional so non-webhook callers (and the test
    // suites) keep the pre-lane behavior by passing nothing.
    if (env) {
      try {
        const { autoPlacePrintJobForOrder } = await import("./print-fulfillment");
        await autoPlacePrintJobForOrder(db, env, order, site);
      } catch (err: any) {
        console.error("lulu auto-place hook failed for order", order.id, err?.message || err);
      }
    }
    // Guest buyers get their way back in with the order: a
    // one-click sign-in link email (the account is created on
    // first click if they never made one). Signed-in buyers
    // (user_id set) already have their way in. Never fatal.
    if (!String(order.user_id || "").trim() && order.email) {
      try {
        const { getAuth } = await import("./auth");
        await getAuth().api.signInMagicLink({
          body: { email: String(order.email), callbackURL: "/account" },
        });
      } catch { /* the confirmation email still points at the library */ }
    }
  }
  return order;
}

// Advance a printed order one step (or to a named step) and enqueue the
// matching update email. Forward-only; re-setting the current status is a
// harmless no-op so an admin double click can never send a second email.
export async function setPhysicalStatus(
  db: DBLike,
  site: string,
  orderId: string,
  status: string
): Promise<{ ok: boolean; error?: string; order?: any }> {
  if (!PHYSICAL_FLOW.includes(status as any)) {
    return { ok: false, error: `unknown physical status: ${status}` };
  }
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
  if (!order) return { ok: false, error: "order not found" };
  if (!hasPrinted(order)) return { ok: false, error: "order has no printed items" };
  const current = order.physical_status || "preorder_received";
  if (PHYSICAL_FLOW.indexOf(status as any) < PHYSICAL_FLOW.indexOf(current as any)) {
    return { ok: false, error: `cannot move back from ${current} to ${status}` };
  }
  if (status !== current) {
    await db
      .prepare("UPDATE orders SET physical_status = ? WHERE id = ?")
      .bind(status, orderId)
      .run();
    order.physical_status = status;
  }
  const books = await loadBooksForOrder(db, order);
  const email = buildPhysicalUpdateEmail(order, books, status);
  if (email) {
    await enqueueEmail(db, {
      orderId: order.id,
      kind: `physical_update_${status}`,
      to: order.email,
      subject: email.subject,
      text: email.text,
    });
  }
  return { ok: true, order };
}
