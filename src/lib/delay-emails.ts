// Running-late emails (admin redesign S5, CG 2026-11-03).
//
// When a printed order or a Book Club box misses the ship date the
// customer was promised, we get ahead of it: one apology email that
// admits the delay is ours, names what is late, gives a new expected
// ship date, and carries a make-good code (SORRY10, 10% off the next
// order, seeded in lib/promo.ts) as body text. The single call to
// action is "Track your order". These are transactional service
// emails for something already paid for: they send from the orders@
// default and are never marketing-suppressed.
//
// One model per email, rendered to plain text here and to HTML by
// emails/DelayEmail.tsx through lib/email-render.ts, the same
// one-model discipline as the order and club cycle emails.
//
// The promised ship-by dates:
//   - Club box: ship_date + CLUB_PROCESSING_DAYS, exactly the
//     "ships by" date the account pages show the member.
//   - Store order: orders carry no promised date, so the promise is
//     the store's one stated print-and-pack turnaround, the same
//     CLUB_PROCESSING_DAYS (7) after the order date. That is why the
//     admin urgency panel's AGED_ORDER_DAYS (3) is NOT used here: it
//     is an internal tripwire, not a date a customer was given.
// A fulfillment is late the first day after its ship-by date, and
// the cron pass (lib/club-scheduler.ts) enqueues the email then.
//
// Idempotency: at most one delay email per order (the outbox
// (order_id, kind) unique index) and per club box per cycle (the
// cycle dedupe key club_box:{boxId}:club_box_delayed). The new
// expected date is derived from the outbox row's created_at, so the
// HTML render at send time states the same date the stored plain
// text promised at enqueue.

import {
  enqueueEmail,
  loadBooksForOrder,
  parseItems,
  isPhysicalFormat,
  type DBLike,
} from "./orders";
import {
  addDaysToDateString,
  dateStringFromUnixSeconds,
  formatClubDate,
  CLUB_PROCESSING_DAYS,
} from "./club-cycle-dates";

export const ORDER_DELAYED_KIND = "order_delayed";
export const CLUB_BOX_DELAYED_KIND = "club_box_delayed";

export const DELAY_EMAIL_KINDS = [ORDER_DELAYED_KIND, CLUB_BOX_DELAYED_KIND] as const;

export function isDelayEmailKind(kind: string): boolean {
  return (DELAY_EMAIL_KINDS as readonly string[]).includes(kind);
}

// The make-good code named in the email body (seeded in
// lib/promo.ts). Keep the two in step: the email promises exactly
// what the code redeems for.
export const DELAY_PROMO_CODE = "SORRY10";

// Days from the day we write to the customer to the new expected
// ship date stated in the email: a short, honest recovery window.
export const DELAY_NEW_EXPECTED_DAYS = 3;

// Pre-shipping stages a paid printed order can still be late in
// (the same set the urgency panel ages on).
const PRE_SHIP_STATUSES = ["preorder_received", "in_print", "packed"] as const;
// Box states where the contents are settled and the box is ours to
// pack and ship. awaiting_selection / needs_attention boxes are
// waiting on the member, not on us, and already get the
// action-needed cycle email instead.
const DELAYABLE_BOX_STATUSES = ["locked", "preparing"] as const;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The ship-by date (YYYY-MM-DD) a store order was promised. */
export function orderShipByDateString(order: { created_at?: number | null }): string {
  return addDaysToDateString(
    dateStringFromUnixSeconds(Number(order.created_at || nowSeconds())),
    CLUB_PROCESSING_DAYS
  );
}

/** The ship-by date (YYYY-MM-DD) a club box was promised. */
export function clubBoxShipByDateString(box: { ship_date?: string | null }): string {
  return addDaysToDateString(String(box.ship_date || ""), CLUB_PROCESSING_DAYS);
}

export interface DelayEmailModel {
  kind: string;
  subject: string;
  heading: string;
  intro: string;
  lateItems: string[];
  expectedLine: string;
  promoLine: string;
  trackUrl: string;
  trackLabel: string;
}

function baseModel(kind: string, trackUrl: string): Omit<DelayEmailModel, "subject" | "heading" | "intro" | "lateItems" | "expectedLine"> {
  return {
    kind,
    promoLine: `To make up for the wait, take 10% off your next order with the code ${DELAY_PROMO_CODE} at checkout.`,
    trackUrl,
    trackLabel: "Track your order",
  };
}

export function buildOrderDelayModel(args: {
  site: string;
  order: any;
  books: { slug: string; title: string }[];
  shipByDate: string;
  expectedDate: string;
}): DelayEmailModel {
  const lateItems: string[] = [];
  for (const item of parseItems(args.order)) {
    if (!isPhysicalFormat(item.format)) continue;
    const b = args.books.find((x) => x.slug === item.slug);
    if (b) lateItems.push(`${b.title} (${item.format === "giftset" ? "gift set" : "printed"})`);
  }
  return {
    ...baseModel(ORDER_DELAYED_KIND, `${args.site}/account/orders`),
    subject: "Your Big Brain Shelf order is running late",
    heading: "Your order is running late, and that is on us",
    intro: `We are sorry. Your printed order was meant to ship by ${formatClubDate(args.shipByDate)}, and it still has not gone out. That delay is ours, not yours.`,
    lateItems,
    expectedLine: `We now expect it to ship by ${formatClubDate(args.expectedDate)}, and we will email you the moment it is on its way.`,
  };
}

export function buildClubBoxDelayModel(args: {
  site: string;
  bookTitle?: string | null;
  shipByDate: string;
  expectedDate: string;
}): DelayEmailModel {
  return {
    ...baseModel(CLUB_BOX_DELAYED_KIND, `${args.site}/account/club`),
    subject: "Your Book Club box is running late",
    heading: "Your Book Club box is running late, and that is on us",
    intro: `We are sorry. Your Book Club box was meant to ship by ${formatClubDate(args.shipByDate)}, and it still has not gone out. That delay is ours, not yours.`,
    lateItems: args.bookTitle ? [`${args.bookTitle}, your club book for this box`] : [],
    expectedLine: `We now expect it to ship by ${formatClubDate(args.expectedDate)}, and we will email you the moment it is on its way.`,
  };
}

export function buildDelayEmailText(model: DelayEmailModel): string {
  const lines: string[] = [model.heading, ""];
  lines.push(model.intro);
  if (model.lateItems.length) {
    lines.push("");
    for (const t of model.lateItems) lines.push(`- ${t}`);
  }
  lines.push("");
  lines.push(model.expectedLine);
  lines.push("");
  lines.push(model.promoLine);
  lines.push("");
  lines.push(`${model.trackLabel}: ${model.trackUrl}`);
  lines.push("");
  lines.push("Happy reading,");
  lines.push("Big Brain Shelf");
  return lines.join("\n");
}

// Load everything the HTML render needs for one outbox row. The new
// expected date is recomputed from the row's created_at, matching
// the date the enqueue stated (see the header note).
export async function loadDelayEmailModel(
  db: DBLike,
  site: string,
  row: { kind: string; order_id?: string | null; club_box_id?: string | null; created_at?: number | null }
): Promise<DelayEmailModel | null> {
  if (!isDelayEmailKind(row.kind)) return null;
  const expectedDate = addDaysToDateString(
    dateStringFromUnixSeconds(Number(row.created_at || nowSeconds())),
    DELAY_NEW_EXPECTED_DAYS
  );
  if (row.kind === ORDER_DELAYED_KIND) {
    if (!row.order_id) return null;
    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(row.order_id).first();
    if (!order) return null;
    const books = await loadBooksForOrder(db, order);
    return buildOrderDelayModel({
      site,
      order,
      books,
      shipByDate: orderShipByDateString(order),
      expectedDate,
    });
  }
  if (!row.club_box_id) return null;
  const box = await db
    .prepare(
      `SELECT b.*, bk.title AS book_title
       FROM club_cycle_boxes b
       LEFT JOIN books bk ON bk.slug = b.resolved_book_slug
       WHERE b.id = ?`
    )
    .bind(row.club_box_id)
    .first();
  if (!box) return null;
  return buildClubBoxDelayModel({
    site,
    bookTitle: box.book_title || null,
    shipByDate: clubBoxShipByDateString(box),
    expectedDate,
  });
}

export async function enqueueOrderDelayEmail(
  db: DBLike,
  site: string,
  order: any,
  nowSec: number = nowSeconds()
): Promise<void> {
  if (!order?.id || !order?.email) return;
  const books = await loadBooksForOrder(db, order);
  const model = buildOrderDelayModel({
    site,
    order,
    books,
    shipByDate: orderShipByDateString(order),
    expectedDate: addDaysToDateString(dateStringFromUnixSeconds(nowSec), DELAY_NEW_EXPECTED_DAYS),
  });
  await enqueueEmail(db, {
    orderId: String(order.id),
    kind: ORDER_DELAYED_KIND,
    to: String(order.email),
    subject: model.subject,
    text: buildDelayEmailText(model),
  });
}

export async function enqueueClubBoxDelayEmail(
  db: DBLike,
  site: string,
  box: any,
  nowSec: number = nowSeconds()
): Promise<boolean> {
  if (!box?.id) return false;
  const member = await db
    .prepare("SELECT * FROM club_signups WHERE id = ?")
    .bind(box.signup_id)
    .first();
  if (!member?.email) return false;
  let bookTitle: string | null = null;
  if (box.resolved_book_slug) {
    const book = await db
      .prepare("SELECT title FROM books WHERE slug = ?")
      .bind(box.resolved_book_slug)
      .first();
    bookTitle = book?.title ? String(book.title) : null;
  }
  const model = buildClubBoxDelayModel({
    site,
    bookTitle,
    shipByDate: clubBoxShipByDateString(box),
    expectedDate: addDaysToDateString(dateStringFromUnixSeconds(nowSec), DELAY_NEW_EXPECTED_DAYS),
  });
  await enqueueEmail(db, {
    orderId: null,
    kind: CLUB_BOX_DELAYED_KIND,
    to: String(member.email),
    subject: model.subject,
    text: buildDelayEmailText(model),
    dedupeKey: `club_box:${String(box.id)}:${CLUB_BOX_DELAYED_KIND}`,
    clubBoxId: String(box.id),
  });
  return true;
}

export interface DelayEmailSummary {
  ordersQueued: number;
  boxesQueued: number;
}

// One scheduler pass (called from runScheduledWork on the cron
// tick): every paid printed order and settled club box whose
// promised ship-by date has passed, and which has not shipped,
// gets its one delay email. Bounded like the other passes; the
// dedupe guards make repeat ticks converge.
export async function runDelayEmailScheduler(
  db: DBLike,
  site: string,
  now: Date = new Date()
): Promise<DelayEmailSummary> {
  const summary: DelayEmailSummary = { ordersQueued: 0, boxesQueued: 0 };
  const nowSec = Math.floor(now.getTime() / 1000);
  const today = dateStringFromUnixSeconds(nowSec);

  // Orders: created at least the processing window ago (a cheap
  // prefilter), then the exact calendar check on the ship-by date.
  const orderRows = await db
    .prepare(
      `SELECT * FROM orders
       WHERE status = 'complete' AND physical_status IN (${PRE_SHIP_STATUSES.map(() => "?").join(", ")})
         AND created_at <= ?
       ORDER BY created_at ASC LIMIT 100`
    )
    .bind(...PRE_SHIP_STATUSES, nowSec - CLUB_PROCESSING_DAYS * 86400)
    .all()
    .catch(() => ({ results: [] as any[] }));
  for (const order of (orderRows.results || []) as any[]) {
    if (!(orderShipByDateString(order) < today)) continue;
    const existing = await db
      .prepare("SELECT id FROM email_outbox WHERE order_id = ? AND kind = ?")
      .bind(String(order.id), ORDER_DELAYED_KIND)
      .first()
      .catch(() => null);
    if (existing) continue;
    await enqueueOrderDelayEmail(db, site, order, nowSec);
    summary.ordersQueued++;
  }

  // Boxes: ship-by (ship_date + processing) before today, in a
  // state where the contents are settled and shipping is on us.
  const boxRows = await db
    .prepare(
      `SELECT * FROM club_cycle_boxes
       WHERE status IN (${DELAYABLE_BOX_STATUSES.map(() => "?").join(", ")})
         AND ship_date < ?
       ORDER BY ship_date ASC LIMIT 100`
    )
    .bind(...DELAYABLE_BOX_STATUSES, addDaysToDateString(today, -CLUB_PROCESSING_DAYS))
    .all()
    .catch(() => ({ results: [] as any[] }));
  for (const box of (boxRows.results || []) as any[]) {
    if (!(clubBoxShipByDateString(box) < today)) continue;
    const dedupeKey = `club_box:${String(box.id)}:${CLUB_BOX_DELAYED_KIND}`;
    const existing = await db
      .prepare("SELECT id FROM email_outbox WHERE dedupe_key = ?")
      .bind(dedupeKey)
      .first()
      .catch(() => null);
    if (existing) continue;
    if (await enqueueClubBoxDelayEmail(db, site, box, nowSec)) summary.boxesQueued++;
  }
  return summary;
}
