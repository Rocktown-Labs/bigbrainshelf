// Book Club V2 tests: PURCHASE-ANCHORED cycle generation, book
// choice, surprise exclusion, scheduler reminders/locks, opt-out
// suppression, billing-health gating, and the shipped-only library
// grant. A member's first box is due on their join date (the anchor,
// stamped into first_ship_date at activation) and the next boxes fall
// every 3 months from it. Runs the real src/lib code against an
// in-memory bun:sqlite database. Run with: bun tests/club-cycles.test.ts
import { Database } from "bun:sqlite";
import {
  ensureClubCycleTables,
  generateUpcomingCyclesForMember,
  getClubBoxForCycle,
  listEligibleClubBooks,
  saveClubSelection,
  saveClubSecondSelection,
  updateClubBoxByAdmin,
  runClubCycleScheduler,
  addMonthsToDateString,
  clubAnchorDateString,
  clubCycleTiming,
  isMemberCycleDate,
  memberCycleWindowDates,
} from "../src/lib/club-cycles";
import { runScheduledWork } from "../src/lib/club-scheduler";
import { flushOutbox } from "../src/lib/email";
import {
  getOrCreateUnsubscribeToken,
  recordOptOutByToken,
} from "../src/lib/marketing";
import {
  updateClubSubscriptionStatus,
  recordClubInvoicePayment,
  clubSubscriptionIdFromInvoice,
} from "../src/lib/club";
import { getDigitalEntitlements } from "../src/lib/library";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, topic TEXT, cover_key TEXT, status TEXT, picture_book_key TEXT, coloring_book_key TEXT, epub_key TEXT, color_book_key TEXT, audiobook_key TEXT);
CREATE TABLE club_signups (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, shelf TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL, book_slugs TEXT NOT NULL, stripe_session_id TEXT, amount INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'usd', status TEXT NOT NULL DEFAULT 'complete', created_at INTEGER NOT NULL, items TEXT DEFAULT '', delivery_token TEXT);
CREATE TABLE email_outbox (id TEXT PRIMARY KEY, order_id TEXT, kind TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, send_after INTEGER, from_email TEXT);
CREATE UNIQUE INDEX email_outbox_order_kind_idx ON email_outbox(order_id, kind) WHERE order_id IS NOT NULL;
INSERT INTO books (slug, title, status, picture_book_key, coloring_book_key) VALUES
  ('alpha', 'Alpha', 'complete', 'a/pic.pdf', 'a/col.pdf'),
  ('beta', 'Beta', 'ready_for_qa', 'b/pic.pdf', 'b/col.pdf'),
  ('gamma', 'Gamma', 'complete', 'g/pic.pdf', 'g/col.pdf'),
  ('harbor', 'Harbor', 'complete', 'h/pic.pdf', 'h/col.pdf'),
  ('island', 'Island', 'ready_for_qa', 'i/pic.pdf', 'i/col.pdf'),
  ('delta', 'Delta', 'building', 'd/pic.pdf', 'd/col.pdf'),
  ('epsilon', 'Epsilon', 'complete', 'e/pic.pdf', NULL);
`);

const db = {
  prepare(sql: string) {
    return {
      bind(...args: any[]) {
        const stmt = raw.query(sql);
        return {
          async run() { const r = stmt.run(...args) as any; return { meta: { changes: r?.changes ?? 0 } }; },
          async first() { return stmt.get(...args) ?? null; },
          async all() { return { results: stmt.all(...args) }; },
        };
      },
    };
  },
} as any;

const SITE = "https://bigbrainshelf.com";
const count = (sql: string, ...args: any[]) => (raw.query(sql).get(...args) as any).n as number;
const outboxCount = (email: string, kind: string) =>
  count("SELECT COUNT(*) n FROM email_outbox WHERE to_email = ? AND kind = ?", email, kind);
const outboxCountForBox = (boxId: string, kind: string) =>
  count("SELECT COUNT(*) n FROM email_outbox WHERE club_box_id = ? AND kind = ?", boxId, kind);
const unix = (dateStr: string) => Math.floor(Date.parse(`${dateStr}T12:00:00Z`) / 1000);

let seq = 0;
// A paid physical member whose cycle anchors on `anchor` (their join
// date), exactly as activation stamps it: first_ship_date = join date.
function insertMember(email: string, opts: { userId?: string; subId?: string; anchor?: string; subStatus?: string } = {}): any {
  seq += 1;
  const id = `member-${seq}`;
  const anchor = opts.anchor || "2026-10-28";
  raw.query(
    "INSERT INTO club_signups (id, name, email, shelf, status, created_at, user_id, stripe_subscription_id, first_ship_date, paid_at, subscription_status) VALUES (?, ?, ?, 'tech', 'paid', ?, ?, ?, ?, ?, ?)"
  ).run(id, `Member ${seq}`, email, unix(anchor), opts.userId || `user-${seq}`, opts.subId || null, anchor, unix(anchor), opts.subStatus || "active");
  return raw.query("SELECT * FROM club_signups WHERE id = ?").get(id);
}
function insertOrder(userId: string, email: string, slugs: string[]) {
  seq += 1;
  raw.query(
    "INSERT INTO orders (id, user_id, email, book_slugs, stripe_session_id, amount, status, created_at, items) VALUES (?, ?, ?, ?, ?, 100, 'complete', ?, '[]')"
  ).run(`order-${seq}`, userId, email, JSON.stringify(slugs), `cs_${seq}`, 1700000000 + seq);
}
// Boxes are minted by the live scheduler on real dates; scenarios run
// on fake dates, so a scenario's boxes get their created_at pinned to
// the scenario date the box was "created" on. The lock floor (a box
// created on its due date locks 2 days later) reads created_at.
function pinBoxCreation(signupId: string, dateStr: string) {
  raw.query("UPDATE club_cycle_boxes SET created_at = ? WHERE signup_id = ?").run(unix(dateStr), signupId);
}
const at = (dateStr: string) => new Date(`${dateStr}T12:00:00Z`);

// --- Anchored cycle calendar
assert(addMonthsToDateString("2026-10-28", 3) === "2027-01-28", "anchor + 3 months is the next due date");
assert(addMonthsToDateString("2026-01-31", 3) === "2026-04-30", "month addition clamps to the target month's last day");
assert(addMonthsToDateString("2026-10-31", 3) === "2027-01-31", "a 31st anchor stays on the 31st when the month has one");
assert(clubAnchorDateString({ first_ship_date: "2026-10-28", paid_at: 1, created_at: 1 }) === "2026-10-28", "the anchor is the stamped first box date (the join date)");
assert(memberCycleWindowDates("2026-10-28", "2026-10-28").join(",") === "2026-10-28,2027-01-28", "at join, the window is the join date and join + 3 months");
assert(memberCycleWindowDates("2026-10-28", "2027-02-01").join(",") === "2027-01-28,2027-04-28", "the window rolls with the member's own cycle");
assert(memberCycleWindowDates("2027-02-15", "2027-02-14").join(",") === "2027-02-15,2027-05-15", "a future anchor starts at the join date itself");
assert(isMemberCycleDate("2026-10-28", "2027-04-28") && !isMemberCycleDate("2026-10-28", "2027-04-29") && !isMemberCycleDate("2026-10-28", "2026-10-27"), "member cycle date validation");
const timing = clubCycleTiming("2027-01-28");
assert(timing.reminder14Date === "2027-01-14" && timing.reminder3Date === "2027-01-25" && timing.lockDate === "2027-01-28", "reminders sit 14 and 3 days before the due date and selections lock on the due date itself");
const firstBoxTiming = clubCycleTiming("2026-10-28", "2026-10-28");
assert(firstBoxTiming.lockDate === "2026-11-03", "a box created on its due date locks 6 days after creation, leaving 5 full days to change picks");

await ensureClubCycleTables(db);

// --- Eligible catalog: finished books with both printed files only
const eligible = await listEligibleClubBooks(db);
assert(eligible.map((b: any) => b.slug).join(",") === "alpha,beta,gamma,harbor,island", "eligible books exclude unfinished and file-less titles");

// --- Idempotent generation: first box due at join, second at join+3mo
const m1 = insertMember("m1@example.com");
const gen1 = await generateUpcomingCyclesForMember(db, m1, "2026-10-28");
await generateUpcomingCyclesForMember(db, m1, "2026-10-28");
assert(gen1.length === 2, "two horizon cycles generated");
assert(gen1[0].ship_date === "2026-10-28", "the first box is due on the join date");
assert(gen1[1].ship_date === "2027-01-28", "the second box is due join + 3 months");
assert(count("SELECT COUNT(*) n FROM club_cycle_boxes WHERE signup_id = ?", m1.id) === 2, "repeat generation creates no duplicates");

// --- Selection save: ineligible and invalid input refused
const badBook = await saveClubSelection(db, { member: m1, shipDate: "2026-10-28", bookSlug: "delta", nowDate: "2026-10-28" });
assert(!badBook.ok, "an unfinished book cannot be picked");
const badDate = await saveClubSelection(db, { member: m1, shipDate: "2026-10-29", bookSlug: "alpha", nowDate: "2026-10-28" });
assert(!badDate.ok, "a date that is not one of the member's cycle dates cannot be picked for");
const globalDate = await saveClubSelection(db, { member: m1, shipDate: "2027-01-01", bookSlug: "alpha", nowDate: "2026-10-28" });
assert(!globalDate.ok, "the old global quarter date (Jan 1) is not a cycle date for an Oct 28 member");

// --- Selection save: owned titles need the explicit repeat flag
const m2 = insertMember("m2@example.com");
insertOrder(m2.user_id, m2.email, ["alpha"]);
await generateUpcomingCyclesForMember(db, m2, "2026-10-28");
pinBoxCreation(m2.id, "2026-10-28");
const ownedPick = await saveClubSelection(db, { member: m2, shipDate: "2026-10-28", bookSlug: "alpha", nowDate: "2026-10-28" });
assert(!ownedPick.ok, "owned book refused without the repeat flag");
const repeatPick = await saveClubSelection(db, { member: m2, shipDate: "2026-10-28", bookSlug: "alpha", allowRepeat: true, nowDate: "2026-10-28" });
assert(repeatPick.ok && repeatPick.box.allow_repeat === 1, "owned book allowed as an explicit repeat or gift copy");
const backToSurprise = await saveClubSelection(db, { member: m2, shipDate: "2026-10-28", bookSlug: null, nowDate: "2026-10-28" });
assert(backToSurprise.ok && !backToSurprise.box.selected_book_slug && backToSurprise.box.selection_source === "surprise", "surprise clears a pick");
const betaPick = await saveClubSelection(db, { member: m2, shipDate: "2026-10-28", bookSlug: "beta", nowDate: "2026-10-28" });
assert(betaPick.ok && betaPick.box.resolved_book_slug === "beta", "an unowned pick saves");

// --- Scheduler: reminder windows, dedupe, lock, locked email
// m3's first box gets an explicit pick so its lock is deterministic;
// the reminder/lock story runs on m3's second box (due 2027-01-28).
const m3 = insertMember("m3@example.com");
await generateUpcomingCyclesForMember(db, m3, "2026-10-28");
pinBoxCreation(m3.id, "2026-10-28");
const m3FirstPick = await saveClubSelection(db, { member: m3, shipDate: "2026-10-28", bookSlug: "gamma", secondBookSlug: "beta", nowDate: "2026-10-28" });
assert(m3FirstPick.ok && m3FirstPick.box.second_resolved_book_slug === "beta", "m3 picks both books for the first box in one save");
const m3Box2 = await getClubBoxForCycle(db, m3.id, "2027-01-28");
await runClubCycleScheduler(db, { site: SITE, now: at("2027-01-13") });
assert(outboxCountForBox(m3Box2.id, "club_cycle_reminder_14") === 0, "no reminder before the 14-day window");
const m3Box1 = await getClubBoxForCycle(db, m3.id, "2026-10-28");
assert(m3Box1.status === "locked" && m3Box1.resolved_book_slug === "gamma", "the first box (due at join) locks with the member's pick");
await runClubCycleScheduler(db, { site: SITE, now: at("2027-01-14") });
assert(outboxCountForBox(m3Box2.id, "club_cycle_reminder_14") === 1, "14-day reminder enqueued in its window");
await runClubCycleScheduler(db, { site: SITE, now: at("2027-01-14") });
assert(outboxCountForBox(m3Box2.id, "club_cycle_reminder_14") === 1, "repeat scheduler passes never re-send the 14-day reminder");
await runClubCycleScheduler(db, { site: SITE, now: at("2027-01-25") });
assert(outboxCountForBox(m3Box2.id, "club_cycle_reminder_3") === 1, "3-day last-call reminder enqueued");
await runClubCycleScheduler(db, { site: SITE, now: at("2027-01-28"), rng: () => 0 });
const m3Box2After = await getClubBoxForCycle(db, m3.id, "2027-01-28");
assert(m3Box2After.status === "locked" && m3Box2After.resolved_book_slug === "alpha", "surprise locks to the first unowned, uncommitted title (rng 0)");
assert(m3Box2After.second_resolved_book_slug === "harbor" && m3Box2After.second_resolved_book_slug !== m3Box2After.resolved_book_slug, "slot 2 surprise-fills with a different unowned title");
assert(outboxCountForBox(m3Box2.id, "club_cycle_locked") === 1, "locked email enqueued once");
await runClubCycleScheduler(db, { site: SITE, now: at("2027-01-28"), rng: () => 0 });
assert(outboxCountForBox(m3Box2.id, "club_cycle_locked") === 1, "locked email never duplicates");
const lockedSave = await saveClubSelection(db, { member: m3, shipDate: "2027-01-28", bookSlug: "beta", nowDate: "2027-01-28" });
assert(!lockedSave.ok, "a locked box refuses selection changes");
const m2Box = await getClubBoxForCycle(db, m2.id, "2026-10-28");
assert(m2Box.status === "locked" && m2Box.resolved_book_slug === "beta" && outboxCountForBox(m2Box.id, "club_cycle_reminder_14") === 0, "an explicit pick locks in and is never reminded");

// --- Surprise exclusion: owned plus prior club boxes
const m4 = insertMember("m4@example.com", { anchor: "2026-07-28" });
insertOrder(m4.user_id, m4.email, ["alpha"]);
raw.query(
  `INSERT INTO club_cycle_boxes (id, signup_id, ship_date, selected_book_slug, resolved_book_slug, selection_source, allow_repeat, status, created_at, updated_at)
   VALUES ('m4-prior', ?, '2026-07-28', NULL, 'beta', 'surprise', 0, 'shipped', 1, 1)`
).run(m4.id);
await generateUpcomingCyclesForMember(db, m4, "2026-10-28");
pinBoxCreation(m4.id, "2026-10-28");
await runClubCycleScheduler(db, { site: SITE, now: at("2026-11-03"), rng: () => 0 });
const m4Box = await getClubBoxForCycle(db, m4.id, "2026-10-28");
assert(m4Box.status === "locked" && m4Box.resolved_book_slug === "gamma", "surprise skips owned books and prior club books");
assert(m4Box.second_resolved_book_slug === "harbor", "slot 2 surprise excludes owned, prior boxes, and slot 1's pick");

// --- No unowned book: needs_attention, email, explicit repeat resolves
const m5 = insertMember("m5@example.com");
insertOrder(m5.user_id, m5.email, ["alpha", "beta", "gamma", "harbor", "island"]);
await generateUpcomingCyclesForMember(db, m5, "2026-10-28");
pinBoxCreation(m5.id, "2026-10-28");
await runClubCycleScheduler(db, { site: SITE, now: at("2026-11-03"), rng: () => 0 });
const m5Box = await getClubBoxForCycle(db, m5.id, "2026-10-28");
assert(m5Box.status === "needs_attention" && !m5Box.resolved_book_slug && !m5Box.second_resolved_book_slug, "no silent duplicate: with nothing new for either slot, the box goes to needs_attention");
assert(outboxCountForBox(m5Box.id, "club_cycle_attention") === 1, "action-needed email enqueued once");
const noRepeat = await saveClubSelection(db, { member: m5, shipDate: "2026-10-28", bookSlug: "gamma", nowDate: "2026-11-03" });
assert(!noRepeat.ok, "needs_attention still refuses a silent repeat");
const giftPick = await saveClubSelection(db, { member: m5, shipDate: "2026-10-28", bookSlug: "gamma", allowRepeat: true, nowDate: "2026-11-03" });
assert(giftPick.ok && giftPick.box.resolved_book_slug === "gamma" && giftPick.box.status === "needs_attention", "a gift pick fills slot 1, but the box waits while slot 2 is still open");
const secondNoFlag = await saveClubSecondSelection(db, { member: m5, shipDate: "2026-10-28", bookSlug: "beta", nowDate: "2026-11-03" });
assert(!secondNoFlag.ok, "slot 2 also refuses a silent repeat");
const secondPick = await saveClubSecondSelection(db, { member: m5, shipDate: "2026-10-28", bookSlug: "beta", allowRepeat: true, nowDate: "2026-11-03" });
assert(secondPick.ok && secondPick.box.status === "locked" && secondPick.box.second_resolved_book_slug === "beta", "an explicit second-slot pick completes and locks the box");

// --- Two slots: no duplicate inside one box
const mDual = insertMember("dual@example.com");
await generateUpcomingCyclesForMember(db, mDual, "2026-10-28");
pinBoxCreation(mDual.id, "2026-10-28");
const mDualFirst = await saveClubSelection(db, { member: mDual, shipDate: "2026-10-28", bookSlug: "alpha", nowDate: "2026-10-28" });
assert(mDualFirst.ok, "mDual picks the club book");
const dupeAttempt = await saveClubSecondSelection(db, { member: mDual, shipDate: "2026-10-28", bookSlug: "alpha", nowDate: "2026-10-28" });
assert(!dupeAttempt.ok, "slot 2 refuses the same book as slot 1 without the repeat flag");
const mDualSecond = await saveClubSecondSelection(db, { member: mDual, shipDate: "2026-10-28", bookSlug: "beta", nowDate: "2026-10-28" });
assert(mDualSecond.ok && mDualSecond.box.second_resolved_book_slug === "beta", "mDual picks a different second book");
await runClubCycleScheduler(db, { site: SITE, now: at("2026-11-03"), rng: () => 0 });
const mDualBox = await getClubBoxForCycle(db, mDual.id, "2026-10-28");
assert(mDualBox.status === "locked" && mDualBox.resolved_book_slug === "alpha" && mDualBox.second_resolved_book_slug === "beta", "the lock keeps both distinct picks");

// --- Grants wait for shipped/delivered (rolling boxes)
// A past-due member has no membership layer, so the only possible
// grant for a book is the box itself: locked grants nothing, shipped
// grants the digital edition.
const mG = insertMember("grant@example.com", { subStatus: "past_due" });
const gGen = await generateUpcomingCyclesForMember(db, { ...mG, subscription_status: "active" }, "2026-10-28");
pinBoxCreation(mG.id, "2026-10-28");
const gBox = gGen[0];
await saveClubSelection(db, { member: { ...mG, subscription_status: "active" }, shipDate: "2026-10-28", bookSlug: "alpha", nowDate: "2026-10-28" });
await runClubCycleScheduler(db, { site: SITE, now: at("2026-11-03"), rng: () => 0 });
const gBoxLocked = await getClubBoxForCycle(db, mG.id, "2026-10-28");
assert(gBoxLocked.status === "awaiting_selection", "a past-due member's box waits at the lock instead of resolving");
const gMemberRow = raw.query("SELECT * FROM club_signups WHERE id = ?").get(mG.id);
const gResolved = await updateClubBoxByAdmin(db, { boxId: gBox.id, bookSlug: "alpha" });
assert(gResolved.ok && gResolved.box.status === "locked", "admin resolves the waiting box to a book");
const gSecond = await updateClubBoxByAdmin(db, { boxId: gBox.id, bookSlug: "beta", slot: 2 });
assert(gSecond.ok && gSecond.box.second_resolved_book_slug === "beta" && gSecond.box.status === "locked", "admin resolves the second slot too");
const entBeforeShip = await getDigitalEntitlements(db, { id: mG.user_id, email: mG.email });
assert(!entBeforeShip.has("alpha") && !entBeforeShip.has("beta"), "a locked (not yet shipped) box grants nothing, either slot");
const gShipped = await updateClubBoxByAdmin(db, { boxId: gBox.id, status: "shipped" });
assert(gShipped.ok && gShipped.box.status === "shipped", "admin marks the box shipped");
const entAfterShip = await getDigitalEntitlements(db, { id: mG.user_id, email: mG.email });
assert(entAfterShip.get("alpha")?.sources.includes("club") && entAfterShip.get("alpha")?.digital === true, "the shipped box grants the digital edition");
assert(entAfterShip.get("beta")?.sources.includes("club") && entAfterShip.get("beta")?.digital === true, "the shipped box also grants the second book's digital edition");

// --- Opt-out: suppressed at enqueue
const m6 = insertMember("m6@example.com");
await generateUpcomingCyclesForMember(db, m6, "2026-10-28");
pinBoxCreation(m6.id, "2026-10-28");
const m6Token = await getOrCreateUnsubscribeToken(db, m6.email);
await recordOptOutByToken(db, m6Token);
await runClubCycleScheduler(db, { site: SITE, now: at("2027-01-14") });
assert(outboxCount(m6.email, "club_cycle_reminder_14") === 0, "opted-out member gets no reminder at enqueue");

// --- Admin resolve and transitions
const m6BoxBefore = await getClubBoxForCycle(db, m6.id, "2026-10-28");
const adminResolve = await updateClubBoxByAdmin(db, { boxId: m6BoxBefore.id, bookSlug: "beta" });
assert(adminResolve.ok && adminResolve.box.status === "locked" && adminResolve.box.selection_source === "admin", "admin can resolve a box to a book");
const badTransition = await updateClubBoxByAdmin(db, { boxId: m3Box2After.id, status: "awaiting_selection" });
assert(!badTransition.ok, "admin cannot rewind a locked box to awaiting_selection");
const prepTransition = await updateClubBoxByAdmin(db, { boxId: m6BoxBefore.id, status: "preparing" });
assert(prepTransition.ok && prepTransition.box.status === "preparing", "admin can move a locked box to preparing");

// --- Opt-out: suppressed at send time too
const m7 = insertMember("m7@example.com");
await generateUpcomingCyclesForMember(db, m7, "2026-10-28");
pinBoxCreation(m7.id, "2026-10-28");
const m7Box2 = await getClubBoxForCycle(db, m7.id, "2027-01-28");
await runClubCycleScheduler(db, { site: SITE, now: at("2027-01-14") });
assert(outboxCountForBox(m7Box2.id, "club_cycle_reminder_14") === 1, "second member reminder enqueued before opt-out");
const m7Token = await getOrCreateUnsubscribeToken(db, m7.email);
await recordOptOutByToken(db, m7Token);
// A transport must exist for the flush to walk rows at all (without
// one it skips the whole pass by design); this one always fails, so
// non-suppressed rows simply stay pending.
const deadTransport = { EMAIL: { send: async () => { throw new Error("test transport down"); } } };
await flushOutbox(db, deadTransport, 100, SITE);
const m7Row = raw.query("SELECT status FROM email_outbox WHERE to_email = ? AND kind = 'club_cycle_reminder_14'").get(m7.email) as any;
assert(m7Row.status === "suppressed", "a reminder enqueued before opt-out is suppressed at send");

// --- Billing health: past_due pauses, paid restores, unpaid cancels
const m8 = insertMember("m8@example.com", { subId: "sub_m8" });
const m8Fresh = raw.query("SELECT * FROM club_signups WHERE id = ?").get(m8.id);
await generateUpcomingCyclesForMember(db, m8Fresh, "2026-10-28");
pinBoxCreation(m8.id, "2026-10-28");
assert(clubSubscriptionIdFromInvoice({ parent: { subscription_details: { subscription: "sub_x" } } }) === "sub_x", "invoice subscription id resolves from the parent shape");
await recordClubInvoicePayment(db, { subscription: "sub_m8" }, "failed");
const m8Due = raw.query("SELECT * FROM club_signups WHERE id = ?").get(m8.id) as any;
assert(m8Due.subscription_status === "past_due" && m8Due.payment_failed_at > 0, "invoice failure marks the member past_due");
assert((await generateUpcomingCyclesForMember(db, m8Due, "2026-10-28")).length === 0, "past_due members get no new cycles");
await runClubCycleScheduler(db, { site: SITE, now: at("2027-01-14") });
assert(outboxCount(m8.email, "club_cycle_reminder_14") === 0, "past_due members get no reminders");
const m8BoxWhileDue = await getClubBoxForCycle(db, m8.id, "2026-10-28");
assert(m8BoxWhileDue.status === "awaiting_selection", "past_due boxes wait rather than being skipped");
await recordClubInvoicePayment(db, { subscription: "sub_m8" }, "paid");
const m8Paid = raw.query("SELECT * FROM club_signups WHERE id = ?").get(m8.id) as any;
assert(m8Paid.subscription_status === "active", "a paid invoice restores active billing");
await updateClubSubscriptionStatus(db, { id: "sub_m8", status: "unpaid" });
const m8Canceled = raw.query("SELECT * FROM club_signups WHERE id = ?").get(m8.id) as any;
assert(m8Canceled.status === "canceled", "an unpaid subscription cancels the membership");
await runClubCycleScheduler(db, { site: SITE, now: at("2027-01-14") });
const m8BoxAfterCancel = await getClubBoxForCycle(db, m8.id, "2026-10-28");
assert(m8BoxAfterCancel.status === "skipped", "a canceled member's open boxes are skipped");

// --- Scheduler generation: due boxes for active members only
// A member joining mid-quarter (Feb 15, no global cycle) gets their
// first box created by the scheduler when their join date arrives.
const m10 = insertMember("m10@example.com", { anchor: "2027-02-15" });
const m11 = insertMember("m11@example.com", { anchor: "2027-02-15" });
raw.query("UPDATE club_signups SET status = 'canceled', subscription_status = 'canceled' WHERE id = ?").run(m11.id);
const m12 = insertMember("m12@example.com", { anchor: "2027-02-15", subStatus: "past_due" });
await runClubCycleScheduler(db, { site: SITE, now: at("2027-02-15") });
const m10Box1 = await getClubBoxForCycle(db, m10.id, "2027-02-15");
const m10Box2 = await getClubBoxForCycle(db, m10.id, "2027-05-15");
assert(!!m10Box1 && !!m10Box2, "scheduler creates the active member's first box at join and the next at join + 3 months");
assert(count("SELECT COUNT(*) n FROM club_cycle_boxes WHERE signup_id = ?", m11.id) === 0, "scheduler creates no boxes for a canceled member");
assert(count("SELECT COUNT(*) n FROM club_cycle_boxes WHERE signup_id = ?", m12.id) === 0, "scheduler creates no boxes for a past-due (lapsed) member");

// --- Scheduled work entry: flush + cycles in one pass
const m9 = insertMember("m9@example.com");
const summary = await runScheduledWork(db, deadTransport, { now: at("2027-01-14"), site: SITE });
assert(typeof summary.flushedBefore.attempted === "number" && typeof summary.flushedAfter.attempted === "number", "scheduled work reports its outbox flushes");
const m9Box2 = await getClubBoxForCycle(db, m9.id, "2027-01-28");
assert(!!m9Box2 && outboxCountForBox(m9Box2.id, "club_cycle_reminder_14") === 1, "scheduled work generates cycles and enqueues reminders");

console.log(failures === 0 ? "\nALL CLUB CYCLE TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
