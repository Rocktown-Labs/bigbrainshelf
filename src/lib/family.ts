import { ensureOnce } from "./schema-cache";
import { enqueueEmail, type DBLike } from "./orders";

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

export const KID_AVATARS: readonly KidAvatarOption[] = [
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
    name: "Fern",
    label: "Garden Dreamer",
    color: "#15803d",
    bg: "#dcfce7",
    emoji: "🌿",
    imagePath: "/images/characters/fern.webp",
  },
  {
    id: "wally",
    name: "Wally",
    label: "Gentle Giant",
    color: "#1d4ed8",
    bg: "#dbeafe",
    emoji: "🐻",
    imagePath: "/images/characters/wally.webp",
  },
  {
    id: "basil",
    name: "Basil",
    label: "Night Sky Listener",
    color: "#6d28d9",
    bg: "#ede9fe",
    emoji: "🌙",
    imagePath: "/images/characters/basil.webp",
  },
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

export type ReaderViewEdition = "story" | "coloring" | "fullcolor" | "cover";
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

export function normalizePin(pin: string | null | undefined): string | null {
  if (!pin) return null;
  const digits = String(pin).replace(/\D/g, "").slice(0, 6);
  return digits.length >= 4 ? digits : null;
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

export async function ensureFamilyTables(db: DBLike): Promise<void> {
  return ensureOnce(db, "family_tables", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS parent_onboarding (
           user_id TEXT PRIMARY KEY,
           parent_name TEXT,
           family_nickname TEXT,
           discovery_source TEXT,
           reading_goals TEXT,
           parent_pin TEXT,
           onboarding_step INTEGER NOT NULL DEFAULT 1,
           completed_at INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         )`
      )
      .bind()
      .run();

    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS kid_profiles (
           id TEXT PRIMARY KEY,
           user_id TEXT NOT NULL,
           name TEXT NOT NULL,
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
  return {
    user_id: String(row.user_id),
    parent_name: row.parent_name ? String(row.parent_name) : null,
    family_nickname: row.family_nickname ? String(row.family_nickname) : null,
    discovery_source: row.discovery_source ? String(row.discovery_source) : null,
    reading_goals: parseJsonArray(row.reading_goals),
    parent_pin: row.parent_pin ? String(row.parent_pin) : null,
    onboarding_step: Number(row.onboarding_step || 1),
    completed_at: row.completed_at ? Number(row.completed_at) : null,
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  };
}

function hydrateKidProfile(row: any, today: string): KidProfileRecord {
  const sameDay = row.daily_minutes_date === today;
  const age = Number(row.age || 6);
  const rawGroup = String(row.age_group || "");
  const ageGroup: AgeGroup = (AGE_GROUPS as readonly string[]).includes(rawGroup)
    ? (rawGroup as AgeGroup)
    : classifyAgeGroup(age);
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    name: String(row.name || "Reader"),
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
    ed === "coloring" || ed === "fullcolor" || ed === "cover" ? ed : "story";
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
        onboarding.completed_at)
  );
  const hasKidProfile = kidProfiles.length > 0;
  const hasStartedReading = progressList.length > 0 || Boolean(onboarding?.completed_at);

  // Endowed progress: account creation itself starts the family at 25% complete.
  const steps = [
    { id: "account", label: "Parent account ready", done: true },
    { id: "family", label: "Tell us about your family", done: hasParentInfo },
    { id: "kid_profile", label: "Create your child's reader profile & sleep timer", done: hasKidProfile },
    { id: "first_story", label: "Open a storybook or start the audiobook player", done: hasStartedReading },
  ];
  const completedCount = steps.filter((s) => s.done).length;
  const percent = Math.round((completedCount / steps.length) * 100);
  return {
    percent,
    isComplete: Boolean(onboarding?.completed_at) || (hasParentInfo && hasKidProfile),
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
  parent_pin?: string | null;
  onboarding_step?: number;
  mark_complete?: boolean;
}

export function buildFamilyWelcomeEmailText(opts: {
  parentName: string | null;
  familyNickname: string | null;
  kidName: string | null;
  sleepMinutes: number;
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

  const subject = opts.kidName?.trim()
    ? `${opts.kidName.trim()}'s Big Brain Shelf is ready for story time`
    : "Your family shelf is ready on Big Brain Shelf";

  const bodyText = [
    `Hi ${greetingName},`,
    `${kidPart} on Big Brain Shelf. You can open the Book Viewer and Audiobook Player side by side, flip between the storybook, coloring pages, and full-color artwork, and pick up right where you left off on any device.`,
    `We set your default audiobook sleep timer to turn off gently ${sleepLabel}, so bedtime listening stays calm and automatic.`,
    `Open your family shelf here: ${opts.site.replace(/\/$/, "")}/account`,
    `If you ever want to adjust daily reading limits, update your parent PIN, or add another reader profile as your kids grow from ages 4-8 up through 18, open Kids & Family in your account sidebar.`,
  ].join("\n\n");

  return { subject, bodyText };
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
  const discoverySource =
    input.discovery_source !== undefined
      ? (input.discovery_source ? String(input.discovery_source).trim().slice(0, 80) : null)
      : (existing?.discovery_source ?? null);
  const readingGoals =
    input.reading_goals !== undefined
      ? input.reading_goals.map((g) => String(g).trim()).filter(Boolean).slice(0, 10)
      : (existing?.reading_goals ?? []);
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
         (user_id, parent_name, family_nickname, discovery_source, reading_goals, parent_pin, onboarding_step, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         parent_name = excluded.parent_name,
         family_nickname = excluded.family_nickname,
         discovery_source = excluded.discovery_source,
         reading_goals = excluded.reading_goals,
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
      parentPin,
      step,
      completedAt,
      existing?.created_at ?? now,
      now
    )
    .run();

  if (input.mark_complete && !existing?.completed_at && userEmail) {
    try {
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
      const kids = await listKidProfiles(db, userId);
      const firstKid = kids[0] || null;
      const { subject, bodyText } = buildFamilyWelcomeEmailText({
        parentName,
        familyNickname,
        kidName: firstKid?.name ?? null,
        sleepMinutes: firstKid?.default_sleep_timer_minutes ?? 60,
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
  return onboarding.parent_pin === String(candidatePin || "").trim();
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

  const id = input.id && String(input.id).trim() ? String(input.id).trim() : crypto.randomUUID();
  const current = existingProfiles.find((p) => p.id === id) || null;

  const cleanName = String(input.name || current?.name || "Reader").trim().slice(0, 40) || "Reader";
  const age = Number.isFinite(Number(input.age))
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
         (id, user_id, name, age, age_group, avatar_key, favorite_themes, daily_limit_minutes, default_sleep_timer_minutes, bedtime_cutoff, allow_audio_autoplay, allowed_book_slugs, daily_minutes_used, daily_minutes_date, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
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
    input.view_edition && ["story", "coloring", "fullcolor", "cover"].includes(input.view_edition)
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
