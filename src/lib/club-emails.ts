// Book Club cycle emails (Book Club V2).
//
// One email model per cycle event, rendered to plain text here and to
// HTML by emails/ClubCycleEmail.tsx through lib/email-render.ts, the
// same one-model discipline as the order emails.
//
// Senders and suppression:
//   - Selection reminders (14-day and 3-day) are club marketing: they
//     send from news@, carry the tokened unsubscribe link, are skipped
//     at enqueue for opted-out members, and are re-checked and
//     suppressed at send time by lib/email.ts.
//   - Locked, action-needed, and shipped emails are transactional
//     service mail for a paid membership: they send from orders@ and
//     are never suppressed by the marketing opt-out.
//
// Idempotency: every cycle email carries the outbox dedupe key
// club_box:{boxId}:{kind}, so a member receives each (cycle, kind)
// exactly once no matter how many scheduler passes run.

import { enqueueEmail, type DBLike } from "./orders";
import { NEWS_EMAIL } from "./email";
import { getOrCreateUnsubscribeToken, isOptedOut } from "./marketing";
import { boxCreatedDateString, clubCycleTiming, formatClubDate } from "./club-cycle-dates";

export const CLUB_CYCLE_REMINDER_14_KIND = "club_cycle_reminder_14";
export const CLUB_CYCLE_REMINDER_3_KIND = "club_cycle_reminder_3";
export const CLUB_CYCLE_LOCKED_KIND = "club_cycle_locked";
export const CLUB_CYCLE_ATTENTION_KIND = "club_cycle_attention";
export const CLUB_BOX_SHIPPED_KIND = "club_box_shipped";

export const CLUB_CYCLE_EMAIL_KINDS = [
  CLUB_CYCLE_REMINDER_14_KIND,
  CLUB_CYCLE_REMINDER_3_KIND,
  CLUB_CYCLE_LOCKED_KIND,
  CLUB_CYCLE_ATTENTION_KIND,
  CLUB_BOX_SHIPPED_KIND,
] as const;

export function isClubCycleEmailKind(kind: string): boolean {
  return (CLUB_CYCLE_EMAIL_KINDS as readonly string[]).includes(kind);
}

export function isClubReminderKind(kind: string): boolean {
  return kind === CLUB_CYCLE_REMINDER_14_KIND || kind === CLUB_CYCLE_REMINDER_3_KIND;
}

export function clubCycleEmailDedupeKey(boxId: string, kind: string): string {
  return `club_box:${boxId}:${kind}`;
}

export interface ClubCycleEmailModel {
  kind: string;
  subject: string;
  heading: string;
  paragraphs: string[];
  bookTitle: string | null;
  shipDateLabel: string;
  lockDateLabel: string | null;
  accountUrl: string;
  unsubscribeUrl: string | null;
  carrier: string | null;
  trackingNumber: string | null;
}

export function buildClubCycleEmailModel(args: {
  kind: string;
  site: string;
  shipDate: string;
  lockDate?: string | null;
  bookTitle?: string | null;
  surprise?: boolean;
  carrier?: string | null;
  trackingNumber?: string | null;
  unsubscribeToken?: string | null;
}): ClubCycleEmailModel {
  const shipLabel = formatClubDate(args.shipDate);
  const lockLabel = args.lockDate ? formatClubDate(args.lockDate) : null;
  const accountUrl = `${args.site}/account`;
  const base = {
    kind: args.kind,
    bookTitle: args.bookTitle || null,
    shipDateLabel: shipLabel,
    lockDateLabel: lockLabel,
    accountUrl,
    unsubscribeUrl:
      isClubReminderKind(args.kind) && args.unsubscribeToken
        ? `${args.site}/api/unsubscribe?token=${encodeURIComponent(args.unsubscribeToken)}`
        : null,
    carrier: args.carrier || null,
    trackingNumber: args.trackingNumber || null,
  };
  switch (args.kind) {
    case CLUB_CYCLE_REMINDER_14_KIND:
      return {
        ...base,
        subject: `Pick the book for your ${shipLabel} Book Club box`,
        heading: "Choose the book for your next box",
        paragraphs: [
          `Your next Book Club box ships on ${shipLabel}. You can pick the book yourself, or leave it on Surprise me and we will choose a book you do not already have.`,
          `Selections lock on ${lockLabel}. Until then you can change your pick any time from your account.`,
        ],
      };
    case CLUB_CYCLE_REMINDER_3_KIND:
      return {
        ...base,
        subject: `Last call: Book Club selections lock on ${lockLabel}`,
        heading: "Last call before selections lock",
        paragraphs: [
          `Your Book Club box ships on ${shipLabel}, and selections lock on ${lockLabel}. Your box is still set to Surprise me, so we will choose a book you do not already have when selections lock.`,
          "Want a specific book instead? Pick it from your account before the lock and it is yours.",
        ],
      };
    case CLUB_CYCLE_LOCKED_KIND:
      return {
        ...base,
        subject: "Your Book Club book is locked in",
        heading: "Your next box is being prepared",
        paragraphs: [
          args.bookTitle
            ? `The club book for your ${shipLabel} box is ${args.bookTitle}. It ships as the full gift set (the printed storybook plus its printed coloring book), with a second printed book from the back catalog, a sticker sheet, and a little extra from the cast in the same box.`
            : `Your box for ${shipLabel} is being prepared.`,
          "We will email you again when it ships.",
        ],
      };
    case CLUB_CYCLE_ATTENTION_KIND:
      return {
        ...base,
        subject: "Action needed for your next Book Club box",
        heading: "We need a pick from you",
        paragraphs: [
          `Your next Book Club box ships on ${shipLabel}. Surprise me could not pick this time, because every book we can send is already in your library or in one of your earlier club boxes.`,
          "Open your account and choose a repeat or gift copy for this box, and we will get it ready. If we do not hear from you, this box will wait rather than duplicate a book by accident.",
        ],
      };
    case CLUB_BOX_SHIPPED_KIND:
      return {
        ...base,
        subject: "Your Book Club box has shipped",
        heading: "Your Book Club box is on its way",
        paragraphs: [
          args.bookTitle
            ? `Your ${shipLabel} box with ${args.bookTitle} has shipped.`
            : `Your ${shipLabel} Book Club box has shipped.`,
          args.trackingNumber
            ? `Track it with ${args.carrier ? args.carrier + " " : ""}tracking number ${args.trackingNumber}.`
            : "It is on its way to you now.",
        ],
      };
    default:
      return {
        ...base,
        subject: "Your Big Brain Shelf Book Club box",
        heading: "Your Book Club box",
        paragraphs: [`Your next Book Club box ships on ${shipLabel}.`],
      };
  }
}

export function buildClubCycleEmailText(model: ClubCycleEmailModel): string {
  const lines: string[] = [model.heading, ""];
  for (const p of model.paragraphs) {
    lines.push(p, "");
  }
  lines.push(`Manage your Book Club box: ${model.accountUrl}`);
  lines.push("");
  lines.push("Happy reading,");
  lines.push("Big Brain Shelf");
  if (model.unsubscribeUrl) {
    lines.push("");
    lines.push(`Rather not get club news? Unsubscribe here: ${model.unsubscribeUrl}`);
  }
  return lines.join("\n");
}

// Load everything an email render needs for one outbox row: the box,
// its member, the resolved book's title, and the cycle timing.
export async function loadClubCycleEmailModel(
  db: DBLike,
  site: string,
  row: { kind: string; club_box_id?: string | null; to_email?: string }
): Promise<ClubCycleEmailModel | null> {
  if (!row.club_box_id || !isClubCycleEmailKind(row.kind)) return null;
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
  const timing = clubCycleTiming(String(box.ship_date), boxCreatedDateString(box.created_at));
  let token: string | null = null;
  if (isClubReminderKind(row.kind) && row.to_email) {
    token = await getOrCreateUnsubscribeToken(db, String(row.to_email));
  }
  return buildClubCycleEmailModel({
    kind: row.kind,
    site,
    shipDate: String(box.ship_date),
    lockDate: timing.lockDate,
    bookTitle: box.book_title || null,
    carrier: box.carrier || null,
    trackingNumber: box.tracking_number || null,
    unsubscribeToken: token,
  });
}

// Enqueue one cycle email for a box. Returns true when a new row was
// requested (the outbox insert is INSERT OR IGNORE on the dedupe key,
// so repeat calls converge). Reminders respect the marketing opt-out
// at enqueue; flushOutbox re-checks at send time.
export async function enqueueClubCycleEmail(
  db: DBLike,
  site: string,
  box: any,
  kind: string
): Promise<boolean> {
  if (!box?.id || !isClubCycleEmailKind(kind)) return false;
  const member = await db
    .prepare("SELECT * FROM club_signups WHERE id = ?")
    .bind(box.signup_id)
    .first();
  if (!member?.email) return false;
  const email = String(member.email);
  if (isClubReminderKind(kind) && (await isOptedOut(db, email))) return false;

  const timing = clubCycleTiming(String(box.ship_date), boxCreatedDateString(box.created_at));
  let bookTitle: string | null = null;
  if (box.resolved_book_slug) {
    const book = await db
      .prepare("SELECT title FROM books WHERE slug = ?")
      .bind(box.resolved_book_slug)
      .first();
    bookTitle = book?.title ? String(book.title) : null;
  }
  const token = isClubReminderKind(kind) ? await getOrCreateUnsubscribeToken(db, email) : null;
  const model = buildClubCycleEmailModel({
    kind,
    site,
    shipDate: String(box.ship_date),
    lockDate: timing.lockDate,
    bookTitle,
    carrier: box.carrier || null,
    trackingNumber: box.tracking_number || null,
    unsubscribeToken: token,
  });
  await enqueueEmail(db, {
    orderId: null,
    kind,
    to: email,
    subject: model.subject,
    text: buildClubCycleEmailText(model),
    fromEmail: isClubReminderKind(kind) ? NEWS_EMAIL : null,
    dedupeKey: clubCycleEmailDedupeKey(String(box.id), kind),
    clubBoxId: String(box.id),
  });
  return true;
}
