import { ensureOnce } from "./schema-cache";
import { enqueueEmail, type DBLike } from "./orders";
import { catalogLeadName } from "./catalog";

export function chicagoDateString(date: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export const AGE_GROUPS = ["4-8", "9-12", "13-18"] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

export interface KidAvatarOption {
  id: string;
  name: string;
  label: string;
  color: string;
  bg: string;
  emoji: string;
  imagePath: string;
}

const KID_AVATAR_DEFS: readonly KidAvatarOption[] = [
  {
    id: "mira",
    name: "Mira",
    label: "Curious Explorer",
    color: "#b45309",
    bg: "#fef3c7",
    emoji: "🦊",
    imagePath: "/images/characters/mira.webp",
  },
  {
    id: "penny",
    name: "Penny",
    label: "Story Detective",
    color: "#9a3412",
    bg: "#ffedd5",
    emoji: "🦉",
    imagePath: "/images/characters/penny.webp",
  },
  {
    id: "fern",
    name: "Fenix",
    label: "Garden Dreamer",
    color: "#15803d",
    bg: "#dcfce7",
    emoji: "🌿",
    imagePath: "/images/characters/fern.webp",
  },
  {
    id: "wally",
    name: "Wells",
    label: "Gentle Giant",
    color: "#1d4ed8",
    bg: "#dbeafe",
    emoji: "🐻",
    imagePath: "/images/characters/wally.webp",
  },
  {
    id: "basil",
    name: "Blaze",
    label: "Night Sky Listener",
    color: "#6d28d9",
    bg: "#ede9fe",
    emoji: "🌙",
    imagePath: "/images/characters/basil.webp",
  },
] as const;

// Avatar names come from the catalog (src/data/catalog.json): a
// character rename updates the catalog and lands here on its own.
// The avatar ids are stable keys and never change.
const AVATAR_BOOK: Record<string, string> = {
  mira: "mira-the-heron-and-the-still-water",
  penny: "richdadpoordad",
  fern: "algorithms",
  wally: "docker",
  basil: "designpatterns",
};

export const KID_AVATARS: readonly KidAvatarOption[] = KID_AVATAR_DEFS.map((a) => {
  const book = AVATAR_BOOK[a.id];
  const lead = book ? catalogLeadName(book) : "";
  return lead ? { ...a, name: lead } : a;
});

export const CURRENT_TOPIC_OPTIONS = [
  { id: "tech", label: "Tech & How Computers Work" },
  { id: "money", label: "Money, Saving & Earning" },
  { id: "courage", label: "Courage & Speaking Up" },
] as const;

export const FUTURE_TOPIC_OPTIONS = [
  { id: "science", label: "Science & Nature" },
  { id: "history", label: "History & Biographies" },
  { id: "math", label: "Math & Logic Puzzles" },
  { id: "space", label: "Space & Engineering" },
  { id: "entrepreneurship", label: "Entrepreneurship & Makers" },
  { id: "art", label: "Art, Music & Creativity" },
  { id: "emotions", label: "Feelings & Kindness" },
] as const;

export const DISCOVERY_SOURCE_OPTIONS = [
  { id: "friend_referral", label: "A friend or family member" },
  { id: "instagram_social", label: "Instagram or social media" },
  { id: "search", label: "Google or web search" },
  { id: "gift", label: "Received a book as a gift" },
  { id: "school_community", label: "School, homeschool, or parent group" },
] as const;

export const SLEEP_TIMER_PRESETS = [
  { minutes: 0, label: "Off" },
  { minutes: 15, label: "15 min" },
  { minutes: 30, label: "30 min" },
  { minutes: 45, label: "45 min" },
  { minutes: 60, label: "60 min" },
  { minutes: -1, label: "End of chapter" },
] as const;

export const DAILY_LIMIT_PRESETS = [
  { minutes: 30, label: "30 min / day" },
  { minutes: 45, label: "45 min / day" },
  { minutes: 60, label: "60 min / day" },
  { minutes: 90, label: "90 min / day" },
  { minutes: 120, label: "2 hours / day" },
  { minutes: 0, label: "No daily limit" },
] as const;

export const READING_GOAL_OPTIONS = [
  { id: "bedtime_calm", label: "Calm bedtime wind-down" },
  { id: "read_along", label: "Read-along story & audio sync" },
  { id: "independent_reading", label: "Early independent reading (ages 4-8)" },
  { id: "coloring_creativity", label: "Screen-free coloring & activities" },
  { id: "road_trips", label: "Quiet car rides & afternoons" },
] as const;

export interface ParentOnboardingRecord {
  user_id: string;
  parent_name: string | null;
  family_nickname: string | null;
  discovery_source: string | null;
  reading_goals: string[];
  favorite_topics: string[];
  future_topics: string[];
  custom_topic_request: string | null;
  tos_accepted: boolean;
  tos_accepted_at: number | null;
  marketing_opt_in: boolean;
  referral_code: string;
  referred_by_code: string | null;
  notification_prefs: { new_releases: boolean; club_news: boolean; family_notes: boolean };
  parent_pin: string | null;
  onboarding_step: number;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface KidProfileRecord {
  id: string;
  user_id: string;
  name: string;
  handle: string | null;
  /** The child's own email, when they have one (CG, 2026-11-05). */
  email: string | null;
  birth_date: string | null;  birthday_gift_sent_year: number | null;
  age: number;
  age_group: AgeGroup;
  avatar_key: string;
  favorite_themes: string[];
  daily_limit_minutes: number;
  default_sleep_timer_minutes: number;
  bedtime_Cutoff: string | null;
  allow_audio_autoplay: boolean;
  allowed_book_slugs: string[];
  daily_minutes_used: number;
  daily_minutes_date: string | null;
  is_default: boolean;
  created_at: number;
  updated_at: number;
}

/** Short alias used by the account data layer. */
export type KidProfile = KidProfileRecord;

export type ReaderViewEdition = "story" | "coloring" | "fullcolor" | "cover" | "readalong";
export type ReaderViewMode = "flip" | "scroll";

export interface ReadingProgressRecord {
  id: string;
  user_id: string;
  profile_id: string;
  book_slug: string;
  chapter_num: number;
  page_index: number;
  view_edition: ReaderViewEdition;
  view_mode: ReaderViewMode;
  audio_track_id: string | null;
  audio_position_sec: number;
  audio_duration_sec: number;
  sync_enabled: boolean;
  updated_at: number;
}

export function classifyAgeGroup(age: number): AgeGroup {
  const n = Number.isFinite(age) ? Math.max(1, Math.min(18, Math.round(age))) : 6;
  if (n <= 8) return "4-8";
  if (n <= 12) return "9-12";
  return "13-18";
}

export function calculateAgeFromDob(
  birthDate: string | null | undefined,
  referenceDate: Date = new Date()
): number | null {
  if (!birthDate) return null;
  const match = String(birthDate).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  let age = referenceDate.getUTCFullYear() - year;
  const mDiff = referenceDate.getUTCMonth() + 1 - month;
  if (mDiff < 0 || (mDiff === 0 && referenceDate.getUTCDate() < day)) {
    age -= 1;
  }
  return Math.max(1, Math.min(18, age));
}

export function isBirthdayMonthAndDay(
  birthDate: string | null | undefined,
  todayStr: string = chicagoDateString()
): boolean {
  if (!birthDate) return false;
  const clean = String(birthDate).trim();
  const mmdd = clean.length >= 10 ? clean.slice(5, 10) : clean.slice(0, 5);
  return mmdd.length === 5 && todayStr.slice(5, 10) === mmdd;
}

export function generateReferralCode(seedName: string | null | undefined, userId: string): string {
  const alpha = String(seedName || "SHELF")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 6) || "SHELF";
  let hash = 0;
  const src = String(userId || "bbs");
  for (let i = 0; i < src.length; i++) {
    hash = (hash * 31 + src.charCodeAt(i)) >>> 0;
  }
  const suffix = (hash % 0xffff).toString(16).toUpperCase().padStart(4, "0");
  return `${alpha}-${suffix}`;
}

export function normalizePin(pin: string | null | undefined): string | null {
  if (!pin) return null;
  // The PIN is four digits, exactly (CG, 2026-11-05: the field used
  // to accept up to six, so "4-digit" pins of five or six digits
  // silently worked). Anything else is not a PIN.
  const digits = String(pin).replace(/\D/g, "");
  return digits.length === 4 ? digits : null;
}

export interface NotificationPrefs {
  new_releases: boolean;
  club_news: boolean;
  family_notes: boolean;
}

// Notification preferences (Settings page, 2026-11-01). Stored as
// JSON on the onboarding row. Defaults: club news and family notes
// on; new-release news follows the family's marketing opt-in until
// they set it here. Transactional mail (orders, shipping, billing)
// is never gated by these.
export async function getNotificationPrefsForUser(
  db: DBLike,
  userId: string
): Promise<NotificationPrefs> {
  const rec = await getParentOnboarding(db, userId).catch(() => null);
  if (rec) return rec.notification_prefs;
  // No onboarding row: no marketing opt-in on record, club and
  // family mail at their defaults.
  return { new_releases: false, club_news: true, family_notes: true };
}

// Prefs for an email address, or null when no account carries it
// (a newsletter subscriber who never signed up: their subscription
// itself is the opt-in, and the unsubscribe link governs them).
export async function getNotificationPrefsForEmail(
  db: DBLike,
  email: string
): Promise<NotificationPrefs | null> {
  const row: any = await db
    .prepare('SELECT id FROM "user" WHERE lower(email) = ? LIMIT 1')
    .bind(String(email || "").trim().toLowerCase())
    .first()
    .catch(() => null);
  if (!row?.id) return null;
  return getNotificationPrefsForUser(db, String(row.id));
}

export function parseNotificationPrefs(raw: unknown, marketingOptIn: boolean): NotificationPrefs {
  const defaults: NotificationPrefs = {
    new_releases: marketingOptIn,
    club_news: true,
    family_notes: true,
  };
  if (typeof raw !== "string" || !raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return {
      new_releases: typeof parsed.new_releases === "boolean" ? parsed.new_releases : defaults.new_releases,
      club_news: typeof parsed.club_news === "boolean" ? parsed.club_news : defaults.club_news,
      family_notes: typeof parsed.family_notes === "boolean" ? parsed.family_notes : defaults.family_notes,
    };
  } catch {
    return defaults;
  }
}

function parseJsonArray(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((v) => String(v)).filter(Boolean);
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map((v) => String(v)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const PARENT_ONBOARDING_ADDITIVE_COLS: Record<string, string> = {
  favorite_topics: "TEXT DEFAULT '[\"tech\",\"money\",\"courage\"]'",
  future_topics: "TEXT DEFAULT '[]'",
  custom_topic_request: "TEXT",
  tos_accepted: "INTEGER NOT NULL DEFAULT 0",
  tos_accepted_at: "INTEGER",
  marketing_opt_in: "INTEGER NOT NULL DEFAULT 0",
  referral_code: "TEXT",
  referred_by_code: "TEXT",
  notification_prefs: "TEXT",
};

const KID_PROFILES_ADDITIVE_COLS: Record<string, string> = {
  birth_date: "TEXT",
  birthday_gift_sent_year: "INTEGER",
  handle: "TEXT",
  email: "TEXT",
};

export async function ensureFamilyTables(db: DBLike): Promise<void> {
  return ensureOnce(db, "family_tables_v2", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS parent_onboarding (
           user_id TEXT PRIMARY KEY,
           parent_name TEXT,
           family_nickname TEXT,
           discovery_source TEXT,
           reading_goals TEXT,
           favorite_topics TEXT DEFAULT '["tech","money","courage"]',
           future_topics TEXT DEFAULT '[]',
           custom_topic_request TEXT,
           tos_accepted INTEGER NOT NULL DEFAULT 0,
           tos_accepted_at INTEGER,
           marketing_opt_in INTEGER NOT NULL DEFAULT 0,
           referral_code TEXT,
           referred_by_code TEXT,
           parent_pin TEXT,
           onboarding_step INTEGER NOT NULL DEFAULT 1,
           completed_at INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         )`
      )
      .bind()
      .run();

    const { results: poCols } = await db
      .prepare("PRAGMA table_info(parent_onboarding)")
      .bind()
      .all();
    const havePoCols = new Set(((poCols || []) as any[]).map((r) => String(r.name)));
    for (const [col, def] of Object.entries(PARENT_ONBOARDING_ADDITIVE_COLS)) {
      if (!havePoCols.has(col)) {
        try {
          await db.prepare(`ALTER TABLE parent_onboarding ADD COLUMN ${col} ${def}`).bind().run();
        } catch {
          // Column already present
        }
      }
    }

    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS kid_profiles (
           id TEXT PRIMARY KEY,
           user_id TEXT NOT NULL,
           name TEXT NOT NULL,
           birth_date TEXT,
           birthday_gift_sent_year INTEGER,
           age INTEGER NOT NULL DEFAULT 6,
           age_group TEXT NOT NULL DEFAULT '4-8',
           avatar_key TEXT NOT NULL DEFAULT 'mira',
           favorite_themes TEXT,
           daily_limit_minutes INTEGER NOT NULL DEFAULT 60,
           default_sleep_timer_minutes INTEGER NOT NULL DEFAULT 60,
           bedtime_cutoff TEXT,
           allow_audio_autoplay INTEGER NOT NULL DEFAULT 1,
           allowed_book_slugs TEXT,
           daily_minutes_used INTEGER NOT NULL DEFAULT 0,
           daily_minutes_date TEXT,
           is_default INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         )`
      )
      .bind()
      .run();

    const { results: kpCols } = await db
      .prepare("PRAGMA table_info(kid_profiles)")
      .bind()
      .all();
    const haveKpCols = new Set(((kpCols || []) as any[]).map((r) => String(r.name)));
    for (const [col, def] of Object.entries(KID_PROFILES_ADDITIVE_COLS)) {
      if (!haveKpCols.has(col)) {
        try {
          await db.prepare(`ALTER TABLE kid_profiles ADD COLUMN ${col} ${def}`).bind().run();
        } catch {
          // Column already present
        }
      }
    }

    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS reading_progress (
           id TEXT PRIMARY KEY,
           user_id TEXT NOT NULL,
           profile_id TEXT NOT NULL DEFAULT 'default',
           book_slug TEXT NOT NULL,
           chapter_num INTEGER NOT NULL DEFAULT 1,
           page_index INTEGER NOT NULL DEFAULT 0,
           view_edition TEXT NOT NULL DEFAULT 'story',
           view_mode TEXT NOT NULL DEFAULT 'flip',
           audio_track_id TEXT,
           audio_position_sec REAL NOT NULL DEFAULT 0,
           audio_duration_sec REAL NOT NULL DEFAULT 0,
           sync_enabled INTEGER NOT NULL DEFAULT 1,
           updated_at INTEGER NOT NULL,
           UNIQUE(user_id, profile_id, book_slug)
         )`
      )
      .bind()
      .run();

    const indexes = [
      "CREATE INDEX IF NOT EXISTS kid_profiles_user_idx ON kid_profiles(user_id, created_at)",
      "CREATE INDEX IF NOT EXISTS reading_progress_user_idx ON reading_progress(user_id, profile_id, updated_at)",
    ];
    for (const sql of indexes) {
      try {
        await db.prepare(sql).bind().run();
      } catch {
        // Index guard
      }
    }
  });
}

function hydrateParentOnboarding(row: any): ParentOnboardingRecord {
  const userId = String(row.user_id);
  const parentName = row.parent_name ? String(row.parent_name) : null;
  const favTopics = parseJsonArray(row.favorite_topics);
  return {
    user_id: userId,
    parent_name: parentName,
    family_nickname: row.family_nickname ? String(row.family_nickname) : null,
    discovery_source: row.discovery_source ? String(row.discovery_source) : null,
    reading_goals: parseJsonArray(row.reading_goals),
    favorite_topics: favTopics.length > 0 ? favTopics : ["tech", "money", "courage"],
    future_topics: parseJsonArray(row.future_topics),
    custom_topic_request: row.custom_topic_request ? String(row.custom_topic_request) : null,
    tos_accepted: Number(row.tos_accepted || 0) !== 0,
    tos_accepted_at: row.tos_accepted_at ? Number(row.tos_accepted_at) : null,
    marketing_opt_in: Number(row.marketing_opt_in || 0) !== 0,
    referral_code: row.referral_code
      ? String(row.referral_code)
      : generateReferralCode(parentName, userId),
    referred_by_code: row.referred_by_code ? String(row.referred_by_code) : null,
    notification_prefs: parseNotificationPrefs(row.notification_prefs, Number(row.marketing_opt_in || 0) !== 0),
    parent_pin: row.parent_pin ? String(row.parent_pin) : null,
    onboarding_step: Number(row.onboarding_step || 1),
    completed_at: row.completed_at ? Number(row.completed_at) : null,
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  };
}

function hydrateKidProfile(row: any, today: string): KidProfileRecord {
  const sameDay = row.daily_minutes_date === today;
  const birthDate = row.birth_date ? String(row.birth_date) : null;
  const dobAge = calculateAgeFromDob(birthDate);
  const age = dobAge ?? Number(row.age || 6);
  const rawGroup = String(row.age_group || "");
  const ageGroup: AgeGroup = (AGE_GROUPS as readonly string[]).includes(rawGroup)
    ? (rawGroup as AgeGroup)
    : classifyAgeGroup(age);
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    name: String(row.name || "Reader"),
    handle: row.handle ? String(row.handle) : null,
    email: row.email ? String(row.email) : null,
    birth_date: birthDate,
    birthday_gift_sent_year: row.birthday_gift_sent_year
      ? Number(row.birthday_gift_sent_year)
      : null,
    age,
    age_group: ageGroup,
    avatar_key: String(row.avatar_key || "mira"),
    favorite_themes: parseJsonArray(row.favorite_themes),
    daily_limit_minutes: Number.isFinite(Number(row.daily_limit_minutes))
      ? Number(row.daily_limit_minutes)
      : 60,
    default_sleep_timer_minutes: Number.isFinite(Number(row.default_sleep_timer_minutes))
      ? Number(row.default_sleep_timer_minutes)
      : 60,
    bedtime_Cutoff: row.bedtime_cutoff ? String(row.bedtime_cutoff) : null,
    allow_audio_autoplay: Number(row.allow_audio_autoplay ?? 1) !== 0,
    allowed_book_slugs: parseJsonArray(row.allowed_book_slugs),
    daily_minutes_used: sameDay ? Math.max(0, Number(row.daily_minutes_used || 0)) : 0,
    daily_minutes_date: today,
    is_default: Number(row.is_default || 0) !== 0,
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  };
}

function hydrateReadingProgress(row: any): ReadingProgressRecord {
  const ed = String(row.view_edition || "story");
  const validEd: ReaderViewEdition =
    ed === "coloring" || ed === "fullcolor" || ed === "cover" || ed === "readalong"
      ? ed
      : "story";
  const mode = String(row.view_mode || "flip") === "scroll" ? "scroll" : "flip";
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    profile_id: String(row.profile_id || "default"),
    book_slug: String(row.book_slug),
    chapter_num: Math.max(1, Number(row.chapter_num || 1)),
    page_index: Math.max(0, Number(row.page_index || 0)),
    view_edition: validEd,
    view_mode: mode,
    audio_track_id: row.audio_track_id ? String(row.audio_track_id) : null,
    audio_position_sec: Math.max(0, Number(row.audio_position_sec || 0)),
    audio_duration_sec: Math.max(0, Number(row.audio_duration_sec || 0)),
    sync_enabled: Number(row.sync_enabled ?? 1) !== 0,
    updated_at: Number(row.updated_at || 0),
  };
}

export function computeOnboardingChecklist(
  onboarding: ParentOnboardingRecord | null,
  kidProfiles: KidProfileRecord[],
  progressList: ReadingProgressRecord[]
) {
  const hasParentInfo = Boolean(
    onboarding &&
      (onboarding.parent_name ||
        onboarding.family_nickname ||
        onboarding.reading_goals.length > 0 ||
        onboarding.future_topics.length > 0 ||
        onboarding.tos_accepted ||
        onboarding.completed_at)
  );
  const hasKidProfile = kidProfiles.length > 0;
  const hasStartedReading = progressList.length > 0 || Boolean(onboarding?.completed_at);

  // Endowed progress: account creation itself starts the family at 25% complete.
  const steps = [
    { id: "account", label: "Parent account ready", done: true },
    { id: "family", label: "Tell us what topics your family wants to learn", done: hasParentInfo },
    { id: "kid_profile", label: "Create your child's reader profile, birthday & sleep timer", done: hasKidProfile },
    { id: "first_story", label: "Open a storybook or start Read-Along Theater", done: hasStartedReading },
  ];
  const completedCount = steps.filter((s) => s.done).length;
  const percent = Math.round((completedCount / steps.length) * 100);
  return {
    percent,
    isComplete: Boolean(onboarding?.completed_at) || (hasParentInfo && hasKidProfile && Boolean(onboarding?.tos_accepted)),
    steps,
  };
}

export async function getParentOnboarding(
  db: DBLike,
  userId: string
): Promise<ParentOnboardingRecord | null> {
  if (!userId) return null;
  await ensureFamilyTables(db);
  const row = await db
    .prepare("SELECT * FROM parent_onboarding WHERE user_id = ?")
    .bind(userId)
    .first();
  return row ? hydrateParentOnboarding(row) : null;
}

export interface SaveParentOnboardingInput {
  parent_name?: string | null;
  family_nickname?: string | null;
  discovery_source?: string | null;
  reading_goals?: string[];
  favorite_topics?: string[];
  future_topics?: string[];
  custom_topic_request?: string | null;
  tos_accepted?: boolean;
  marketing_opt_in?: boolean;
  referred_by_code?: string | null;
  parent_pin?: string | null;
  onboarding_step?: number;
  mark_complete?: boolean;
}

export function buildFamilyWelcomeEmailText(opts: {
  parentName: string | null;
  familyNickname: string | null;
  kidName: string | null;
  sleepMinutes: number;
  futureTopics?: string[];
  referralCode?: string;
  site: string;
}): { subject: string; bodyText: string } {
  const greetingName = opts.parentName?.trim() || "there";
  const kidPart = opts.kidName?.trim()
    ? `${opts.kidName.trim()}'s reader profile is ready`
    : "Your family shelf is set up";
  const sleepLabel =
    opts.sleepMinutes === -1
      ? "at the end of the chapter"
      : opts.sleepMinutes > 0
        ? `after ${opts.sleepMinutes} minutes`
        : "whenever you pause it";

  // Only ids from the option registry may render. The wizard once
  // sent the literal string "on" for every checked topic (its
  // checkboxes carried no value), and the fallback printed that raw
  // into a family's welcome email (CG, 2026-11-05).
  const futureLabels = (opts.futureTopics || [])
    .map((id) => FUTURE_TOPIC_OPTIONS.find((o) => o.id === id)?.label)
    .filter((label): label is string => Boolean(label));

  const subject = opts.kidName?.trim()
    ? `${opts.kidName.trim()}'s Big Brain Shelf is ready for story time`
    : "Your family shelf is ready on Big Brain Shelf";

  const paragraphs = [
    `Hi ${greetingName},`,
    `${kidPart} on Big Brain Shelf. You can open Read-Along Theater mode to watch the full-color storybook flip pages automatically above the audiobook player, or switch between the story, coloring pages, and cover any time.`,
    `We set your default audiobook sleep timer to turn off gently ${sleepLabel}, so bedtime listening stays calm and automatic.`,
  ];

  if (futureLabels.length > 0) {
    paragraphs.push(
      `We also noted the future topics your family wants to explore next (${futureLabels.join(", ")}). We use your picks to decide which shelves go into illustration next.`
    );
  }

  paragraphs.push(
    `Open your family shelf here: ${opts.site.replace(/\/$/, "")}/account`
  );

  if (opts.referralCode) {
    paragraphs.push(
      `Want to share Big Brain Shelf with another family? Your family referral link is ${opts.site.replace(/\/$/, "")}/?ref=${opts.referralCode} (your friend gets $10 toward their first Gift Set, and you get $10 shelf credit).`
    );
  }

  return { subject, bodyText: paragraphs.join("\n\n") };
}

export function buildBirthdayGiftEmailText(opts: {
  parentName: string | null;
  kidName: string;
  avatarKey: string;
  age: number;
  site: string;
}): { subject: string; bodyText: string } {
  const buddy = KID_AVATARS.find((a) => a.id === opts.avatarKey) || KID_AVATARS[0];
  const parentGreeting = opts.parentName?.trim() || "Friend";
  const kidName = opts.kidName.trim() || "your reader";
  const subject = `Happy Birthday to ${kidName} from ${buddy.name} and Big Brain Shelf`;
  const bodyText = [
    `Hi ${parentGreeting},`,
    `${buddy.name} (${buddy.label}) and the whole Big Brain Shelf cast are wishing ${kidName} the happiest birthday today!`,
    `We put a birthday gift in your family library: open your shelf to unlock ${kidName}'s birthday coloring & activity pages, start Read-Along Theater in full color, and use code BDAY10 for $10 toward your next Printed Book or Gift Set.`,
    `Claim ${kidName}'s birthday surprise here: ${opts.site.replace(/\/$/, "")}/account?gift=birthday`,
  ].join("\n\n");
  return { subject, bodyText };
}

async function ensureEmailOutboxTable(db: DBLike): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS email_outbox (
         id TEXT PRIMARY KEY,
         order_id TEXT,
         kind TEXT NOT NULL,
         to_email TEXT NOT NULL,
         subject TEXT NOT NULL,
         body_text TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'pending',
         attempts INTEGER NOT NULL DEFAULT 0,
         last_error TEXT,
         created_at INTEGER NOT NULL,
         sent_at INTEGER,
         send_after INTEGER,
         from_email TEXT,
         dedupe_key TEXT,
         club_box_id TEXT,
         reply_to TEXT
       )`
    )
    .bind()
    .run();
}

export async function enqueueBirthdayGiftEmail(
  db: DBLike,
  userId: string,
  userEmail: string,
  kid: KidProfileRecord,
  site = "https://bigbrainshelf.com"
): Promise<boolean> {
  if (!userEmail || !kid?.id) return false;
  await ensureFamilyTables(db);
  await ensureEmailOutboxTable(db);
  const onboarding = await getParentOnboarding(db, userId);
  const year = new Date().getUTCFullYear();
  const { subject, bodyText } = buildBirthdayGiftEmailText({
    parentName: onboarding?.parent_name ?? null,
    kidName: kid.name,
    avatarKey: kid.avatar_key,
    age: kid.age,
    site,
  });
  await enqueueEmail(db, {
    orderId: null,
    to: userEmail,
    subject,
    text: bodyText,
    kind: "birthday_gift",
    dedupeKey: `birthday_gift:${kid.id}:${year}`,
  });
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare("UPDATE kid_profiles SET birthday_gift_sent_year = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(year, now, kid.id, userId)
    .run();
  return true;
}

export async function saveParentOnboarding(
  db: DBLike,
  userId: string,
  userEmail: string | null,
  input: SaveParentOnboardingInput,
  site = "https://bigbrainshelf.com"
): Promise<ParentOnboardingRecord> {
  await ensureFamilyTables(db);
  const existing = await getParentOnboarding(db, userId);
  const now = Math.floor(Date.now() / 1000);

  const parentName =
    input.parent_name !== undefined
      ? (input.parent_name ? String(input.parent_name).trim().slice(0, 80) : null)
      : (existing?.parent_name ?? null);
  const familyNickname =
    input.family_nickname !== undefined
      ? (input.family_nickname ? String(input.family_nickname).trim().slice(0, 80) : null)
      : (existing?.family_nickname ?? null);
  const discoverySourceRaw =
    input.discovery_source !== undefined
      ? (input.discovery_source ? String(input.discovery_source).trim().slice(0, 80) : null)
      : (existing?.discovery_source ?? null);
  // Only a registered discovery id is stored; free text (an old
  // client once submitted the option labels) clears to null.
  const discoverySource =
    discoverySourceRaw &&
    (DISCOVERY_SOURCE_OPTIONS as readonly { id: string }[]).some((o) => o.id === discoverySourceRaw)
      ? discoverySourceRaw
      : null;
  // Topic and goal lists keep only ids from their option
  // registries, deduped. A client that submits anything else (the
  // wizard's value-less checkboxes sent "on") can no longer store
  // or email garbage picks.
  const sanitizeIds = (
    values: string[],
    options: readonly { id: string }[],
    cap: number
  ): string[] => {
    const allowed = new Set(options.map((o) => o.id));
    const out: string[] = [];
    for (const v of values) {
      const id = String(v).trim();
      if (allowed.has(id) && !out.includes(id)) out.push(id);
      if (out.length >= cap) break;
    }
    return out;
  };
  const readingGoals =
    input.reading_goals !== undefined
      ? sanitizeIds(input.reading_goals, READING_GOAL_OPTIONS, 10)
      : (existing?.reading_goals ?? []);
  const favoriteTopics =
    input.favorite_topics !== undefined
      ? sanitizeIds(input.favorite_topics, CURRENT_TOPIC_OPTIONS, 10)
      : (existing?.favorite_topics ?? ["tech", "money", "courage"]);
  const futureTopics =
    input.future_topics !== undefined
      ? sanitizeIds(input.future_topics, FUTURE_TOPIC_OPTIONS, 15)
      : (existing?.future_topics ?? []);
  const customTopicRequest =
    input.custom_topic_request !== undefined
      ? (input.custom_topic_request ? String(input.custom_topic_request).trim().slice(0, 240) : null)
      : (existing?.custom_topic_request ?? null);
  const tosAccepted =
    input.tos_accepted !== undefined
      ? Boolean(input.tos_accepted)
      : (existing?.tos_accepted ?? false);
  const tosAcceptedAt = tosAccepted
    ? (existing?.tos_accepted_at ?? now)
    : (existing?.tos_accepted_at ?? null);
  const marketingOptIn =
    input.marketing_opt_in !== undefined
      ? Boolean(input.marketing_opt_in)
      : (existing?.marketing_opt_in ?? false);
  const referralCode =
    existing?.referral_code || generateReferralCode(parentName || familyNickname, userId);
  const referredByCode =
    input.referred_by_code !== undefined
      ? (input.referred_by_code ? String(input.referred_by_code).trim().toUpperCase().slice(0, 32) : null)
      : (existing?.referred_by_code ?? null);
  const parentPin =
    input.parent_pin !== undefined
      ? normalizePin(input.parent_pin)
      : (existing?.parent_pin ?? null);
  const step =
    input.onboarding_step !== undefined
      ? Math.max(1, Math.min(4, Number(input.onboarding_step)))
      : (existing?.onboarding_step ?? 1);
  const completedAt = input.mark_complete
    ? (existing?.completed_at ?? now)
    : (existing?.completed_at ?? null);

  await db
    .prepare(
      `INSERT INTO parent_onboarding
         (user_id, parent_name, family_nickname, discovery_source, reading_goals, favorite_topics, future_topics, custom_topic_request, tos_accepted, tos_accepted_at, marketing_opt_in, referral_code, referred_by_code, parent_pin, onboarding_step, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         parent_name = excluded.parent_name,
         family_nickname = excluded.family_nickname,
         discovery_source = excluded.discovery_source,
         reading_goals = excluded.reading_goals,
         favorite_topics = excluded.favorite_topics,
         future_topics = excluded.future_topics,
         custom_topic_request = excluded.custom_topic_request,
         tos_accepted = excluded.tos_accepted,
         tos_accepted_at = excluded.tos_accepted_at,
         marketing_opt_in = excluded.marketing_opt_in,
         referral_code = excluded.referral_code,
         referred_by_code = excluded.referred_by_code,
         parent_pin = excluded.parent_pin,
         onboarding_step = excluded.onboarding_step,
         completed_at = excluded.completed_at,
         updated_at = excluded.updated_at`
    )
    .bind(
      userId,
      parentName,
      familyNickname,
      discoverySource,
      JSON.stringify(readingGoals),
      JSON.stringify(favoriteTopics),
      JSON.stringify(futureTopics),
      customTopicRequest,
      tosAccepted ? 1 : 0,
      tosAcceptedAt,
      marketingOptIn ? 1 : 0,
      referralCode,
      referredByCode,
      parentPin,
      step,
      completedAt,
      existing?.created_at ?? now,
      now
    )
    .run();

  // If the parent opted into marketing emails, record them in newsletter_subscribers too.
  if (marketingOptIn && userEmail) {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS newsletter_subscribers (
             email TEXT PRIMARY KEY,
             source TEXT NOT NULL DEFAULT 'footer',
             created_at INTEGER NOT NULL
           )`
        )
        .bind()
        .run();
      await db
        .prepare(
          "INSERT OR IGNORE INTO newsletter_subscribers (email, source, created_at) VALUES (?, 'family_onboarding', ?)"
        )
        .bind(userEmail.toLowerCase().trim(), now)
        .run();
    } catch {
      // Non-blocking
    }
  }

  if (input.mark_complete && !existing?.completed_at && userEmail) {
    try {
      await ensureEmailOutboxTable(db);
      const kids = await listKidProfiles(db, userId);
      const firstKid = kids[0] || null;
      const { subject, bodyText } = buildFamilyWelcomeEmailText({
        parentName,
        familyNickname,
        kidName: firstKid?.name ?? null,
        sleepMinutes: firstKid?.default_sleep_timer_minutes ?? 60,
        futureTopics,
        referralCode,
        site,
      });
      await enqueueEmail(db, {
        orderId: null,
        to: userEmail,
        subject,
        text: bodyText,
        kind: "family_onboarding",
        dedupeKey: `family_onboarding:${userId}`,
      });

      // If the child's birthday is today, also enqueue their Birthday Gift Email!
      if (firstKid && isBirthdayMonthAndDay(firstKid.birth_date)) {
        await enqueueBirthdayGiftEmail(db, userId, userEmail, firstKid, site);
      }
    } catch {
      // Never block onboarding save if email outbox fails
    }
  }

  return (await getParentOnboarding(db, userId))!;
}

export async function verifyParentPin(
  db: DBLike,
  userId: string,
  candidatePin: string
): Promise<boolean> {
  const onboarding = await getParentOnboarding(db, userId);
  if (!onboarding || !onboarding.parent_pin) {
    // If no PIN has been configured yet, allow access so the parent isn't locked out.
    return true;
  }
  const candidate = String(candidatePin || "").trim();
  // Raw comparison first so a legacy longer PIN saved before the
  // strict four-digit rule keeps working; then the normalized one.
  return onboarding.parent_pin === candidate || normalizePin(candidate) === onboarding.parent_pin;
}

export async function listKidProfiles(
  db: DBLike,
  userId: string
): Promise<KidProfileRecord[]> {
  if (!userId) return [];
  await ensureFamilyTables(db);
  const today = chicagoDateString();
  const { results } = await db
    .prepare("SELECT * FROM kid_profiles WHERE user_id = ? ORDER BY is_default DESC, created_at ASC")
    .bind(userId)
    .all();
  return ((results || []) as any[]).map((r) => hydrateKidProfile(r, today));
}

export interface UpsertKidProfileInput {
  id?: string;
  name: string;
  handle?: string | null;
  email?: string | null;
  birth_date?: string | null;
  age?: number;
  age_group?: AgeGroup;
  avatar_key?: string;
  favorite_themes?: string[];
  daily_limit_minutes?: number;
  default_sleep_timer_minutes?: number;
  bedtime_cutoff?: string | null;
  allow_audio_autoplay?: boolean;
  allowed_book_slugs?: string[];
  is_default?: boolean;
}

export async function upsertKidProfile(
  db: DBLike,
  userId: string,
  input: UpsertKidProfileInput
): Promise<KidProfileRecord> {
  await ensureFamilyTables(db);
  const now = Math.floor(Date.now() / 1000);
  const today = chicagoDateString();
  const existingProfiles = await listKidProfiles(db, userId);

  // No explicit id means "create", but a re-save of the same child
  // must update, not duplicate: the onboarding wizard sent no id,
  // so finishing setup twice made two copies of the same kid (CG,
  // 2026-11-05). Match on the handle when one is set, else on
  // name + birthday.
  const requestedId = input.id && String(input.id).trim() ? String(input.id).trim() : null;
  let dedupeMatch: KidProfileRecord | null = null;
  if (!requestedId) {
    const wantedHandle = String(input.handle || "")
      .trim()
      .replace(/^@+/, "")
      .toLowerCase();
    const wantedName = String(input.name || "").trim().toLowerCase();
    const wantedDob = input.birth_date ? String(input.birth_date).trim().slice(0, 16) : null;
    dedupeMatch =
      existingProfiles.find((p) => wantedHandle !== "" && p.handle === wantedHandle) ||
      existingProfiles.find(
        (p) =>
          wantedDob !== null &&
          p.birth_date === wantedDob &&
          p.name.trim().toLowerCase() === wantedName
      ) ||
      null;
  }
  const id = requestedId || dedupeMatch?.id || crypto.randomUUID();
  const current = existingProfiles.find((p) => p.id === id) || null;

  const cleanName = String(input.name || current?.name || "Reader").trim().slice(0, 40) || "Reader";
  // Optional public handle for the child (CG's onboarding model:
  // @rubyjoyhs). Same format rules as account usernames; an invalid
  // or empty value clears to null rather than failing the save.
  const handle =
    input.handle !== undefined
      ? (() => {
          const h = String(input.handle || "").trim().replace(/^@+/, "").toLowerCase();
          return /^[a-z0-9_.]{3,30}$/.test(h) ? h : null;
        })()
      : (current?.handle ?? null);
  // The child's own email, when they have one; an invalid or empty
  // value clears to null rather than failing the save (same rule
  // as the handle).
  const email =
    input.email !== undefined
      ? (() => {
          const em = String(input.email || "").trim().toLowerCase().slice(0, 120);
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) ? em : null;
        })()
      : (current?.email ?? null);
  const birthDate =
    input.birth_date !== undefined
      ? (input.birth_date ? String(input.birth_date).trim().slice(0, 16) : null)
      : (current?.birth_date ?? null);
  const dobAge = calculateAgeFromDob(birthDate);
  const age =
    dobAge !== null
      ? dobAge
      : Number.isFinite(Number(input.age))
        ? Math.max(1, Math.min(18, Math.round(Number(input.age))))
        : (current?.age ?? 6);
  const ageGroup: AgeGroup =
    input.age_group && (AGE_GROUPS as readonly string[]).includes(input.age_group)
      ? input.age_group
      : classifyAgeGroup(age);
  const validAvatarIds = new Set(KID_AVATARS.map((a) => a.id));
  const avatarKey =
    input.avatar_key && validAvatarIds.has(input.avatar_key)
      ? input.avatar_key
      : (current?.avatar_key ?? "mira");

  const favoriteThemes =
    input.favorite_themes !== undefined
      ? input.favorite_themes.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
      : (current?.favorite_themes ?? []);

  const dailyLimitMinutes =
    input.daily_limit_minutes !== undefined
      ? Math.max(0, Math.min(480, Math.round(Number(input.daily_limit_minutes))))
      : (current?.daily_limit_minutes ?? 60);

  const defaultSleepTimerMinutes =
    input.default_sleep_timer_minutes !== undefined
      ? Number(input.default_sleep_timer_minutes)
      : (current?.default_sleep_timer_minutes ?? 60);

  const bedtimeCutoff =
    input.bedtime_cutoff !== undefined
      ? (input.bedtime_cutoff ? String(input.bedtime_cutoff).trim().slice(0, 10) : null)
      : (current?.bedtime_Cutoff ?? null);

  const allowAudioAutoplay =
    input.allow_audio_autoplay !== undefined
      ? Boolean(input.allow_audio_autoplay)
      : (current?.allow_audio_autoplay ?? true);

  const allowedBookSlugs =
    input.allowed_book_slugs !== undefined
      ? input.allowed_book_slugs.map((s) => String(s).trim()).filter(Boolean)
      : (current?.allowed_book_slugs ?? []);

  const isDefault =
    input.is_default !== undefined
      ? Boolean(input.is_default)
      : existingProfiles.length === 0
        ? true
        : (current?.is_default ?? false);

  if (isDefault) {
    await db
      .prepare("UPDATE kid_profiles SET is_default = 0 WHERE user_id = ?")
      .bind(userId)
      .run();
  }

  await db
    .prepare(
      `INSERT INTO kid_profiles
         (id, user_id, name, handle, email, birth_date, birthday_gift_sent_year, age, age_group, avatar_key, favorite_themes, daily_limit_minutes, default_sleep_timer_minutes, bedtime_cutoff, allow_audio_autoplay, allowed_book_slugs, daily_minutes_used, daily_minutes_date, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         handle = excluded.handle,
         email = excluded.email,
         birth_date = excluded.birth_date,
         age = excluded.age,
         age_group = excluded.age_group,
         avatar_key = excluded.avatar_key,
         favorite_themes = excluded.favorite_themes,
         daily_limit_minutes = excluded.daily_limit_minutes,
         default_sleep_timer_minutes = excluded.default_sleep_timer_minutes,
         bedtime_cutoff = excluded.bedtime_cutoff,
         allow_audio_autoplay = excluded.allow_audio_autoplay,
         allowed_book_slugs = excluded.allowed_book_slugs,
         is_default = excluded.is_default,
         updated_at = excluded.updated_at`
    )
    .bind(
      id,
      userId,
      cleanName,
      handle,
      email,
      birthDate,
      current?.birthday_gift_sent_year ?? null,
      age,
      ageGroup,
      avatarKey,
      JSON.stringify(favoriteThemes),
      dailyLimitMinutes,
      defaultSleepTimerMinutes,
      bedtimeCutoff,
      allowAudioAutoplay ? 1 : 0,
      JSON.stringify(allowedBookSlugs),
      current?.daily_minutes_used ?? 0,
      today,
      isDefault ? 1 : 0,
      current?.created_at ?? now,
      now
    )
    .run();

  const updated = await listKidProfiles(db, userId);
  return updated.find((p) => p.id === id) || updated[0];
}

/**
 * Is this @handle already carried by a child profile (any family's)?
 * Kid handles are sign-in identities alongside account usernames, so
 * they share one namespace; the caller checks account usernames via
 * checkUsernameAvailabilityInDb and kid handles here. The profile
 * being edited may keep its own handle (excludeProfileId).
 */
export async function isKidHandleTaken(
  db: DBLike,
  handle: string,
  excludeProfileId?: string | null
): Promise<boolean> {
  const h = String(handle || "").trim().replace(/^@+/, "").toLowerCase();
  if (!h) return false;
  await ensureFamilyTables(db);
  const row = (await db
    .prepare("SELECT id FROM kid_profiles WHERE lower(handle) = ? LIMIT 1")
    .bind(h)
    .first()) as any;
  if (!row) return false;
  return String(row.id) !== String(excludeProfileId || "");
}

export async function deleteKidProfile(
  db: DBLike,
  userId: string,
  profileId: string
): Promise<void> {
  await ensureFamilyTables(db);
  await db
    .prepare("DELETE FROM kid_profiles WHERE id = ? AND user_id = ?")
    .bind(profileId, userId)
    .run();
}

export async function listReadingProgress(
  db: DBLike,
  userId: string,
  profileId?: string
): Promise<ReadingProgressRecord[]> {
  if (!userId) return [];
  await ensureFamilyTables(db);
  if (profileId) {
    const { results } = await db
      .prepare(
        "SELECT * FROM reading_progress WHERE user_id = ? AND profile_id = ? ORDER BY updated_at DESC"
      )
      .bind(userId, profileId)
      .all();
    return ((results || []) as any[]).map(hydrateReadingProgress);
  }
  const { results } = await db
    .prepare("SELECT * FROM reading_progress WHERE user_id = ? ORDER BY updated_at DESC")
    .bind(userId)
    .all();
  return ((results || []) as any[]).map(hydrateReadingProgress);
}

export async function getReadingProgress(
  db: DBLike,
  userId: string,
  profileId: string,
  bookSlug: string
): Promise<ReadingProgressRecord | null> {
  if (!userId || !bookSlug) return null;
  await ensureFamilyTables(db);
  const row = await db
    .prepare(
      "SELECT * FROM reading_progress WHERE user_id = ? AND profile_id = ? AND book_slug = ?"
    )
    .bind(userId, profileId || "default", bookSlug)
    .first();
  return row ? hydrateReadingProgress(row) : null;
}

export interface SaveReadingProgressInput {
  profile_id?: string;
  book_slug: string;
  chapter_num?: number;
  page_index?: number;
  view_edition?: ReaderViewEdition;
  view_mode?: ReaderViewMode;
  audio_track_id?: string | null;
  audio_position_sec?: number;
  audio_duration_sec?: number;
  sync_enabled?: boolean;
  elapsed_minutes_delta?: number;
}

export async function saveReadingProgress(
  db: DBLike,
  userId: string,
  input: SaveReadingProgressInput
): Promise<{
  progress: ReadingProgressRecord;
  limitReached: boolean;
  remainingMinutes: number | null;
}> {
  await ensureFamilyTables(db);
  const profileId = String(input.profile_id || "default").trim() || "default";
  const bookSlug = String(input.book_slug || "").trim();
  if (!bookSlug) {
    throw new Error("book_slug is required");
  }
  const existing = await getReadingProgress(db, userId, profileId, bookSlug);
  const now = Math.floor(Date.now() / 1000);
  const id = existing?.id || `${userId}:${profileId}:${bookSlug}`;

  const chapterNum =
    input.chapter_num !== undefined
      ? Math.max(1, Math.round(Number(input.chapter_num)))
      : (existing?.chapter_num ?? 1);
  const pageIndex =
    input.page_index !== undefined
      ? Math.max(0, Math.round(Number(input.page_index)))
      : (existing?.page_index ?? 0);
  const viewEdition: ReaderViewEdition =
    input.view_edition &&
    ["story", "coloring", "fullcolor", "cover", "readalong"].includes(input.view_edition)
      ? input.view_edition
      : (existing?.view_edition ?? "story");
  const viewMode: ReaderViewMode =
    input.view_mode === "scroll" || input.view_mode === "flip"
      ? input.view_mode
      : (existing?.view_mode ?? "flip");
  const audioTrackId =
    input.audio_track_id !== undefined
      ? (input.audio_track_id ? String(input.audio_track_id) : null)
      : (existing?.audio_track_id ?? null);
  const audioPositionSec =
    input.audio_position_sec !== undefined
      ? Math.max(0, Number(input.audio_position_sec))
      : (existing?.audio_position_sec ?? 0);
  const audioDurationSec =
    input.audio_duration_sec !== undefined
      ? Math.max(0, Number(input.audio_duration_sec))
      : (existing?.audio_duration_sec ?? 0);
  const syncEnabled =
    input.sync_enabled !== undefined
      ? Boolean(input.sync_enabled)
      : (existing?.sync_enabled ?? true);

  await db
    .prepare(
      `INSERT INTO reading_progress
         (id, user_id, profile_id, book_slug, chapter_num, page_index, view_edition, view_mode, audio_track_id, audio_position_sec, audio_duration_sec, sync_enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, profile_id, book_slug) DO UPDATE SET
         chapter_num = excluded.chapter_num,
         page_index = excluded.page_index,
         view_edition = excluded.view_edition,
         view_mode = excluded.view_mode,
         audio_track_id = excluded.audio_track_id,
         audio_position_sec = excluded.audio_position_sec,
         audio_duration_sec = excluded.audio_duration_sec,
         sync_enabled = excluded.sync_enabled,
         updated_at = excluded.updated_at`
    )
    .bind(
      id,
      userId,
      profileId,
      bookSlug,
      chapterNum,
      pageIndex,
      viewEdition,
      viewMode,
      audioTrackId,
      audioPositionSec,
      audioDurationSec,
      syncEnabled ? 1 : 0,
      now
    )
    .run();

  let limitReached = false;
  let remainingMinutes: number | null = null;

  if (profileId !== "default") {
    const profiles = await listKidProfiles(db, userId);
    const activeProfile = profiles.find((p) => p.id === profileId);
    if (activeProfile) {
      const today = chicagoDateString();
      const delta = Math.max(0, Math.min(30, Number(input.elapsed_minutes_delta || 0)));
      const used = Math.round((activeProfile.daily_minutes_used + delta) * 10) / 10;
      if (delta > 0) {
        await db
          .prepare(
            "UPDATE kid_profiles SET daily_minutes_used = ?, daily_minutes_date = ?, updated_at = ? WHERE id = ? AND user_id = ?"
          )
          .bind(Math.round(used), today, now, profileId, userId)
          .run();
      }
      if (activeProfile.daily_limit_minutes > 0) {
        remainingMinutes = Math.max(0, Math.round(activeProfile.daily_limit_minutes - used));
        limitReached = remainingMinutes <= 0;
      }
    }
  }

  const progress = (await getReadingProgress(db, userId, profileId, bookSlug))!;
  return { progress, limitReached, remainingMinutes };
}
