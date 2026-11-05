// Book Club cycles, book choice, surprise resolution, and scheduled
// cycle work (Book Club V2).
//
// Cycles are PURCHASE-ANCHORED: a paid physical member gets one
// club_cycle_boxes row per due date in their own schedule, which runs
// from the day they joined (first box due at join) and then every 3
// months. The member may pick a title, or leave the default
// "Mystery" (stored as selection_source 'surprise'). At the selection lock date the scheduler resolves a
// surprise to a book the member does not already own in any format and
// has not already been sent (or firmly committed) in another club box.
// If no such book exists the box is marked needs_attention rather than
// silently duplicating a title: the member can then explicitly choose
// a repeat or gift copy, and an admin can resolve it too.
//
// All cycle dates are calendar dates in America/Chicago. Reminders
// land 14 and 3 calendar days before a box's due date; selections lock
// 2 calendar days before it, so the last-call reminder always leaves a
// full day to act. A box created on its due date (the normal first
// box) locks 2 days after creation instead.

import { ensureOutboxColumns, parsePackState, type DBLike } from "./orders";
import { ensureOnce } from "./schema-cache";
import { chicagoDateString } from "./offers";
import { ensureClubTable, clubPlanOf } from "./club";
import {
  addDaysToDateString,
  addMonthsToDateString,
  boxCreatedDateString,
  clubAnchorDateString,
  clubCycleTiming,
  formatClubDate,
  isMemberCycleDate,
  memberCycleDateIndex,
  memberCycleWindowDates,
  CLUB_CYCLE_HORIZON,
  CLUB_CYCLE_MONTHS,
  CLUB_LOCK_DAYS_BEFORE,
} from "./club-cycle-dates";
export {
  addDaysToDateString,
  addMonthsToDateString,
  clubAnchorDateString,
  clubCycleTiming,
  formatClubDate,
  isMemberCycleDate,
  memberCycleWindowDates,
} from "./club-cycle-dates";
import {
  enqueueClubCycleEmail,
  CLUB_CYCLE_REMINDER_14_KIND,
  CLUB_CYCLE_REMINDER_3_KIND,
} from "./club-emails";

export const CLUB_SCHEDULER_BATCH = 100;

export const CLUB_BOX_STATUSES = [
  "awaiting_selection",
  "locked",
  "preparing",
  "shipped",
  "delivered",
  "needs_attention",
  "skipped",
  "canceled",
] as const;

const COMMITTED_BOX_STATUSES = ["awaiting_selection", "locked", "preparing", "shipped", "delivered"];
const INACTIVE_SUBSCRIPTION_STATUSES = ["canceled", "unpaid", "incomplete_expired"];
const PAUSED_SUBSCRIPTION_STATUSES = ["past_due", "paused"];

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Fulfillment columns a club box carries for the unified Orders view
// (admin redesign S4, 2026-11-03); see ensureClubCycleTables.
export const CLUB_BOX_FULFILLMENT_COLUMNS: Record<string, string> = {
  pack_json: "TEXT",
  carrier_service: "TEXT",
  label_cost_cents: "INTEGER",
  shippo_shipment_id: "TEXT",
  shippo_transaction_id: "TEXT",
  pickup_confirmation: "TEXT",
  pickup_window: "TEXT",
  pickup_scheduled_at: "INTEGER",
};

export async function ensureClubCycleTables(db: DBLike): Promise<void> {
  await ensureClubTable(db);
  return ensureOnce(db, "club_cycle_boxes", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS club_cycle_boxes (
           id TEXT PRIMARY KEY,
           signup_id TEXT NOT NULL,
           ship_date TEXT NOT NULL,
           selected_book_slug TEXT,
           resolved_book_slug TEXT,
           second_selected_book_slug TEXT,
           second_resolved_book_slug TEXT,
           selection_source TEXT NOT NULL DEFAULT 'surprise',
           allow_repeat INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL DEFAULT 'awaiting_selection',
           carrier TEXT,
           tracking_number TEXT,
           label_url TEXT,
           locked_at INTEGER,
           shipped_at INTEGER,
           delivered_at INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           UNIQUE (signup_id, ship_date)
         )`
      )
      .bind()
      .run();
    // Option A boxes (2026-10-29) carry a SECOND book slot: the club
    // book ships as a gift set, and a second printed storybook from the
    // back catalog rides in the same box. Additive columns, added the
    // same PRAGMA-guarded way club_signups grows its columns.
    const { results: boxCols } = await db.prepare("PRAGMA table_info(club_cycle_boxes)").bind().all();
    const haveBoxCols = new Set(((boxCols || []) as any[]).map((r) => String(r.name)));
    for (const col of ["second_selected_book_slug", "second_resolved_book_slug"]) {
      if (!haveBoxCols.has(col)) {
        await db.prepare(`ALTER TABLE club_cycle_boxes ADD COLUMN ${col} TEXT`).bind().run();
      }
    }
    // Unified fulfillment (admin redesign S4, 2026-11-03): a club box
    // is fulfilled in the same view as a store order, so the box row
    // carries the same fulfillment facts an order does: the pack
    // checklist ticks (pack_json, same shape as orders), the label's
    // service + cost + Shippo ids, and the pickup confirmation.
    for (const [col, type] of Object.entries(CLUB_BOX_FULFILLMENT_COLUMNS)) {
      if (!haveBoxCols.has(col)) {
        await db.prepare(`ALTER TABLE club_cycle_boxes ADD COLUMN ${col} ${type}`).bind().run();
      }
    }
    const indexes: [string, string][] = [
      ["club_cycle_boxes_signup_ship_idx", "CREATE INDEX IF NOT EXISTS club_cycle_boxes_signup_ship_idx ON club_cycle_boxes(signup_id, ship_date)"],
      ["club_cycle_boxes_ship_status_idx", "CREATE INDEX IF NOT EXISTS club_cycle_boxes_ship_status_idx ON club_cycle_boxes(ship_date, status)"],
      ["club_cycle_boxes_status_ship_idx", "CREATE INDEX IF NOT EXISTS club_cycle_boxes_status_ship_idx ON club_cycle_boxes(status, ship_date)"],
      ["club_signups_status_idx", "CREATE INDEX IF NOT EXISTS club_signups_status_idx ON club_signups(status, created_at)"],
      ["orders_user_status_idx", "CREATE INDEX IF NOT EXISTS orders_user_status_idx ON orders(user_id, status)"],
      ["orders_email_status_idx", "CREATE INDEX IF NOT EXISTS orders_email_status_idx ON orders(email, status)"],
    ];
    for (const [, sql] of indexes) {
      try {
        await db.prepare(sql).bind().run();
      } catch {
        // An index is a performance guard, never a reason to fail a page.
      }
    }
  });
}

export function clubMemberCycleEligible(member: any): boolean {
  if (!member || member.status !== "paid") return false;
  // Cycle boxes are a PHYSICAL club benefit. Audio Club members never
  // enter the box pipeline, whatever their billing state.
  if (clubPlanOf(member) !== "physical") return false;
  const sub = String(member.subscription_status || "");
  // A comp (granted free year) mints boxes only inside its window.
  if (sub === "comp") return Number(member.comp_until || 0) > nowSeconds();
  return !INACTIVE_SUBSCRIPTION_STATUSES.includes(sub) && !PAUSED_SUBSCRIPTION_STATUSES.includes(sub);
}

export function clubMemberCanSelect(member: any): boolean {
  if (!member || member.status !== "paid") return false;
  if (clubPlanOf(member) !== "physical") return false;
  const sub = String(member.subscription_status || "");
  if (sub === "comp") return Number(member.comp_until || 0) > nowSeconds();
  return !INACTIVE_SUBSCRIPTION_STATUSES.includes(sub);
}

// Finished catalog books that can fill a box: the printed storybook and
// the printed coloring book both exist. complete and ready_for_qa are
// the factory's finished states; drafts, builds, and failures are out.
export async function listEligibleClubBooks(db: DBLike): Promise<any[]> {
  const { results } = await db
    .prepare(
      `SELECT slug, title, topic, cover_key, status FROM books
       WHERE picture_book_key IS NOT NULL AND coloring_book_key IS NOT NULL
         AND status IN ('complete', 'ready_for_qa')
       ORDER BY title ASC`
    )
    .bind()
    .all();
  return (results || []) as any[];
}

export async function getEligibleClubBook(db: DBLike, slug: string): Promise<any | null> {
  const books = await listEligibleClubBooks(db);
  return books.find((b) => b.slug === slug) || null;
}

function slugsFromBookSlugsJson(raw: any): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Every book this member already has, in any format, from completed
// orders (digital, printed, gift set, and the $0 club digital grants
// are all completed orders). Keyed by account user id, falling back to
// the member email for rows written before accounts were tied.
export async function getOwnedBookSlugs(db: DBLike, member: any): Promise<Set<string>> {
  const owned = new Set<string>();
  const userId = member?.user_id ? String(member.user_id) : "";
  const email = String(member?.email || "").trim().toLowerCase();
  const { results } = await db
    .prepare(
      "SELECT book_slugs FROM orders WHERE status = 'complete' AND (user_id = ? OR email = ?) ORDER BY created_at ASC"
    )
    .bind(userId, email)
    .all();
  for (const row of (results || []) as any[]) {
    for (const slug of slugsFromBookSlugsJson(row.book_slugs)) owned.add(slug);
  }
  return owned;
}

// Physical ownership (CG, 2026-11-05): for box resolution, a book
// counts as owned only when the member physically has it, meaning a
// completed order that included it in a printed or gift set format.
// A digital or audio copy does NOT take the book out of the box
// pool: "if a customer doesn't physically own a book, it's
// available to be sent to them."
export async function getPhysicallyOwnedBookSlugs(db: DBLike, member: any): Promise<Set<string>> {
  const owned = new Set<string>();
  const userId = member?.user_id ? String(member.user_id) : "";
  const email = String(member?.email || "").trim().toLowerCase();
  const { results } = await db
    .prepare(
      "SELECT items FROM orders WHERE status = 'complete' AND (user_id = ? OR email = ?) ORDER BY created_at ASC"
    )
    .bind(userId, email)
    .all();
  for (const row of (results || []) as any[]) {
    let items: any[] = [];
    try {
      const parsed = JSON.parse(row.items || "[]");
      if (Array.isArray(parsed)) items = parsed;
    } catch { /* unparseable items carry no physical books */ }
    for (const it of items) {
      if (it && (it.format === "printed" || it.format === "giftset") && it.slug) {
        owned.add(String(it.slug));
      }
    }
  }
  return owned;
}

// Books already committed to this member by another club box: a title
// picked for a future box, locked, being prepared, shipped, or
// delivered must never be surprise-picked (or silently re-picked) for
// a different cycle. Both slots commit their title.
export async function getPriorClubBookSlugs(
  db: DBLike,
  signupId: string,
  excludeBoxId?: string
): Promise<Set<string>> {
  const slugs = new Set<string>();
  const { results } = await db
    .prepare(
      `SELECT id, resolved_book_slug, second_resolved_book_slug FROM club_cycle_boxes
       WHERE signup_id = ? AND (resolved_book_slug IS NOT NULL OR second_resolved_book_slug IS NOT NULL)
         AND status IN (${COMMITTED_BOX_STATUSES.map(() => "?").join(",")})`
    )
    .bind(signupId, ...COMMITTED_BOX_STATUSES)
    .all();
  for (const row of (results || []) as any[]) {
    // The caller may be validating the box that already holds the slug.
    if (excludeBoxId && row.id === excludeBoxId) continue;
    if (row.resolved_book_slug) slugs.add(String(row.resolved_book_slug));
    if (row.second_resolved_book_slug) slugs.add(String(row.second_resolved_book_slug));
  }
  return slugs;
}

export function chooseSurpriseBook(
  eligible: any[],
  excluded: Set<string>,
  rng: () => number = Math.random
): any | null {
  const candidates = eligible.filter((b) => !excluded.has(String(b.slug)));
  if (!candidates.length) return null;
  const idx = Math.min(candidates.length - 1, Math.max(0, Math.floor(rng() * candidates.length)));
  return candidates[idx];
}

export async function getClubBox(db: DBLike, boxId: string): Promise<any | null> {
  return db.prepare("SELECT * FROM club_cycle_boxes WHERE id = ?").bind(boxId).first();
}

export async function getClubBoxForCycle(db: DBLike, signupId: string, shipDate: string): Promise<any | null> {
  return db
    .prepare("SELECT * FROM club_cycle_boxes WHERE signup_id = ? AND ship_date = ?")
    .bind(signupId, shipDate)
    .first();
}

// Idempotent: the UNIQUE(signup_id, ship_date) constraint makes repeat
// generation converge on one row per member per cycle.
export async function generateUpcomingCyclesForMember(
  db: DBLike,
  member: any,
  nowDate: string = chicagoDateString(),
  horizon = CLUB_CYCLE_HORIZON
): Promise<any[]> {
  await ensureClubCycleTables(db);
  if (!clubMemberCycleEligible(member)) return [];
  const anchor = clubAnchorDateString(member);
  const dates = memberCycleWindowDates(anchor, nowDate, horizon);
  const ts = nowSeconds();
  for (const shipDate of dates) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO club_cycle_boxes
           (id, signup_id, ship_date, selected_book_slug, resolved_book_slug, selection_source, allow_repeat, status, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, 'surprise', 0, 'awaiting_selection', ?, ?)`
      )
      .bind(crypto.randomUUID(), member.id, shipDate, ts, ts)
      .run();
  }
  const { results } = await db
    .prepare(
      `SELECT * FROM club_cycle_boxes WHERE signup_id = ? AND ship_date IN (${dates.map(() => "?").join(",")}) ORDER BY ship_date ASC`
    )
    .bind(member.id, ...dates)
    .all();
  return (results || []) as any[];
}

// The member's next box that still needs a decision or fulfilment:
// anything not shipped off, skipped, or canceled, earliest first. A
// locked/preparing box whose ship date has passed still surfaces here
// until it ships.
export async function getNextClubBox(db: DBLike, signupId: string): Promise<any | null> {
  await ensureClubCycleTables(db);
  return db
    .prepare(
      `SELECT * FROM club_cycle_boxes
       WHERE signup_id = ? AND status IN ('awaiting_selection', 'needs_attention', 'locked', 'preparing')
       ORDER BY ship_date ASC LIMIT 1`
    )
    .bind(signupId)
    .first();
}

export async function getClubSelectionOptions(
  db: DBLike,
  member: any,
  box: any
): Promise<{ books: any[]; owned: Set<string>; committed: Set<string> }> {
  const books = await listEligibleClubBooks(db);
  const owned = await getOwnedBookSlugs(db, member);
  const committed = box
    ? await getPriorClubBookSlugs(db, String(member.id), String(box.id))
    : await getPriorClubBookSlugs(db, String(member.id));
  return { books, owned, committed };
}

async function saveClubSelectionPrimary(
  db: DBLike,
  args: {
    member: any;
    shipDate: string;
    bookSlug?: string | null;
    allowRepeat?: boolean;
    nowDate?: string;
  }
): Promise<{ ok: boolean; error?: string; box?: any }> {
  await ensureClubCycleTables(db);
  const member = args.member;
  if (!clubMemberCanSelect(member)) {
    return { ok: false, error: "Your Book Club membership is not active right now." };
  }
  const anchor = clubAnchorDateString(member);
  const targetIndex = memberCycleDateIndex(anchor, args.shipDate);
  if (targetIndex < 0) {
    return { ok: false, error: "That is not one of your Book Club box dates." };
  }
  let box = await getClubBoxForCycle(db, String(member.id), args.shipDate);
  if (!box) {
    // Generate far enough ahead to cover the requested due date: its
    // position past the current window start, capped so a stray date
    // cannot mint years of boxes.
    const nowDate0 = args.nowDate || chicagoDateString();
    const windowStart = memberCycleWindowDates(anchor, nowDate0, 1)[0];
    const startIndex = memberCycleDateIndex(anchor, windowStart);
    const horizon = Math.min(12, Math.max(4, targetIndex - startIndex + 1));
    const generated = await generateUpcomingCyclesForMember(db, member, nowDate0, horizon);
    box = generated.find((b: any) => b.ship_date === args.shipDate) || null;
    if (!box) return { ok: false, error: "That cycle is not open for selections." };
  }
  if (["preparing", "shipped", "delivered", "skipped", "canceled"].includes(String(box.status))) {
    return { ok: false, error: "This box can no longer be changed." };
  }
  const nowDate = args.nowDate || chicagoDateString();
  const timing = clubCycleTiming(String(box.ship_date), boxCreatedDateString(box.created_at));
  const pastLock = nowDate >= timing.lockDate;

  // Mystery: clear any pick. After the lock, a box that could not
  // be resolved stays in needs_attention so the state stays honest.
  if (!args.bookSlug) {
    if (box.status === "locked") return { ok: false, error: "Selections are locked for this box." };
    if (pastLock && box.status === "awaiting_selection") {
      return { ok: false, error: "Selections have locked for this box." };
    }
    await db
      .prepare(
        `UPDATE club_cycle_boxes SET selected_book_slug = NULL, resolved_book_slug = NULL,
           selection_source = 'surprise', allow_repeat = 0,
           status = ?, updated_at = ? WHERE id = ?`
      )
      .bind(box.status === "needs_attention" ? "needs_attention" : "awaiting_selection", nowSeconds(), box.id)
      .run();
    return { ok: true, box: await getClubBox(db, box.id) };
  }

  const book = await getEligibleClubBook(db, args.bookSlug);
  if (!book) return { ok: false, error: "That book is not available for a club box." };
  if (box.status === "locked") return { ok: false, error: "Selections are locked for this box." };
  if (pastLock && box.status === "awaiting_selection") {
    return { ok: false, error: "Selections have locked for this box." };
  }
  const owned = await getOwnedBookSlugs(db, member);
  const committed = await getPriorClubBookSlugs(db, String(member.id), String(box.id));
  const isRepeat = owned.has(book.slug) || committed.has(book.slug);
  if (isRepeat && !args.allowRepeat) {
    return {
      ok: false,
      error: "You already have that book. Tick the repeat or gift option if you want another copy on purpose.",
    };
  }
  // A needs_attention box locks on a member pick only when the second
  // slot is already spoken for (picked or resolved); with slot 2 still
  // open the box honestly stays in needs_attention.
  const locksNow =
    box.status === "needs_attention" &&
    !!(box.second_resolved_book_slug || box.second_selected_book_slug);
  await db
    .prepare(
      `UPDATE club_cycle_boxes SET selected_book_slug = ?, resolved_book_slug = ?,
         selection_source = 'member', allow_repeat = ?, status = ?, locked_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(
      book.slug,
      book.slug,
      isRepeat ? 1 : 0,
      locksNow ? "locked" : box.status === "needs_attention" ? "needs_attention" : "awaiting_selection",
      locksNow ? nowSeconds() : box.locked_at,
      nowSeconds(),
      box.id
    )
    .run();
  return { ok: true, box: await getClubBox(db, box.id) };
}

// Save the member's SECOND-slot pick (the back catalog storybook) for
// a box. Mirrors the club book rules: eligible titles only, owned /
// committed / already-in-this-box titles need the explicit repeat
// flag, and the same lock timing applies. When the box sits in
// needs_attention because this slot could not surprise-fill, a pick
// here completes the box (the club book is already resolved) and it
// locks; a pick while the club book is still open leaves the box
// awaiting its lock as usual.
export async function saveClubSecondSelection(
  db: DBLike,
  args: {
    member: any;
    shipDate: string;
    bookSlug?: string | null;
    allowRepeat?: boolean;
    nowDate?: string;
  }
): Promise<{ ok: boolean; error?: string; box?: any }> {
  await ensureClubCycleTables(db);
  const member = args.member;
  if (!clubMemberCanSelect(member)) {
    return { ok: false, error: "Your Book Club membership is not active right now." };
  }
  const anchor = clubAnchorDateString(member);
  if (memberCycleDateIndex(anchor, args.shipDate) < 0) {
    return { ok: false, error: "That is not one of your Book Club box dates." };
  }
  const box = await getClubBoxForCycle(db, String(member.id), args.shipDate);
  if (!box) return { ok: false, error: "That cycle is not open for selections." };
  if (["preparing", "shipped", "delivered", "skipped", "canceled"].includes(String(box.status))) {
    return { ok: false, error: "This box can no longer be changed." };
  }
  if (box.status === "locked") return { ok: false, error: "Selections are locked for this box." };
  const nowDate = args.nowDate || chicagoDateString();
  const timing = clubCycleTiming(String(box.ship_date), boxCreatedDateString(box.created_at));
  const pastLock = nowDate >= timing.lockDate;
  if (pastLock && box.status === "awaiting_selection") {
    return { ok: false, error: "Selections have locked for this box." };
  }

  // Mystery for slot 2: clear the pick; resolution happens at the
  // lock (or stays open in needs_attention).
  if (!args.bookSlug) {
    await db
      .prepare(
        `UPDATE club_cycle_boxes SET second_selected_book_slug = NULL, second_resolved_book_slug = NULL,
           updated_at = ? WHERE id = ?`
      )
      .bind(nowSeconds(), box.id)
      .run();
    return { ok: true, box: await getClubBox(db, box.id) };
  }

  const book = await getEligibleClubBook(db, args.bookSlug);
  if (!book) return { ok: false, error: "That book is not available for a club box." };
  const owned = await getOwnedBookSlugs(db, member);
  const committed = await getPriorClubBookSlugs(db, String(member.id), String(box.id));
  const inThisBox =
    book.slug === box.selected_book_slug || book.slug === box.resolved_book_slug;
  const isRepeat = owned.has(book.slug) || committed.has(book.slug) || inThisBox;
  if (isRepeat && !args.allowRepeat) {
    return {
      ok: false,
      error: inThisBox
        ? "That book is already the club book in this box. Pick a different second book, or tick the repeat or gift option."
        : "You already have that book. Tick the repeat or gift option if you want another copy on purpose.",
    };
  }
  const completesBox =
    box.status === "needs_attention" && !!(box.resolved_book_slug || box.selected_book_slug);
  await db
    .prepare(
      `UPDATE club_cycle_boxes SET second_selected_book_slug = ?, second_resolved_book_slug = ?,
         status = ?, locked_at = ?, updated_at = ? WHERE id = ?`
    )
    .bind(
      book.slug,
      book.slug,
      completesBox ? "locked" : String(box.status),
      completesBox ? nowSeconds() : box.locked_at,
      nowSeconds(),
      box.id
    )
    .run();
  return { ok: true, box: await getClubBox(db, box.id) };
}

// Save a member's picks for one box. bookSlug is the club book (slot
// 1, the long-standing behavior); secondBookSlug, when present (null
// counts: it means Mystery for slot 2), saves the back catalog pick
// in the same call. When secondBookSlug is absent entirely, slot 2 is
// left exactly as it was.
export async function saveClubSelection(
  db: DBLike,
  args: {
    member: any;
    shipDate: string;
    bookSlug?: string | null;
    secondBookSlug?: string | null;
    allowRepeat?: boolean;
    nowDate?: string;
  }
): Promise<{ ok: boolean; error?: string; box?: any }> {
  const primary = await saveClubSelectionPrimary(db, args);
  if (!primary.ok || args.secondBookSlug === undefined) return primary;
  return saveClubSecondSelection(db, {
    member: args.member,
    shipDate: args.shipDate,
    bookSlug: args.secondBookSlug,
    allowRepeat: args.allowRepeat,
    nowDate: args.nowDate,
  });
}

// Resolve one awaiting box at its lock (Option A: TWO title slots).
// Slot 1 is the club book (ships as the gift set); slot 2 is the
// second printed storybook from the back catalog. An explicit pick
// locks in; a surprise resolves to a title the member does not
// PHYSICALLY own (CG, 2026-11-05: a digital or audio copy leaves the
// book available to send) and has not already been sent, with slot 2
// additionally excluding whatever slot 1 took, so a box never
// carries the same book twice. The box locks only when BOTH slots are
// filled; if either slot has nothing new to take, the box goes to
// needs_attention (keeping whichever slot did resolve) rather than
// silently duplicating a title: the member can then explicitly choose
// a repeat or gift copy for the open slot, and an admin can too.
export async function resolveClubBoxAtLock(
  db: DBLike,
  box: any,
  member: any,
  rng: () => number = Math.random
): Promise<any> {
  if (!box || box.status !== "awaiting_selection") return box;
  if (!clubMemberCycleEligible(member)) return box;
  const ts = nowSeconds();
  const eligible = await listEligibleClubBooks(db);
  const excluded = new Set<string>([
    ...(await getPhysicallyOwnedBookSlugs(db, member)),
    ...(await getPriorClubBookSlugs(db, String(member.id), String(box.id))),
  ]);
  const surprise = (): string | null => {
    const pick = chooseSurpriseBook(eligible, excluded, rng);
    return pick ? String(pick.slug) : null;
  };
  const first = box.selected_book_slug ? String(box.selected_book_slug) : surprise();
  if (first) excluded.add(first);
  const second = box.second_selected_book_slug ? String(box.second_selected_book_slug) : surprise();
  const complete = !!first && !!second;
  await db
    .prepare(
      `UPDATE club_cycle_boxes SET resolved_book_slug = ?, second_resolved_book_slug = ?,
         status = ?, locked_at = ?, updated_at = ?
       WHERE id = ? AND status = 'awaiting_selection'`
    )
    .bind(first, second, complete ? "locked" : "needs_attention", complete ? ts : box.locked_at, ts, box.id)
    .run();
  return getClubBox(db, box.id);
}

// Admin-side surprise resolution (CG, 2026-11-05): a Mystery box
// never sits in the admin waiting for a human to pick its books.
// The box page calls this when it loads a box that still has an
// unresolved surprise slot, and the slot is filled on the spot with
// the lock-time rules (physical ownership + prior box commitments
// excluded). An awaiting box goes through the full lock resolution;
// a needs_attention box gets only its still-open slots filled
// (member picks are never touched), and locks when both slots end
// up filled. Returns the freshest box row either way.
export async function resolveClubBoxForAdmin(
  db: DBLike,
  box: any,
  member: any,
  rng: () => number = Math.random
): Promise<any> {
  if (!box) return box;
  if (box.status === "awaiting_selection") {
    return resolveClubBoxAtLock(db, box, member, rng);
  }
  if (box.status !== "needs_attention") return box;
  const slot1Open = !box.selected_book_slug && !box.resolved_book_slug;
  const slot2Open = !box.second_selected_book_slug && !box.second_resolved_book_slug;
  if (!slot1Open && !slot2Open) return box;
  const eligible = await listEligibleClubBooks(db);
  const excluded = new Set<string>([
    ...(await getPhysicallyOwnedBookSlugs(db, member)),
    ...(await getPriorClubBookSlugs(db, String(box.signup_id), String(box.id))),
  ]);
  let first = box.resolved_book_slug ? String(box.resolved_book_slug) : null;
  let second = box.second_resolved_book_slug ? String(box.second_resolved_book_slug) : null;
  if (slot1Open) {
    const pick = chooseSurpriseBook(eligible, excluded, rng);
    if (pick) first = String(pick.slug);
  }
  const slot1Final = box.selected_book_slug ? String(box.selected_book_slug) : first;
  if (slot1Final) excluded.add(slot1Final);
  if (slot2Open) {
    const pick = chooseSurpriseBook(eligible, excluded, rng);
    if (pick) second = String(pick.slug);
  }
  if (first === (box.resolved_book_slug || null) && second === (box.second_resolved_book_slug || null)) {
    return box;
  }
  const complete = !!slot1Final && !!(box.second_selected_book_slug || second);
  const ts = nowSeconds();
  await db
    .prepare(
      `UPDATE club_cycle_boxes SET resolved_book_slug = ?, second_resolved_book_slug = ?,
         status = ?, locked_at = ?, updated_at = ?
       WHERE id = ? AND status = 'needs_attention'`
    )
    .bind(first, second, complete ? "locked" : "needs_attention", complete ? ts : box.locked_at, ts, box.id)
    .run();
  return getClubBox(db, box.id);
}

const BOX_TRANSITIONS: Record<string, string[]> = {
  awaiting_selection: ["locked", "needs_attention", "skipped", "canceled"],
  needs_attention: ["locked", "preparing", "skipped", "canceled"],
  locked: ["preparing", "shipped", "needs_attention", "skipped", "canceled"],
  preparing: ["shipped", "delivered", "needs_attention", "canceled"],
  shipped: ["delivered"],
  delivered: [],
  skipped: [],
  canceled: [],
};

// Pack checklist keys per title slot (lib/packing.ts line keys). When
// a slot's book changes or is cleared, that slot's ticks described the
// OLD book going into the box, so they are dropped and the operator
// re-ticks what is actually packed; the other slot keeps its ticks.
const SLOT_PACK_KEYS: Record<number, string[]> = {
  1: ["slot1:story", "slot1:coloring"],
  2: ["slot2:story"],
};

async function clearClubBoxSlotPackTicks(db: DBLike, box: any, slot: number): Promise<void> {
  const keys = SLOT_PACK_KEYS[slot] || [];
  if (!keys.length) return;
  const state = parsePackState(box?.pack_json);
  let changed = false;
  for (const k of keys) {
    if (state[k]) {
      delete state[k];
      changed = true;
    }
  }
  if (!changed) return;
  await db
    .prepare("UPDATE club_cycle_boxes SET pack_json = ? WHERE id = ?")
    .bind(JSON.stringify(state), box.id)
    .run();
}

const FINAL_BOX_STATUSES = ["shipped", "delivered", "skipped", "canceled"];

export async function updateClubBoxByAdmin(
  db: DBLike,
  args: {
    boxId: string;
    bookSlug?: string | null;
    // Which title slot a bookSlug resolves: 1 the club book (default),
    // 2 the back catalog second book. Resolving slot 2 locks the box
    // only when the club book is already in place.
    slot?: number;
    // Empty the given slot instead of filling it (admin redesign fix,
    // 2026-11-03): a pick can be changed or cleared until the box is
    // packed and gone; before this flag a saved pick was permanent.
    clear?: boolean;
    status?: string | null;
    carrier?: string | null;
    trackingNumber?: string | null;
    labelUrl?: string | null;
  }
): Promise<{ ok: boolean; error?: string; box?: any }> {
  await ensureClubCycleTables(db);
  const box = await getClubBox(db, args.boxId);
  if (!box) return { ok: false, error: "box not found" };
  const ts = nowSeconds();

  if (args.clear) {
    if (FINAL_BOX_STATUSES.includes(String(box.status))) {
      return { ok: false, error: `a ${box.status} box's picks are final` };
    }
    const slot = args.slot === 2 ? 2 : 1;
    if (slot === 2) {
      await db
        .prepare(
          `UPDATE club_cycle_boxes SET second_selected_book_slug = NULL, second_resolved_book_slug = NULL, updated_at = ? WHERE id = ?`
        )
        .bind(ts, box.id)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE club_cycle_boxes SET selected_book_slug = NULL, resolved_book_slug = NULL, updated_at = ? WHERE id = ?`
        )
        .bind(ts, box.id)
        .run();
    }
    await clearClubBoxSlotPackTicks(db, box, slot);
    // Status honesty after a clear: an emptied club-book slot means
    // the box needs a pick again; an emptied second slot drops a
    // box that was being packed back to locked (its club book is
    // still in place, so it is contents work, not a fresh box).
    let next = await getClubBox(db, box.id);
    if (slot === 1 && ["locked", "preparing"].includes(String(next.status))) {
      await db
        .prepare("UPDATE club_cycle_boxes SET status = 'needs_attention', updated_at = ? WHERE id = ?")
        .bind(ts, box.id)
        .run();
      next = await getClubBox(db, box.id);
    } else if (slot === 2 && String(next.status) === "preparing") {
      await db
        .prepare("UPDATE club_cycle_boxes SET status = 'locked', updated_at = ? WHERE id = ?")
        .bind(ts, box.id)
        .run();
      next = await getClubBox(db, box.id);
    }
    return { ok: true, box: next };
  }

  if (args.bookSlug) {
    const book = await getEligibleClubBook(db, args.bookSlug);
    if (!book) return { ok: false, error: "That book is not eligible for a club box." };
    if (FINAL_BOX_STATUSES.includes(String(box.status))) {
      return { ok: false, error: `a ${box.status} box cannot be re-resolved` };
    }
    const slot = args.slot === 2 ? 2 : 1;
    // A box never carries the same book twice: the lock resolver has
    // always excluded the other slot's book, and the admin path now
    // refuses the duplicate too instead of only hiding it in the
    // picker (CG's report, 2026-11-03).
    const otherSlug =
      slot === 2
        ? String(box.resolved_book_slug || box.selected_book_slug || "")
        : String(box.second_resolved_book_slug || box.second_selected_book_slug || "");
    if (otherSlug && otherSlug === String(book.slug)) {
      return {
        ok: false,
        error: "That book is already the other pick in this box. Pick a different book for this slot.",
      };
    }
    const currentSlug =
      slot === 2
        ? String(box.second_resolved_book_slug || box.second_selected_book_slug || "")
        : String(box.resolved_book_slug || box.selected_book_slug || "");
    if (args.slot === 2) {
      const clubBookInPlace = !!(box.resolved_book_slug || box.selected_book_slug);
      await db
        .prepare(
          `UPDATE club_cycle_boxes SET second_selected_book_slug = ?, second_resolved_book_slug = ?,
             status = ?, locked_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(
          book.slug,
          book.slug,
          clubBookInPlace ? "locked" : String(box.status),
          clubBookInPlace ? box.locked_at || ts : box.locked_at,
          ts,
          box.id
        )
        .run();
      if (currentSlug && currentSlug !== String(book.slug)) {
        await clearClubBoxSlotPackTicks(db, box, 2);
      }
      return { ok: true, box: await getClubBox(db, box.id) };
    }
    await db
      .prepare(
        `UPDATE club_cycle_boxes SET selected_book_slug = ?, resolved_book_slug = ?,
           selection_source = 'admin', status = 'locked', locked_at = COALESCE(locked_at, ?), updated_at = ?
         WHERE id = ?`
      )
      .bind(book.slug, book.slug, ts, ts, box.id)
      .run();
    if (currentSlug && currentSlug !== String(book.slug)) {
      await clearClubBoxSlotPackTicks(db, box, 1);
    }
    return { ok: true, box: await getClubBox(db, box.id) };
  }

  if (args.status) {
    const next = String(args.status);
    if (!CLUB_BOX_STATUSES.includes(next as any)) return { ok: false, error: `unknown box status: ${next}` };
    if (next === String(box.status)) return { ok: true, box };
    const allowed = BOX_TRANSITIONS[String(box.status)] || [];
    if (!allowed.includes(next)) {
      return { ok: false, error: `cannot move a box from ${box.status} to ${next}` };
    }
    if (next === "locked" && !box.resolved_book_slug && !box.selected_book_slug) {
      return { ok: false, error: "resolve a book before locking this box" };
    }
    await db
      .prepare(
        `UPDATE club_cycle_boxes SET status = ?,
           resolved_book_slug = COALESCE(resolved_book_slug, selected_book_slug),
           locked_at = CASE WHEN ? = 'locked' THEN COALESCE(locked_at, ?) ELSE locked_at END,
           carrier = COALESCE(?, carrier),
           tracking_number = COALESCE(?, tracking_number),
           label_url = COALESCE(?, label_url),
           shipped_at = CASE WHEN ? = 'shipped' THEN COALESCE(shipped_at, ?) ELSE shipped_at END,
           delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
           updated_at = ? WHERE id = ?`
      )
      .bind(
        next,
        next, ts,
        args.carrier ?? null,
        args.trackingNumber ?? null,
        args.labelUrl ?? null,
        next, ts,
        next, ts,
        ts,
        box.id
      )
      .run();
    return { ok: true, box: await getClubBox(db, box.id) };
  }

  // Tracking-only update (for example, adding a tracking number to a
  // box that is already preparing).
  if (args.carrier || args.trackingNumber || args.labelUrl) {
    await db
      .prepare(
        `UPDATE club_cycle_boxes SET carrier = COALESCE(?, carrier), tracking_number = COALESCE(?, tracking_number),
           label_url = COALESCE(?, label_url), updated_at = ? WHERE id = ?`
      )
      .bind(args.carrier ?? null, args.trackingNumber ?? null, args.labelUrl ?? null, ts, box.id)
      .run();
    return { ok: true, box: await getClubBox(db, box.id) };
  }
  return { ok: false, error: "nothing to update" };
}

// Persist the pack checklist ticks for a box (admin redesign S4).
// Same shape and rules as orders: a flat key -> true object; the line
// keys come from lib/packing.ts.
export async function setClubBoxPack(
  db: DBLike,
  boxId: string,
  pack: Record<string, boolean>
): Promise<void> {
  await ensureClubCycleTables(db);
  await db
    .prepare("UPDATE club_cycle_boxes SET pack_json = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(pack), Date.now(), boxId)
    .run();
}

export interface ClubSchedulerSummary {
  generatedMembers: number;
  skippedBoxes: number;
  reminders14: number;
  reminders3: number;
  lockedBoxes: number;
  attentionBoxes: number;
  lockedEmails: number;
  attentionEmails: number;
}

// One bounded scheduler pass over club cycles. Every query is limited;
// anything not reached this pass is reached by the next one (the cron
// runs every 15 minutes), which is what keeps the design safe at
// thousands of members.
export async function runClubCycleScheduler(
  db: DBLike,
  args: { site: string; now?: Date; batch?: number; rng?: () => number }
): Promise<ClubSchedulerSummary> {
  await ensureClubCycleTables(db);
  // The locked / attention probes below read email_outbox.dedupe_key;
  // make sure the V2 outbox columns exist even on a pass where nothing
  // has been enqueued yet.
  await ensureOutboxColumns(db);
  const batch = args.batch ?? CLUB_SCHEDULER_BATCH;
  const today = chicagoDateString(args.now || new Date());
  const rng = args.rng ?? Math.random;
  const summary: ClubSchedulerSummary = {
    generatedMembers: 0,
    skippedBoxes: 0,
    reminders14: 0,
    reminders3: 0,
    lockedBoxes: 0,
    attentionBoxes: 0,
    lockedEmails: 0,
    attentionEmails: 0,
  };

  // 0. Boxes belonging to members who are no longer members at all are
  // skipped. A past-due member keeps their box open (payment can
  // recover before the lock); a canceled one does not ship.
  const orphanRows = await db
    .prepare(
      `SELECT b.id FROM club_cycle_boxes b JOIN club_signups s ON s.id = b.signup_id
       WHERE b.status IN ('awaiting_selection', 'needs_attention')
         AND (s.status != 'paid' OR s.subscription_status IN ('canceled', 'unpaid', 'incomplete_expired'))
       ORDER BY b.ship_date ASC LIMIT ?`
    )
    .bind(batch)
    .all();
  for (const row of (orphanRows.results || []) as any[]) {
    await db
      .prepare("UPDATE club_cycle_boxes SET status = 'skipped', updated_at = ? WHERE id = ? AND status IN ('awaiting_selection', 'needs_attention')")
      .bind(nowSeconds(), row.id)
      .run();
    summary.skippedBoxes += 1;
  }

  // 1. Generate upcoming cycles for paid members whose own anchored
  // window is not fully minted yet. Each member's window is the due
  // date currently in force plus the next one, both inside
  // (today - 3 months, today + 3 months]; a member with fewer than
  // CLUB_CYCLE_HORIZON boxes in that span may be missing one, and the
  // per-member check in generateUpcomingCyclesForMember (INSERT OR
  // IGNORE) keeps the pass idempotent.
  const windowLow = addMonthsToDateString(today, -CLUB_CYCLE_MONTHS);
  const windowHigh = addMonthsToDateString(today, CLUB_CYCLE_MONTHS);
  const memberRows = await db
    .prepare(
      `SELECT s.* FROM club_signups s
       WHERE s.status = 'paid'
         AND (s.club_plan IS NULL OR s.club_plan = 'physical')
         AND (s.subscription_status IS NULL OR s.subscription_status NOT IN ('canceled', 'unpaid', 'incomplete_expired', 'past_due', 'paused'))
         AND (SELECT COUNT(*) FROM club_cycle_boxes bx
              WHERE bx.signup_id = s.id AND bx.ship_date > ? AND bx.ship_date <= ?) < ?
       ORDER BY s.created_at ASC LIMIT ?`
    )
    .bind(windowLow, windowHigh, CLUB_CYCLE_HORIZON, batch)
    .all();
  for (const member of (memberRows.results || []) as any[]) {
    await generateUpcomingCyclesForMember(db, member, today);
    summary.generatedMembers += 1;
  }

  // 2. Selection reminders for boxes still on Mystery. The 14-day
  // email runs inside its window (14 to 4 days out); the 3-day last
  // call runs from 3 days out until the lock date. Dedupe is by the
  // outbox dedupe key, so repeat passes send nothing twice.
  const reminderRows = await db
    .prepare(
      `SELECT b.*, s.email AS member_email, s.status AS member_status, s.subscription_status AS member_subscription_status
       FROM club_cycle_boxes b JOIN club_signups s ON s.id = b.signup_id
       WHERE b.status = 'awaiting_selection' AND b.selected_book_slug IS NULL AND s.status = 'paid'
         AND (s.subscription_status IS NULL OR s.subscription_status NOT IN ('canceled', 'unpaid', 'incomplete_expired', 'past_due', 'paused'))
         AND b.ship_date >= ?
       ORDER BY b.ship_date ASC LIMIT ?`
    )
    .bind(today, batch)
    .all();
  for (const box of (reminderRows.results || []) as any[]) {
    // Reminders are for boxes still ahead of their due date. A box due
    // today (a first box, created at join) is already in the
    // lock/fulfilment flow; the member picks from their account page.
    if (String(box.ship_date) <= today) continue;
    const timing = clubCycleTiming(String(box.ship_date), boxCreatedDateString(box.created_at));
    let kind: string | null = null;
    if (today >= timing.reminder3Date && today < timing.lockDate) kind = CLUB_CYCLE_REMINDER_3_KIND;
    else if (today >= timing.reminder14Date && today < timing.reminder3Date) kind = CLUB_CYCLE_REMINDER_14_KIND;
    if (!kind) continue;
    const sent = await enqueueClubCycleEmail(db, args.site, box, kind);
    if (sent) {
      if (kind === CLUB_CYCLE_REMINDER_14_KIND) summary.reminders14 += 1;
      else summary.reminders3 += 1;
    }
  }

  // 3. Lock date reached: resolve awaiting boxes (explicit picks lock;
  // surprises resolve or go to needs_attention).
  const lockRows = await db
    .prepare(
      `SELECT b.* FROM club_cycle_boxes b
       WHERE b.status = 'awaiting_selection' AND b.ship_date <= ?
       ORDER BY b.ship_date ASC LIMIT ?`
    )
    .bind(addDaysToDateString(today, CLUB_LOCK_DAYS_BEFORE), batch)
    .all();
  // The ship_date <= today + LOCK_DAYS_BEFORE filter is the date-only
  // form of "today >= lockDate" for boxes created well ahead of their
  // due date. A box created on (or just before) its due date locks a
  // few days later instead, so the effective lock date is checked per
  // box before resolving.
  for (const box of (lockRows.results || []) as any[]) {
    const effective = clubCycleTiming(String(box.ship_date), boxCreatedDateString(box.created_at));
    if (today < effective.lockDate) continue;
    const member = await db.prepare("SELECT * FROM club_signups WHERE id = ?").bind(box.signup_id).first();
    if (!member) continue;
    if (!clubMemberCycleEligible(member)) continue; // canceled rows were skipped in step 0; past-due waits
    const before = String(box.status);
    const after = await resolveClubBoxAtLock(db, box, member, rng);
    if (after && before === "awaiting_selection" && after.status === "locked") summary.lockedBoxes += 1;
    if (after && before === "awaiting_selection" && after.status === "needs_attention") summary.attentionBoxes += 1;
  }

  // 4. Locked and needs_attention boxes get their one email each. The
  // NOT EXISTS probe keeps this bounded to boxes still missing mail.
  const lockedRows = await db
    .prepare(
      `SELECT b.* FROM club_cycle_boxes b
       WHERE b.status = 'locked'
         AND NOT EXISTS (SELECT 1 FROM email_outbox o WHERE o.dedupe_key = 'club_box:' || b.id || ':club_cycle_locked')
       ORDER BY b.ship_date ASC LIMIT ?`
    )
    .bind(batch)
    .all();
  for (const box of (lockedRows.results || []) as any[]) {
    if (await enqueueClubCycleEmail(db, args.site, box, "club_cycle_locked")) summary.lockedEmails += 1;
  }
  const attentionRows = await db
    .prepare(
      `SELECT b.* FROM club_cycle_boxes b
       WHERE b.status = 'needs_attention'
         AND NOT EXISTS (SELECT 1 FROM email_outbox o WHERE o.dedupe_key = 'club_box:' || b.id || ':club_cycle_attention')
       ORDER BY b.ship_date ASC LIMIT ?`
    )
    .bind(batch)
    .all();
  for (const box of (attentionRows.results || []) as any[]) {
    if (await enqueueClubCycleEmail(db, args.site, box, "club_cycle_attention")) summary.attentionEmails += 1;
  }

  return summary;
}
