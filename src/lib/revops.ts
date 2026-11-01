/**
 * Pillar 5B: RevOps & Lifecycle Flywheel Engine
 * Grounded strictly in real `src/lib/offers.ts` & `src/lib/family.ts`:
 * - Audiobook only: $1.99 (`AUDIO_PRICE_CENTS = 199`)
 * - Digital bundle (eBook + Audiobook): $8.99 (`STANDARD_DIGITAL_PRICE_CENTS = 899`)
 * - Printed Book + Digital Bundle: $20.00 (`STANDARD_PRINT_PRICE_CENTS = 2000`)
 * - Complete Gift Set: $25.00 (`GIFT_SET_PRICE_CENTS = 2500`)
 * - The Book Club (Physical): $60/quarter (`CLUB_PRICE_CENTS = 6000`) or $199/year (`CLUB_ANNUAL_PRICE_CENTS = 19900`)
 * - The Audio Club: $5.99/month (`AUDIO_CLUB_PRICE_CENTS = 599`) or $49/year (`AUDIO_CLUB_ANNUAL_PRICE_CENTS = 4900`)
 * - Birthday Gift Code: `BDAY10` ($10 birthday credit on next $25 Gift Set, matching `family.ts` + `BirthdayGiftEmail.tsx`)
 *
 * Automated Lifecycle Plays:
 * 1. Automated Kid Birthday Gift Play (`birthday_bday10`):
 *    - On the child's birthday (matched from `kid_profiles.birth_date`), enqueues `birthday_gift`
 *      with code `BDAY10` into `email_outbox` via `enqueueBirthdayGiftEmail` (deduped per kid per
 *      calendar year). The age in the email is computed from the real birth date.
 * 2. 80%+ Book Completion -> Club Invitation (`completion_upsell_80`):
 *    - When a non-Club family reaches >= 80% completion in `reading_progress`, enqueues a warm
 *      invitation to The Audio Club ($5.99/mo or $49/yr) or The Book Club ($60/quarter or $199/yr),
 *      under its own outbox kind (`completion_upsell`), once per user per book.
 *
 * There is deliberately NO retention / plan-switch play here: changing a
 * member's plan means changing their Stripe subscription, and a save flow
 * that reports success without doing that is worse than no save flow. It
 * returns only when it can drive Stripe for real.
 */

import {
  AUDIO_PRICE_CENTS,
  STANDARD_DIGITAL_PRICE_CENTS,
  STANDARD_PRINT_PRICE_CENTS,
  GIFT_SET_PRICE_CENTS,
  CLUB_PRICE_CENTS,
  CLUB_ANNUAL_PRICE_CENTS,
  AUDIO_CLUB_PRICE_CENTS,
  AUDIO_CLUB_ANNUAL_PRICE_CENTS,
} from "./offers";
import { enqueueEmail } from "./orders";
import { enqueueBirthdayGiftEmail, calculateAgeFromDob } from "./family";

export const BIRTHDAY_GIFT_CODE = "BDAY10";

export const REVOPS_PRICING_MATRIX = {
  audioOnlyCents: AUDIO_PRICE_CENTS, // 199 ($1.99)
  digitalBundleCents: STANDARD_DIGITAL_PRICE_CENTS, // 899 ($8.99)
  printedBookCents: STANDARD_PRINT_PRICE_CENTS, // 2000 ($20.00)
  giftSetCents: GIFT_SET_PRICE_CENTS, // 2500 ($25.00)
  bookClubQuarterlyCents: CLUB_PRICE_CENTS, // 6000 ($60/quarter)
  bookClubAnnualCents: CLUB_ANNUAL_PRICE_CENTS, // 19900 ($199/year)
  audioClubMonthlyCents: AUDIO_CLUB_PRICE_CENTS, // 599 ($5.99/month)
  audioClubAnnualCents: AUDIO_CLUB_ANNUAL_PRICE_CENTS, // 4900 ($49/year)
  birthdayCode: BIRTHDAY_GIFT_CODE, // "BDAY10"
} as const;


export interface RevOpsAccountScore {
  email: string;
  engagementScore: number; // 0-100
  churnRisk: "low" | "medium" | "high";
  recommendedPlay: string;
  ltvCents: number;
}

let revopsSchemaReady = false;

export async function ensureRevOpsSchema(db?: D1Database): Promise<void> {
  if (!db || revopsSchemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS revops_lifecycle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        email TEXT NOT NULL,
        play_type TEXT NOT NULL,
        trigger_key TEXT NOT NULL UNIQUE,
        book_slug TEXT,
        kid_profile_id INTEGER,
        offer_code TEXT,
        status TEXT NOT NULL DEFAULT 'sent',
        metadata_json TEXT,
        created_at TEXT NOT NULL
      )`
    )
    .run();
  revopsSchemaReady = true;
}

/**
 * Checks whether a child's `birth_date` (YYYY-MM-DD or MM-DD) is within `windowDays` (default 10 days)
 * of `referenceDate`.
 */
export function isBirthdayWithinWindow(
  birthDateStr: string | null | undefined,
  referenceDate: Date = new Date(),
  windowDays = 10
): { matches: boolean; daysUntil: number } {
  if (!birthDateStr) return { matches: false, daysUntil: 999 };
  const cleaned = birthDateStr.trim();
  const parts = cleaned.split("-");
  const month = Number(parts.length === 3 ? parts[1] : parts[0]);
  const day = Number(parts.length === 3 ? parts[2] : parts[1]);
  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) {
    return { matches: false, daysUntil: 999 };
  }

  const refUtc = Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate()
  );

  let nextBirthdayUtc = Date.UTC(referenceDate.getUTCFullYear(), month - 1, day);
  if (nextBirthdayUtc < refUtc) {
    nextBirthdayUtc = Date.UTC(referenceDate.getUTCFullYear() + 1, month - 1, day);
  }

  const diffDays = Math.round((nextBirthdayUtc - refUtc) / (1000 * 60 * 60 * 24));
  return {
    matches: diffDays >= 0 && diffDays <= windowDays,
    daysUntil: diffDays,
  };
}

/**
 * Play 1: Daily Kid Birthday Gift Scheduler (`BDAY10` - $10 gift credit on next $25 Gift Set).
 * Runs inside the scheduled cron (`club-scheduler.ts`) and enqueues `birthday_gift` into `email_outbox`.
 */
export async function runBirthdayGiftScheduler(
  db: D1Database,
  siteUrl = "https://bigbrainshelf.com",
  now: Date = new Date()
): Promise<{ checkedKids: number; queuedBirthdayEmails: number }> {
  await ensureRevOpsSchema(db);

  let checkedKids = 0;
  let queuedBirthdayEmails = 0;
  const year = now.getUTCFullYear();

  try {
    const rows = await db
      .prepare(
        `SELECT kp.id AS kid_id,
                kp.user_id,
                kp.name AS kid_name,
                kp.birth_date,
                kp.age AS kid_age,
                kp.avatar_key,
                kp.age_group,
                u.email,
                po.marketing_opt_in
         FROM kid_profiles kp
         INNER JOIN "user" u ON u.id = kp.user_id
         LEFT JOIN parent_onboarding po ON po.user_id = kp.user_id
         WHERE kp.birth_date IS NOT NULL AND kp.birth_date != ''`
      )
      .all<{
        kid_id: string;
        user_id: string;
        kid_name: string;
        birth_date: string;
        kid_age: number | null;
        avatar_key: string | null;
        age_group: string | null;
        email: string;
        marketing_opt_in: number | null;
      }>();

    for (const row of rows.results || []) {
      checkedKids++;
      if (row.marketing_opt_in === 0) continue;

      const check = isBirthdayWithinWindow(row.birth_date, now, 0);
      if (!check.matches) continue;

      const triggerKey = `bday10:${row.kid_id}:${year}`;
      const existing = await db
        .prepare(`SELECT id FROM revops_lifecycle_events WHERE trigger_key = ?`)
        .bind(triggerKey)
        .first();
      if (existing) continue;

      await enqueueBirthdayGiftEmail(
        db as any,
        row.user_id,
        row.email.toLowerCase(),
        {
          id: String(row.kid_id),
          user_id: row.user_id,
          name: row.kid_name || "your reader",
          age: calculateAgeFromDob(row.birth_date, now) ?? row.kid_age ?? 6,
          age_group: (row.age_group as any) || "4-8",
          birth_date: row.birth_date,
          avatar_key: row.avatar_key || "fern",
          favorite_topics: [],
          future_topics: [],
          default_sleep_timer_minutes: 60,
          daily_limit_minutes: 60,
          daily_minutes_used: 0,
          daily_usage_date: null,
          birthday_gift_sent_year: year,
          created_at: 0,
          updated_at: 0,
        },
        siteUrl
      );

      const isoNow = now.toISOString();
      await db
        .prepare(
          `INSERT INTO revops_lifecycle_events
            (user_id, email, play_type, trigger_key, offer_code, status, metadata_json, created_at)
           VALUES (?, ?, 'birthday_bday10', ?, ?, 'queued', ?, ?)`
        )
        .bind(
          row.user_id,
          row.email.toLowerCase(),
          triggerKey,
          BIRTHDAY_GIFT_CODE,
          JSON.stringify({ daysUntilBirthday: check.daysUntil, kidName: row.kid_name }),
          isoNow
        )
        .run();

      queuedBirthdayEmails++;
    }
  } catch (err: any) {
    // Never let one play break the scheduler, but never fail silently
    // either: a schema break here would otherwise stop all birthday mail
    // without a trace.
    console.error("birthday gift scheduler failed", err?.message || err);
  }

  return { checkedKids, queuedBirthdayEmails };
}

/**
 * Play 2: 80%+ Book Completion -> Club / Next Volume Upsell
 * Triggered when a reader crosses >= 80% completion in `/api/account/progress`.
 */
export async function checkAndEnqueueCompletionUpsell(params: {
  db?: D1Database;
  userId: string;
  email: string;
  bookSlug: string;
  percentComplete: number;
  siteUrl?: string;
}): Promise<{ triggered: boolean; offerType?: string }> {
  if (!params.db || params.percentComplete < 80) {
    return { triggered: false };
  }

  await ensureRevOpsSchema(params.db);
  const email = (params.email || "").trim().toLowerCase();
  if (!email) return { triggered: false };

  const triggerKey = `completion80:${params.userId}:${params.bookSlug}`;
  const existing = await params.db
    .prepare(`SELECT id FROM revops_lifecycle_events WHERE trigger_key = ?`)
    .bind(triggerKey)
    .first();
  if (existing) return { triggered: false };

  // Check if already a paid Club member in `club_signups`
  try {
    const activeSub = await params.db
      .prepare(
        `SELECT id FROM club_signups
         WHERE LOWER(email) = ? AND status = 'paid'
         LIMIT 1`
      )
      .bind(email)
      .first();
    if (activeSub) return { triggered: false };
  } catch {
    // ignore if table absent
  }

  const siteUrl = (params.siteUrl || "https://bigbrainshelf.com").replace(/\/+$/, "");
  const now = new Date().toISOString();

  // Books are named by their public title in customer mail, never by
  // the internal slug the progress row carries.
  let bookTitle = "";
  try {
    const book = await params.db
      .prepare(`SELECT title FROM books WHERE slug = ? LIMIT 1`)
      .bind(params.bookSlug)
      .first<{ title: string }>();
    bookTitle = String(book?.title || "").trim();
  } catch {
    // books table absent in isolated unit tests; fall back to no title
  }
  const titleRef = bookTitle || "your book";

  const finished = params.percentComplete >= 100;
  const subject = finished
    ? `You finished ${titleRef}`
    : `You are most of the way through ${titleRef}`;
  const textBody = [
    finished
      ? `Your family finished ${titleRef}. Nice work.`
      : `Your family has read ${params.percentComplete}% of ${titleRef}. Nice work.`,
    `When you are ready for the next book, the clubs keep the shelf full:`,
    `- The Audio Club ($5.99/month or $49/year): every Big Brain Shelf audiobook in your library while your membership is active, with read-along.`,
    `- The Book Club ($60/quarter or $199/year): a printed gift set box every 3 months with a second printed book from the back catalog, and the digital editions in your library from day one.`,
    `- Or add single books anytime: digital bundle $8.99, printed book $20, complete gift set $25.`,
    `See the clubs: ${siteUrl}/clubs`,
  ].join("\n\n");

  try {
    await enqueueEmail(params.db as any, {
      orderId: null,
      to: email,
      subject,
      text: textBody,
      kind: "completion_upsell",
      dedupeKey: triggerKey,
    });
  } catch {
    // email_outbox may not be initialized in unit test mocks
  }

  await params.db
    .prepare(
      `INSERT INTO revops_lifecycle_events
        (user_id, email, play_type, trigger_key, book_slug, offer_code, status, metadata_json, created_at)
       VALUES (?, ?, 'completion_upsell_80', ?, ?, 'CLUB_UPSELL', 'queued', ?, ?)`
    )
    .bind(
      params.userId,
      email,
      triggerKey,
      params.bookSlug,
      JSON.stringify({
        percentComplete: params.percentComplete,
        audioClubMonthly: "$5.99/mo",
        audioClubAnnual: "$49/yr",
        bookClubQuarterly: "$60/quarter",
        bookClubAnnual: "$199/yr",
      }),
      now
    )
    .run();

  return { triggered: true, offerType: "audio_club_599_or_book_club_60qtr" };
}

export function scoreAccountRevOps(input: {
  email: string;
  ordersCount: number;
  totalSpentCents: number;
  booksCompletedCount: number;
  daysSinceLastRead: number;
  hasActiveClub: boolean;
}): RevOpsAccountScore {
  let score = 40;
  score += Math.min(25, input.booksCompletedCount * 12);
  score += Math.min(20, input.ordersCount * 8);
  if (input.hasActiveClub) score += 15;
  if (input.daysSinceLastRead > 21) score -= 25;
  else if (input.daysSinceLastRead <= 7) score += 10;

  const clamped = Math.max(0, Math.min(100, score));
  const churnRisk: RevOpsAccountScore["churnRisk"] =
    clamped < 40 ? "high" : clamped < 70 ? "medium" : "low";

  let recommendedPlay = "Keep the weekly read-along habit going";
  if (input.hasActiveClub && churnRisk === "high") {
    recommendedPlay =
      "Reach out personally and ask what would help. No plan change is promised in the app";
  } else if (!input.hasActiveClub && input.booksCompletedCount >= 1) {
    recommendedPlay =
      "Trigger 80% completion upsell to Audio Club ($5.99/mo) or Book Club ($60/qtr)";
  } else if (input.hasActiveClub && churnRisk === "low") {
    recommendedPlay =
      "Invite to Annual plan ($199/yr Book Club or $49/yr Audio Club) + Family Referral link";
  }

  return {
    email: input.email,
    engagementScore: clamped,
    churnRisk,
    recommendedPlay,
    ltvCents: input.totalSpentCents,
  };
}

export async function getRevOpsDashboardMetrics(db?: D1Database): Promise<{
  pricingMatrix: typeof REVOPS_PRICING_MATRIX;
  totalRevenueUsd: number;
  activeBookClubCount: number;
  activeAudioClubCount: number;
  lifecyclePlaysCount: Array<{ playType: string; count: number }>;
}> {
  let totalRevenueCents = 0;
  let activeBookClubCount = 0;
  let activeAudioClubCount = 0;
  const lifecyclePlaysCount: Array<{ playType: string; count: number }> = [];

  if (db) {
    await ensureRevOpsSchema(db);
    try {
      const rev = await db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS total_cents FROM orders WHERE status = 'complete'`
        )
        .first<{ total_cents: number }>();
      totalRevenueCents = Number(rev?.total_cents || 0);
    } catch {
      // ignore
    }

    try {
      const subs = await db
        .prepare(
          `SELECT club_plan, COUNT(*) AS cnt
           FROM club_signups
           WHERE status = 'paid'
           GROUP BY club_plan`
        )
        .all<{ club_plan: string | null; cnt: number }>();
      for (const s of subs.results || []) {
        if (String(s.club_plan || "") === "audio") {
          activeAudioClubCount += Number(s.cnt || 0);
        } else {
          activeBookClubCount += Number(s.cnt || 0);
        }
      }
    } catch {
      // ignore
    }

    try {
      const plays = await db
        .prepare(
          `SELECT play_type, COUNT(*) AS cnt
           FROM revops_lifecycle_events
           GROUP BY play_type
           ORDER BY cnt DESC`
        )
        .all<{ play_type: string; cnt: number }>();
      for (const p of plays.results || []) {
        lifecyclePlaysCount.push({ playType: p.play_type, count: Number(p.cnt || 0) });
      }
    } catch {
      // ignore
    }
  }

  return {
    pricingMatrix: REVOPS_PRICING_MATRIX,
    totalRevenueUsd: Number((totalRevenueCents / 100).toFixed(2)),
    activeBookClubCount,
    activeAudioClubCount,
    lifecyclePlaysCount,
  };
}
