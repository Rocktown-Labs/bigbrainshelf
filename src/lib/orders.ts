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
import { publicSlugFor } from "./public-slugs";
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
  format: string; // "digital" | "printed" | "giftset" | "audio"
  // Set at checkout when a server-side credit shaped this line's price.
  // Today the only credit is "audio-upgrade": an audiobook-only owner
  // unlocking the digital edition. Recorded on the order so the
  // discounted charge is auditable after the fact.
  upgrade?: string;
  // Copies of this line (CG, 2026-10-31: quantities belong on the
  // order, the receipts, and the emails). Absent means 1; every
  // reader normalizes through itemQty.
  qty?: number;
}

// The one quantity rule: an integer from 1 to 99, anything else
// (absent, zero, negative, fractional, junk) reads as 1..99 clamped.
export function itemQty(x: { qty?: unknown } | null | undefined): number {
  const n = Math.floor(Number((x as any)?.qty));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(99, n);
}

// ---------------------------------------------------------------------------
// Checkout pricing: the single place a (book, format, ownership) triple
// becomes a charge. /api/checkout calls this for every line; the client
// never supplies a price, and the audio upgrade credit is computed here
// from the entitlement layer's answer, never from a client flag.
//
// The credit (CG, 2026-10-28): a buyer who owns the audiobook only for
// a book unlocks its digital edition for the digital price minus the
// $1.99 audio price they already paid (899 - 199 = 700 today), floored
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
  const canonical =
    userId + "|" + items.map((i) => `${i.slug}:${i.format}:${itemQty(i)}`).sort().join(",");
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
          format: normalizeFormat(x?.format),
          ...(x?.upgrade ? { upgrade: String(x.upgrade) } : {}),
          qty: itemQty(x),
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
            format: normalizeFormat(x?.format),
            ...(x?.upgrade ? { upgrade: String(x.upgrade) } : {}),
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
    const b = await db
      .prepare(
        "SELECT slug, title, picture_book_key, coloring_book_key, epub_key, color_book_key, audiobook_key FROM books WHERE slug = ?"
      )
      .bind(slug)
      .first();
    if (b) books.push(b as BookFiles);
  }
  return books;
}

const FILE_LABELS: [keyof BookFiles, string, string][] = [
  ["picture_book_key", "Story book (PDF)", "picture"],
  ["coloring_book_key", "Coloring book (PDF)", "coloring"],
  ["epub_key", "EPUB e-book", "epub"],
  ["color_book_key", "Full color story book (PDF)", "color"],
  ["audiobook_key", "Audiobook", "audiobook"],
];

export function downloadUrl(site: string, token: string, slug: string, format: string): string {
  return `${site}/api/order-download?token=${encodeURIComponent(token)}&slug=${encodeURIComponent(slug)}&format=${format}`;
}

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
    const slugs = [...slugSet];
    const ph = slugs.map(() => "?").join(",");
    const rows = await db
      .prepare(`SELECT slug, title FROM books WHERE slug IN (${ph})`)
      .bind(...slugs)
      .all();
    for (const r of (rows.results || []) as any[]) {
      titles.set(String(r.slug), String(r.title || ""));
    }
  }
  const out = new Map<string, string[]>();
  for (const o of orders) {
    const items = parsed.get(o.id) || [];
    out.set(
      o.id,
      items.map((i) => {
        const title = titles.get(i.slug) || "Big Brain Shelf book";
        const qty = itemQty(i as any) > 1 ? ` ×${itemQty(i as any)}` : "";
        return i.format ? `${title} (${orderFormatLabel(i.format)})${qty}` : `${title}${qty}`;
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
  format: string; // digital | printed | giftset | audio
  count: number;
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
  let raw: { slug: string; format: string; qty?: number }[] = [];
  try {
    const parsed = JSON.parse(order.items || "[]");
    if (Array.isArray(parsed)) {
      raw = parsed
        .filter((x: any) => x && x.slug)
        .map((x: any) => ({ slug: String(x.slug), format: String(x.format || "digital"), qty: itemQty(x) }));
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
    const key = i.slug + "|" + i.format;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += itemQty(i);
    } else {
      const book = books.get(i.slug);
      const title = book?.title || "Big Brain Shelf book";
      const pub = book ? publicSlugFor(book) : "";
      const g: OrderItemGroup = {
        title,
        name: shortBookName(title),
        format: i.format,
        count: itemQty(i),
        cover: book
          ? coverDerivative(i.slug, "card", book.cover_key) ||
            (book.cover_key ? MEDIA_PUBLIC + book.cover_key : null)
          : null,
        href: book ? (i.format === "audio" ? `/audiobooks/${pub}` : `/books/${pub}`) : null,
        unitCents: book
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
  const books = new Map<string, OrderBookRow>();
  if (slugSet.size) {
    const slugs = [...slugSet];
    const ph = slugs.map(() => "?").join(",");
    const rows = await db
      .prepare(
        `SELECT slug, title, cover_key, price, price_print, picture_book_key, coloring_book_key, audiobook_key, public_slug FROM books WHERE slug IN (${ph})`
      )
      .bind(...slugs)
      .all();
    for (const r of (rows.results || []) as any[]) {
      books.set(String(r.slug), { ...r, slug: String(r.slug), title: String(r.title || "") });
    }
  }
  const out = new Map<string, OrderItemGroup[]>();
  for (const o of orders) out.set(o.id, groupOrderItems(o, books));
  return out;
}

// Structured content for the order confirmation. The plain-text builder
// below and the React Email template (emails/) both render from this
// one model, so the words and the facts can never drift apart.
export interface ConfirmationEmailModel {
  subject: string;
  items: { title: string; formatLabel: string; qty: number }[];
  downloads: { title: string; links: { label: string; url: string }[] }[];
  libraryUrl: string;
  // Pass-through shipping summary for physical orders: the carrier and
  // service the buyer was quoted at checkout and the exact amount they
  // paid for shipping, plus the order total, so the confirmation shows
  // the same numbers as the receipt and the admin order view. Null for
  // digital/audio orders (no shipping was charged).
  shipping: { carrier: string; service: string; cents: number } | null;
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
    // What the buyer may download for THIS book follows the format
    // they bought for it: a digital-carrying format (digital, printed,
    // gift set) unlocks every file, while an audiobook-only purchase
    // unlocks the audiobook alone. No items recorded for the book
    // (legacy rows) keeps the historical all-files behavior.
    const mine = items.filter((i) => i.slug === b.slug);
    const audioOnly =
      mine.length > 0 &&
      !mine.some((i) => i.format === "digital" || isPhysicalFormat(i.format)) &&
      mine.some((i) => i.format === "audio");
    const links = FILE_LABELS.filter(
      ([key, , format]) => b[key] && (!audioOnly || format === "audiobook")
    ).map(([, label, format]) => ({
      label,
      url: downloadUrl(site, order.delivery_token, b.slug, format),
    }));
    if (links.length) downloads.push({ title: b.title, links });
  }
  const physical = items.filter((i) => isPhysicalFormat(i.format));
  return {
    subject: "Your Big Brain Shelf order is ready",
    items: books.map((b) => {
      const format = items.find((i) => i.slug === b.slug)?.format;
      const qty = items
        .filter((i) => i.slug === b.slug && i.format === (format || "digital"))
        .reduce((sum, i) => sum + itemQty(i), 0) || 1;
      return {
        title: b.title,
        qty,
        formatLabel:
          format === "printed"
            ? "full color printed book, digital files included"
            : format === "giftset"
              ? "gift set: printed storybook and coloring book, digital files included"
              : format === "audio"
                ? "audiobook only"
                : "digital",
      };
    }),
    downloads,
    libraryUrl: `${site}/account`,
    shipping:
      Number(order?.shipping_cents || 0) > 0
        ? {
            carrier: String(order.quoted_carrier || order.carrier || ""),
            service: String(order.quoted_service || order.carrier_service || ""),
            cents: Number(order.shipping_cents),
          }
        : null,
    totalCents: Number(order?.amount || 0),
    printed: physical.length > 0,
    giftsetOnly: physical.length > 0 && physical.every((i) => i.format === "giftset"),
    club,
    site,
  };
}

// The order confirmation. For digital and printed orders alike this is the
// one email that carries the download links: a printed pre-order includes
// the digital files today, plus a note about the physical copy.
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
    lines.push(`- ${item.title} (${item.formatLabel})${item.qty > 1 ? ` ×${item.qty}` : ""}`);
  }
  if (model.shipping) {
    const via = [model.shipping.carrier, model.shipping.service].filter(Boolean).join(" ");
    lines.push(`- Shipping${via ? ` (${via})` : ""}: $${(model.shipping.cents / 100).toFixed(2)}`);
  }
  if (model.totalCents > 0) {
    lines.push(`Total charged: $${(model.totalCents / 100).toFixed(2)}`);
  }
  lines.push("");
  lines.push("Your download links:");
  for (const d of model.downloads) {
    lines.push(`${d.title}:`);
    for (const l of d.links) lines.push(`  ${l.label}: ${l.url}`);
  }
  lines.push("");
  lines.push("These links are yours and they do not expire. You can also find your books any time in your library:");
  lines.push(model.libraryUrl);
  if (model.printed) {
    lines.push("");
    if (model.giftsetOnly) {
      lines.push("About your gift set:");
      lines.push("Your gift set is being made: the printed storybook and the printed coloring book are prepared together. We will email you when it is being printed, when it is packed, when it ships, and when it is delivered. The digital files above are yours to enjoy right away.");
    } else {
      lines.push("About your printed book:");
      lines.push("Your printed book is being made. We will email you when it is being printed, when it is packed, when it ships, and when it is delivered. The digital files above are yours to enjoy right away.");
    }
  }
  if (model.club) {
    lines.push("");
    lines.push("About the Book Club:");
    lines.push(
      `Members of the Big Brain Shelf Book Club get the club book as a full gift set (the printed storybook plus its printed coloring book) and a second printed book from the back catalog in each box, plus a sticker sheet and a little extra from the cast, and the digital editions in their library from day one. Membership is ${model.club.priceLabel} every 3 months, shipping included, or ${model.club.annualLabel} a year, with your price locked while the membership stays active. Your first box would be due the day you join, and a new box follows every 3 months from your join date.`
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
}

// Enqueue an email. The unique (order_id, kind) index makes this a no-op
// if the same kind was ever enqueued for the order before, which is what
// guarantees exactly one confirmation and one update per status change.
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
      args.fromEmail ?? null,
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
  let formats: string[] = [];
  let quantities: number[] = [];
  try {
    const items = JSON.parse(String(order.items || "[]"));
    formats = items.map((i: any) => String(i.format || ""));
    quantities = items.map((i: any) => itemQty(i));
  } catch { /* titles alone still read fine */ }
  const priceFor = (f: string) =>
    f === "printed" ? STANDARD_PRINT_PRICE_CENTS
    : f === "giftset" ? GIFT_SET_PRICE_CENTS
    : f === "audio" ? AUDIO_PRICE_CENTS
    : STANDARD_DIGITAL_PRICE_CENTS;
  const money = (c: number) => `$${(Number(c || 0) / 100).toFixed(2)}`;
  const lines = books.map((b: any, i: number) => {
    const f = formats[i];
    const q = quantities[i] || 1;
    const label = f === "printed" ? "Printed book" : f === "giftset" ? "Gift set" : f === "audio" ? "Audiobook" : "Digital bundle";
    return q > 1
      ? `${b.title} (${label}) ×${q} - ${money(priceFor(f) * q)}`
      : `${b.title} (${label}) - ${money(priceFor(f))}`;
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
export async function processCheckoutCompleted(db: DBLike, site: string, session: any): Promise<any> {
  const order = await completeOrder(db, session);
  if (order) {
    await enqueueConfirmation(db, site, order);
    await enqueueOwnerOrderNotice(db, site, order).catch(() => {});
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
      } catch { /* the confirmation email still carries the downloads */ }
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
