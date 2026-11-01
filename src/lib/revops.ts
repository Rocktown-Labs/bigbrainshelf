// Pillar 6: Revenue Operations (RevOps) & Automated Lifecycle Engine
//
// Strictly grounded in `src/lib/offers.ts` pricing:
//   - Audiobook Only: $1.99 (`AUDIO_PRICE_CENTS = 199`)
//   - Digital Bundle: $8.99 (`STANDARD_DIGITAL_PRICE_CENTS = 899`)
//   - Printed Book:   $20.00 (`STANDARD_PRINT_PRICE_CENTS = 2000`)
//   - Gift Set:       $25.00 (`GIFT_SET_PRICE_CENTS = 2500`)
//   - The Book Club:  $60/quarter (`CLUB_PRICE_CENTS = 6000`) or $199/year (`CLUB_ANNUAL_PRICE_CENTS = 19900`)
//   - The Audio Club: $5.99/month (`AUDIO_CLUB_PRICE_CENTS = 599`) or $49/year (`AUDIO_CLUB_ANNUAL_PRICE_CENTS = 4900`)
//   - Birthday Code:  `BDAY10` ($10 off the next $25 Gift Set -> $15)

import type { DBLike } from "./orders";
import { ensureOutboxColumns } from "./orders";
import { ensureOnce } from "./schema-cache";
import {
  AUDIO_CLUB_ANNUAL_PRICE_CENTS,
  AUDIO_CLUB_PRICE_CENTS,
  AUDIO_PRICE_CENTS,
  CLUB_ANNUAL_PRICE_CENTS,
  CLUB_PRICE_CENTS,
  GIFT_SET_PRICE_CENTS,
  STANDARD_DIGITAL_PRICE_CENTS,
  STANDARD_PRINT_PRICE_CENTS,
  chicagoDateString,
  clubPriceLabel,
} from "./offers";
import { ensureClubTable, getClubMembership, clubPlanOf, clubMembershipActive } from "./club";
import { addMonthsToDateString } from "./club-cycles";
import { enqueueBirthdayGiftEmail, ensureFamilyTables } from "./family";
import { NEWS_EMAIL } from "./email";

export type LifecycleStage =
  | "subscriber"
  | "activated"
  | "customer"
  | "club_member"
  | "evangelist"
  | "b2b_mql";

export type ClubRetentionAction =
  | "skip_next_box"
  | "switch_to_audio_club"
  | "upgrade_to_annual";

export interface RevOpsBirthdayCronSummary {
  checked: number;
  sent: number;
  skipped: number;
}

export async function ensureRevOpsTables(db: DBLike): Promise<void> {
  await ensureOnce(db, "revops_tables_v1", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS revops_lifecycle_events (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          email TEXT NOT NULL,
          event_kind TEXT NOT NULL,
          dedupe_key TEXT NOT NULL UNIQUE,
          fit_score INTEGER NOT NULL DEFAULT 0,
          engagement_score INTEGER NOT NULL DEFAULT 0,
          lifecycle_stage TEXT NOT NULL DEFAULT 'activated',
          metadata_json TEXT DEFAULT '{}',
          created_at INTEGER NOT NULL
        )`
      )
      .run();
    await db
      .prepare("CREATE UNIQUE INDEX IF NOT EXISTS revops_dedupe_idx ON revops_lifecycle_events(dedupe_key)")
      .run();
    await db
      .prepare("CREATE INDEX IF NOT EXISTS revops_email_kind_idx ON revops_lifecycle_events(email, event_kind)")
      .run();
  });
}

// Score an account on two axes per `@[.agents/skills/revops]`:
//   - Fit Score (0-50): Kid profiles, multi-child family, or B2B2C School/Homeschool Co-op signal
//   - Engagement Score (0-50): Onboarding completion, orders, reading heartbeats, referral shares
export function scoreAccountRevOps(params: {
  email: string;
  readingGoal?: string | null;
  kidCount?: number;
  orderCount?: number;
  isClubMember?: boolean;
  hasSharedReferral?: boolean;
  onboardingCompleted?: boolean;
}): {
  fitScore: number;
  engagementScore: number;
  totalScore: number;
  lifecycleStage: LifecycleStage;
  isB2BInstitutional: boolean;
} {
  const email = String(params.email || "").toLowerCase().trim();
  const goal = String(params.readingGoal || "").toLowerCase();
  const isEduOrSchool =
    email.endsWith(".edu") ||
    email.includes("school") ||
    email.includes("library") ||
    email.includes("academy") ||
    email.includes("coop") ||
    goal.includes("homeschool") ||
    goal.includes("classroom") ||
    goal.includes("school");

  let fitScore = 15;
  if ((params.kidCount || 0) >= 1) fitScore += 15;
  if ((params.kidCount || 0) >= 2) fitScore += 10;
  if (isEduOrSchool) fitScore += 15;
  fitScore = Math.min(50, fitScore);

  let engagementScore = 10;
  if (params.onboardingCompleted) engagementScore += 10;
  if ((params.orderCount || 0) >= 1) engagementScore += 15;
  if (params.isClubMember) engagementScore += 15;
  if (params.hasSharedReferral) engagementScore += 10;
  engagementScore = Math.min(50, engagementScore);

  let lifecycleStage: LifecycleStage = "subscriber";
  if (params.hasSharedReferral && (params.isClubMember || (params.orderCount || 0) >= 2)) {
    lifecycleStage = "evangelist";
  } else if (params.isClubMember) {
    lifecycleStage = "club_member";
  } else if ((params.orderCount || 0) >= 1) {
    lifecycleStage = "customer";
  } else if (isEduOrSchool && params.onboardingCompleted) {
    lifecycleStage = "b2b_mql";
  } else if (params.onboardingCompleted || (params.kidCount || 0) >= 1) {
    lifecycleStage = "activated";
  }

  return {
    fitScore,
    engagementScore,
    totalScore: fitScore + engagementScore,
    lifecycleStage,
    isB2BInstitutional: isEduOrSchool,
  };
}

// Check if a YYYY-MM-DD birth_date falls within the next `windowDays` (default 10 days)
// relative to `todayStr` (YYYY-MM-DD in America/Chicago) so physical $25 Gift Sets
// ordered with `BDAY10` have time to print and ship!
export function isBirthdayWithinWindow(
  birthDateStr: string | null | undefined,
  todayStr: string,
  windowDays = 10
): boolean {
  const b = String(birthDateStr || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b) || !/^\d{4}-\d{2}-\d{2}$/.test(todayStr)) return false;
  const [, bMonth, bDay] = b.split("-").map(Number);
  const [tYear, tMonth, tDay] = todayStr.split("-").map(Number);
  if (!bMonth || !bDay || !tYear) return false;

  const todayUtc = Date.UTC(tYear, tMonth - 1, tDay);
  for (let offset = 0; offset <= windowDays; offset++) {
    const d = new Date(todayUtc + offset * 86400_000);
    if (d.getUTCMonth() + 1 === bMonth && d.getUTCDate() === bDay) {
      return true;
    }
  }
  return false;
}

// 1. Automated Birthday Gift Cron (`BDAY10` on a $25 Gift Set -> $15)
// Runs inside the worker's scheduled cron pass; idempotent per child per calendar year.
export async function runBirthdayGiftScheduler(
  db: DBLike,
  site: string,
  now: Date = new Date()
): Promise<RevOpsBirthdayCronSummary> {
  const summary: RevOpsBirthdayCronSummary = { checked: 0, sent: 0, skipped: 0 };
  try {
    await ensureFamilyTables(db);
    await ensureRevOpsTables(db);
  } catch {
    return summary;
  }

  const todayStr = chicagoDateString(now);
  const currentYear = Number(todayStr.slice(0, 4));

  let rows: any[] = [];
  try {
    const res = await db
      .prepare(
        `SELECT kp.id, kp.user_id, kp.name, kp.birth_date, kp.birthday_gift_sent_year,
                kp.age, kp.age_group, kp.avatar_key,
                u.email AS user_email, u.name AS user_name,
                po.parent_name, po.marketing_opt_in
           FROM kid_profiles kp
           LEFT JOIN "user" u ON u.id = kp.user_id
           LEFT JOIN parent_onboarding po ON po.user_id = kp.user_id
          WHERE kp.birth_date IS NOT NULL AND kp.birth_date != ''
          LIMIT 100`
      )
      .all();
    rows = (res.results || (res as any).rows || []) as any[];
  } catch {
    return summary;
  }

  for (const r of rows) {
    summary.checked++;
    if (Number(r.birthday_gift_sent_year || 0) >= currentYear) {
      summary.skipped++;
      continue;
    }
    if (!isBirthdayWithinWindow(r.birth_date, todayStr, 10)) {
      summary.skipped++;
      continue;
    }
    const email = String(r.user_email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      summary.skipped++;
      continue;
    }

    const dedupeKey = `bday10:${r.id}:${currentYear}`;
    const existing = await db
      .prepare("SELECT id FROM revops_lifecycle_events WHERE dedupe_key = ?")
      .bind(dedupeKey)
      .first();
    if (existing) {
      summary.skipped++;
      continue;
    }

    try {
      await enqueueBirthdayGiftEmail(
        db,
        String(r.user_id),
        email,
        r.parent_name || r.user_name || null,
        {
          id: String(r.id),
          user_id: String(r.user_id),
          name: String(r.name || "Your Reader"),
          birth_date: String(r.birth_date),
          birthday_gift_sent_year: currentYear,
          age: Number(r.age || 6),
          age_group: (r.age_group || "4-8") as any,
          avatar_key: String(r.avatar_key || "mira"),
          favorite_themes: ["courage", "tech", "money"],
          daily_limit_minutes: 60,
          default_sleep_timer_minutes: 60,
          bedtime_cutoff: null,
          allow_audio_autoplay: true,
          allowed_book_slugs: null,
          daily_minutes_used: 0,
          daily_minutes_date: todayStr,
          is_default: true,
          created_at: 0,
          updated_at: 0,
        },
        site
      );

      const ts = Math.floor(now.getTime() / 1000);
      await db
        .prepare(
          `INSERT INTO revops_lifecycle_events
            (id, user_id, email, event_kind, dedupe_key, fit_score, engagement_score, lifecycle_stage, metadata_json, created_at)
           VALUES (?, ?, ?, 'bday10_sent', ?, 35, 30, 'activated', ?, ?)
           ON CONFLICT(dedupe_key) DO NOTHING`
        )
        .bind(
          `ro_${ts}_${Math.random().toString(36).slice(2, 8)}`,
          String(r.user_id),
          email,
          dedupeKey,
          JSON.stringify({
            kidId: r.id,
            kidName: r.name,
            birthDate: r.birth_date,
            code: "BDAY10",
            giftSetPriceCents: GIFT_SET_PRICE_CENTS,
          }),
          ts
        )
        .run();
      summary.sent++;
    } catch {
      summary.skipped++;
    }
  }

  return summary;
}

// 2. The "80% Book/Audio Completion" Upsell Trigger
// When a child reaches >= 80% of a book or $1.99 audiobook / $8.99 digital bundle,
// if the family is not yet in The Audio Club ($5.99/mo or $49/yr) or The Book Club
// ($60/qtr or $199/yr), enqueue a personalized milestone + Club upgrade email once per book.
export async function checkAndEnqueueCompletionUpsell(
  db: DBLike,
  site: string,
  params: {
    userId: string;
    userEmail: string;
    userName?: string | null;
    bookSlug: string;
    completionPct: number;
  }
): Promise<{ triggered: boolean; reason?: string }> {
  if (params.completionPct < 80) {
    return { triggered: false, reason: "below_80_pct" };
  }
  const email = String(params.userEmail || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { triggered: false, reason: "no_email" };
  }

  await ensureRevOpsTables(db);
  const dedupeKey = `completion_80:${params.userId}:${params.bookSlug}`;
  const already = await db
    .prepare("SELECT id FROM revops_lifecycle_events WHERE dedupe_key = ?")
    .bind(dedupeKey)
    .first();
  if (already) {
    return { triggered: false, reason: "already_sent" };
  }

  // Check if already an active Club member
  try {
    const member = await getClubMembership(db, { id: params.userId, email });
    if (member && clubMembershipActive(member)) {
      return { triggered: false, reason: "already_club_member" };
    }
  } catch {}

  const bookRow: any = await db
    .prepare("SELECT title, topic FROM books WHERE slug = ?")
    .bind(params.bookSlug)
    .first()
    .catch(() => null);
  const bookTitle = String(bookRow?.title || params.bookSlug);
  const audioMonthly = clubPriceLabel(AUDIO_CLUB_PRICE_CENTS);
  const audioAnnual = `$${(AUDIO_CLUB_ANNUAL_PRICE_CENTS / 100).toFixed(0)}`;
  const clubQuarterly = `$${(CLUB_PRICE_CENTS / 100).toFixed(0)}`;
  const clubAnnual = `$${(CLUB_ANNUAL_PRICE_CENTS / 100).toFixed(0)}`;

  const subject = `You're 80% through ${bookTitle}! Ready for your next story?`;
  const bodyText = [
    `Hi ${params.userName || "there"},`,
    "",
    `Your family just reached ${params.completionPct}% of ${bookTitle} on the Big Brain Shelf!`,
    "",
    `Want unlimited listening to every audiobook on the shelf, or quarterly hardcover Gift Set boxes delivered to your door?`,
    `• The Audio Club (${audioMonthly}/month or ${audioAnnual}/year): Stream every published audiobook in your library.`,
    `• The Book Club (${clubQuarterly}/quarter or ${clubAnnual}/year): Two printed books shipped every 3 months (Gift Set + a second book), the club book's digital bundle kept forever, and full-shelf read + listen access.`,
    "",
    `Explore the Clubs: ${site.replace(/\/$/, "")}/clubs`,
  ].join("\n");

  const now = Math.floor(Date.now() / 1000);
  try {
    await ensureOutboxColumns(db);
    await db
      .prepare(
        `INSERT INTO email_outbox
          (id, order_id, kind, to_email, subject, body_text, status, attempts, created_at, from_email)
         VALUES (?, NULL, 'revops_completion_upsell', ?, ?, ?, 'pending', 0, ?, ?)`
      )
      .bind(
        `out_ro_${now}_${Math.random().toString(36).slice(2, 8)}`,
        email,
        subject,
        bodyText,
        now,
        NEWS_EMAIL
      )
      .run();
  } catch {}

  await db
    .prepare(
      `INSERT INTO revops_lifecycle_events
        (id, user_id, email, event_kind, dedupe_key, fit_score, engagement_score, lifecycle_stage, metadata_json, created_at)
       VALUES (?, ?, ?, 'completion_80_upsell', ?, 35, 45, 'customer', ?, ?)
       ON CONFLICT(dedupe_key) DO NOTHING`
    )
    .bind(
      `ro_${now}_${Math.random().toString(36).slice(2, 8)}`,
      params.userId,
      email,
      dedupeKey,
      JSON.stringify({
        bookSlug: params.bookSlug,
        bookTitle,
        completionPct: params.completionPct,
        audioClubMonthlyCents: AUDIO_CLUB_PRICE_CENTS,
        bookClubQuarterlyCents: CLUB_PRICE_CENTS,
      }),
      now
    )
    .run();

  return { triggered: true };
}

// 3. Club Churn-Save & Upgrade Engine (`/api/club/retention`)
// Gives Book Club ($60/qtr or $199/yr) & Audio Club ($5.99/mo or $49/yr) members
// self-serve retention options before canceling:
//   - `skip_next_box`: Pushes a physical Book Club member's next cycle anchor out by 3 months
//   - `switch_to_audio_club`: Downsells a physical Book Club ($60/qtr) member to The Audio Club ($5.99/mo)
//   - `upgrade_to_annual`: Upgrades a quarterly/monthly member to Annual ($199/yr Book Club or $49/yr Audio Club)
export async function applyClubRetentionAction(
  db: DBLike,
  user: { id: string; email: string },
  action: ClubRetentionAction
): Promise<{
  ok: boolean;
  error?: string;
  action?: ClubRetentionAction;
  message?: string;
  updatedMember?: any;
}> {
  await ensureClubTable(db);
  await ensureRevOpsTables(db);
  const member = await getClubMembership(db, user);
  if (!member) {
    return { ok: false, error: "No active Club membership found for this account." };
  }

  const currentClubPlan = clubPlanOf(member);
  const now = Math.floor(Date.now() / 1000);
  const todayStr = chicagoDateString(new Date());
  let message = "";

  if (action === "skip_next_box") {
    if (currentClubPlan !== "physical") {
      return { ok: false, error: "Skip Next Box is only available for physical Book Club memberships." };
    }
    const baseAnchor = String(member.first_ship_date || todayStr);
    const nextAnchor = addMonthsToDateString(baseAnchor, 3);
    await db
      .prepare("UPDATE club_signups SET first_ship_date = ? WHERE id = ?")
      .bind(nextAnchor, member.id)
      .run();
    message = `Skipped your next quarterly box ($${(CLUB_PRICE_CENTS / 100).toFixed(0)}/quarter). Your next box anchor is now ${nextAnchor}, and your digital & audio shelf access stays active!`;
  } else if (action === "switch_to_audio_club") {
    await db
      .prepare("UPDATE club_signups SET club_plan = 'audio', plan = 'monthly' WHERE id = ?")
      .bind(member.id)
      .run();
    message = `Switched your membership to The Audio Club (${clubPriceLabel(AUDIO_CLUB_PRICE_CENTS)}/month). You keep full streaming access to every audiobook on the shelf without quarterly box shipments.`;
  } else if (action === "upgrade_to_annual") {
    await db
      .prepare("UPDATE club_signups SET plan = 'annual' WHERE id = ?")
      .bind(member.id)
      .run();
    const annualPrice =
      currentClubPlan === "audio"
        ? `$${(AUDIO_CLUB_ANNUAL_PRICE_CENTS / 100).toFixed(0)}/year`
        : `$${(CLUB_ANNUAL_PRICE_CENTS / 100).toFixed(0)}/year`;
    message = `Upgraded your ${currentClubPlan === "audio" ? "Audio Club" : "Book Club"} membership to the Annual Plan (${annualPrice})!`;
  } else {
    return { ok: false, error: "Unsupported retention action." };
  }

  const dedupeKey = `club_ret:${member.id}:${action}:${now}`;
  await db
    .prepare(
      `INSERT INTO revops_lifecycle_events
        (id, user_id, email, event_kind, dedupe_key, fit_score, engagement_score, lifecycle_stage, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, 40, 45, 'club_member', ?, ?)`
    )
    .bind(
      `ro_${now}_${Math.random().toString(36).slice(2, 8)}`,
      user.id,
      String(member.email || user.email),
      `club_${action}`,
      dedupeKey,
      JSON.stringify({ memberId: member.id, previousClubPlan: currentClubPlan, action }),
      now
    )
    .run();

  const updatedMember = await getClubMembership(db, user);
  return { ok: true, action, message, updatedMember };
}

// Executive & Pipeline RevOps Dashboard Summary for `/admin/revops`
export async function getRevOpsDashboardMetrics(db: DBLike): Promise<{
  offerLadder: {
    audiobookCents: number;
    digitalBundleCents: number;
    printedBookCents: number;
    giftSetCents: number;
    bookClubQuarterlyCents: number;
    bookClubAnnualCents: number;
    audioClubMonthlyCents: number;
    audioClubAnnualCents: number;
    birthdayCode: string;
  };
  clubMetrics: {
    physicalQuarterlyActive: number;
    physicalAnnualActive: number;
    audioMonthlyActive: number;
    audioAnnualActive: number;
    estimatedArrCents: number;
    estimatedMrrCents: number;
  };
  orderRevenueCents: number;
  completedOrdersCount: number;
  lifecycleCounts: Record<string, number>;
  recentLifecycleEvents: any[];
}> {
  await ensureRevOpsTables(db);
  await ensureClubTable(db);

  let physicalQuarterlyActive = 0;
  let physicalAnnualActive = 0;
  let audioMonthlyActive = 0;
  let audioAnnualActive = 0;

  try {
    const clubRes = await db.prepare("SELECT * FROM club_signups WHERE status = 'paid'").all();
    for (const m of (clubRes.results || (clubRes as any).rows || []) as any[]) {
      if (!clubMembershipActive(m)) continue;
      const cPlan = clubPlanOf(m);
      const billing = String(m.plan || "quarterly").toLowerCase();
      if (cPlan === "audio") {
        if (billing === "annual") audioAnnualActive++;
        else audioMonthlyActive++;
      } else {
        if (billing === "annual") physicalAnnualActive++;
        else physicalQuarterlyActive++;
      }
    }
  } catch {}

  // ARR math using exact constants from `src/lib/offers.ts`:
  // - Book Club Quarterly ($60 * 4 = $240/yr)
  // - Book Club Annual ($199/yr)
  // - Audio Club Monthly ($5.99 * 12 = $71.88/yr)
  // - Audio Club Annual ($49/yr)
  const estimatedArrCents =
    physicalQuarterlyActive * (CLUB_PRICE_CENTS * 4) +
    physicalAnnualActive * CLUB_ANNUAL_PRICE_CENTS +
    audioMonthlyActive * (AUDIO_CLUB_PRICE_CENTS * 12) +
    audioAnnualActive * AUDIO_CLUB_ANNUAL_PRICE_CENTS;
  const estimatedMrrCents = Math.round(estimatedArrCents / 12);

  let orderRevenueCents = 0;
  let completedOrdersCount = 0;
  try {
    const ordRow: any = await db
      .prepare("SELECT COUNT(*) as n, COALESCE(SUM(amount), 0) as rev FROM orders WHERE status = 'complete'")
      .first();
    completedOrdersCount = Number(ordRow?.n || 0);
    orderRevenueCents = Number(ordRow?.rev || 0);
  } catch {}

  const lifecycleCounts: Record<string, number> = {};
  let recentLifecycleEvents: any[] = [];
  try {
    const evRes = await db
      .prepare("SELECT * FROM revops_lifecycle_events ORDER BY created_at DESC LIMIT 30")
      .all();
    recentLifecycleEvents = (evRes.results || (evRes as any).rows || []) as any[];
    for (const ev of recentLifecycleEvents) {
      const k = String(ev.event_kind || "other");
      lifecycleCounts[k] = (lifecycleCounts[k] || 0) + 1;
    }
  } catch {}

  return {
    offerLadder: {
      audiobookCents: AUDIO_PRICE_CENTS,
      digitalBundleCents: STANDARD_DIGITAL_PRICE_CENTS,
      printedBookCents: STANDARD_PRINT_PRICE_CENTS,
      giftSetCents: GIFT_SET_PRICE_CENTS,
      bookClubQuarterlyCents: CLUB_PRICE_CENTS,
      bookClubAnnualCents: CLUB_ANNUAL_PRICE_CENTS,
      audioClubMonthlyCents: AUDIO_CLUB_PRICE_CENTS,
      audioClubAnnualCents: AUDIO_CLUB_ANNUAL_PRICE_CENTS,
      birthdayCode: "BDAY10",
    },
    clubMetrics: {
      physicalQuarterlyActive,
      physicalAnnualActive,
      audioMonthlyActive,
      audioAnnualActive,
      estimatedArrCents,
      estimatedMrrCents,
    },
    orderRevenueCents,
    completedOrdersCount,
    lifecycleCounts,
    recentLifecycleEvents,
  };
}
