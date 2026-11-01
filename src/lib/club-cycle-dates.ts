// Pure calendar helpers for Book Club cycles, kept dependency-free so
// the cycle engine (club-cycles.ts) and the cycle emails
// (club-emails.ts) can both use them without an import cycle.
//
// All dates are YYYY-MM-DD calendar dates in America/Chicago.
//
// Cycles are PURCHASE-ANCHORED (owner direction, 2026-10-29): a
// member's first box is due on the day they join, and the next boxes
// fall every 3 months from that join date for as long as the
// membership stays active. There is no global ship calendar and no
// launch-date floor anymore. Reminders land 14 and 3 calendar days
// before a box's due date; selections lock ON the due date, when
// packing starts, so the last-call reminder leaves 3 full days to
// act. A box created ON its due date (the normal case for a first
// box) instead locks CLUB_PICK_FLOOR_DAYS after creation, so a
// brand-new member gets 5 full days to change picks before the box
// resolves (CG, 2026-11-01: boxes ship on a 5 to 7 day turnaround,
// so picks stay open through most of it).

export const CLUB_REMINDER_14_DAYS = 14;
export const CLUB_REMINDER_3_DAYS = 3;
export const CLUB_LOCK_DAYS_BEFORE = 0;
// Pick window floor for a freshly created box: the lock lands this
// many days after creation, which leaves 5 full changeable days
// after the creation day itself.
export const CLUB_PICK_FLOOR_DAYS = 6;
// Print-and-pack turnaround (CG, 2026-11-01): boxes ship within 5
// to 7 days of their due date. The cycle stays anchored to the join
// date (picks open, digital lands day one), but the member-facing
// ship-by date is the due date plus this many days, for every box.
export const CLUB_PROCESSING_DAYS = 7;
export const CLUB_CYCLE_HORIZON = 2;
export const CLUB_CYCLE_MONTHS = 3;

export function addDaysToDateString(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Calendar-month addition with day clamping: Jan 31 + 3 months is
// Apr 30, and a Jan 31 anchor cycles Apr 30 / Jul 31 / Oct 31 rather
// than skipping short months.
export function addMonthsToDateString(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

// The America/Chicago calendar date (YYYY-MM-DD) containing a unix
// timestamp in seconds.
export function dateStringFromUnixSeconds(sec: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(sec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function formatClubDate(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export interface ClubCycleTiming {
  shipDate: string;
  reminder14Date: string;
  reminder3Date: string;
  lockDate: string;
}

// Timing for one box. `boxCreatedDateStr` is the Chicago date the box
// row was created; when the box was created close to its due date (a
// first box is created on its due date), the lock moves to creation
// + CLUB_PICK_FLOOR_DAYS so the member still gets time to choose.
export function clubCycleTiming(shipDate: string, boxCreatedDateStr?: string | null): ClubCycleTiming {
  let lockDate = addDaysToDateString(shipDate, -CLUB_LOCK_DAYS_BEFORE);
  if (boxCreatedDateStr) {
    const floor = addDaysToDateString(boxCreatedDateStr, CLUB_PICK_FLOOR_DAYS);
    if (floor > lockDate) lockDate = floor;
  }
  return {
    shipDate,
    reminder14Date: addDaysToDateString(shipDate, -CLUB_REMINDER_14_DAYS),
    reminder3Date: addDaysToDateString(shipDate, -CLUB_REMINDER_3_DAYS),
    lockDate,
  };
}

// The date a box row was created, as a Chicago YYYY-MM-DD string, from
// its unix-second created_at.
export function boxCreatedDateString(createdAtSec: number | null | undefined): string | null {
  return createdAtSec ? dateStringFromUnixSeconds(createdAtSec) : null;
}

export interface ClubAnchorMember {
  first_ship_date?: string | null;
  paid_at?: number | null;
  created_at?: number | null;
}

function isDateString(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// A member's cycle anchor: the date their box schedule runs from.
// Activation stamps first_ship_date with the join date for physical
// members, so that is the anchor; the fallbacks (paid_at, then
// created_at) keep any older row anchored to when it actually joined.
export function clubAnchorDateString(member: ClubAnchorMember): string {
  if (isDateString(member.first_ship_date)) return member.first_ship_date;
  if (member.paid_at) return dateStringFromUnixSeconds(member.paid_at);
  if (member.created_at) return dateStringFromUnixSeconds(member.created_at);
  return dateStringFromUnixSeconds(Math.floor(Date.now() / 1000));
}

// The index of `dateStr` in the member's due-date sequence (0 = the
// join date itself), or -1 when the date is not one of their box
// dates.
export function memberCycleDateIndex(anchor: string, dateStr: string): number {
  if (!isDateString(anchor) || !isDateString(dateStr) || dateStr < anchor) return -1;
  let d = anchor;
  for (let k = 0; k < 400; k++) {
    if (d === dateStr) return k;
    if (d > dateStr) return -1;
    d = addMonthsToDateString(d, CLUB_CYCLE_MONTHS);
  }
  return -1;
}

export function isMemberCycleDate(anchor: string, dateStr: string): boolean {
  return memberCycleDateIndex(anchor, dateStr) >= 0;
}

// The `count` due dates the scheduler keeps in existence for a member:
// the most recent due date on or before `today` (the box currently due
// or in fulfilment; a first box is due on the join date itself), then
// the following ones every 3 months.
export function memberCycleWindowDates(anchor: string, today: string, count = CLUB_CYCLE_HORIZON): string[] {
  let current = anchor;
  while (addMonthsToDateString(current, CLUB_CYCLE_MONTHS) <= today) {
    current = addMonthsToDateString(current, CLUB_CYCLE_MONTHS);
  }
  const dates = [current];
  while (dates.length < count) {
    dates.push(addMonthsToDateString(dates[dates.length - 1], CLUB_CYCLE_MONTHS));
  }
  return dates;
}
