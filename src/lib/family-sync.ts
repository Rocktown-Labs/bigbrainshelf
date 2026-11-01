// Pillar 3: "Whispersync / Spotify Connect for Families" & Safe Character Companions
//
// Coordinates real-time cross-device playback and Read-Along auto-flip state
// across web (/account), iPad, and mobile (apps/mobile), enforces per-kid daily
// listening/reading limits across devices, and powers the guardrailed "Talk to
// the Cast" comprehension companion via Vercel AI Gateway + Vectorize Canon RAG.

import type { DBLike } from "./orders";
import { ensureOnce } from "./schema-cache";
import { retrieveCanonContinuity, recordGenerationCost } from "./braintrust";

export interface FamilyRoomState {
  user_id: string;
  active_profile_id: string;
  active_book_slug: string | null;
  chapter_num: number;
  page_index: number;
  view_edition: string;
  audio_track_id: string;
  audio_position_sec: number;
  is_playing: boolean;
  sleep_remaining_sec: number;
  daily_limit_reached: boolean;
  connected_devices: { deviceId: string; label: string; lastSeen: number }[];
  updated_at: number;
}

export interface CastCharacterPersona {
  slug: string;
  name: string;
  species: string;
  bookSlug: string;
  bookTitle: string;
  shelf: "courage" | "tech" | "money";
  greeting: string;
  badgeName: string;
  starterQuestions: string[];
  storyFacts: string[];
}

export const CAST_PERSONAS: Record<string, CastCharacterPersona> = {
  mira: {
    slug: "mira",
    name: "Mira the Heron",
    species: "Great Blue Heron",
    bookSlug: "mastery",
    bookTitle: "Mira the Heron and the Still Water",
    shelf: "courage",
    greeting: "Hi friend! Standing by the still water taught me that patience and practice beat rushing every time.",
    badgeName: "🌊 Still-Water Patience Badge",
    starterQuestions: [
      "Why did you have to wait by the still water?",
      "What should I do when I feel frustrated practicing something new?",
      "What did Ansel teach you about shortcuts?",
    ],
    storyFacts: [
      "Mira learned from her mentor Ansel that splashing after every ripple scares the fish away.",
      "When The Otter offered a flashy shortcut, Mira discovered that steady deliberate practice builds real mastery.",
      "Taking a slow, deep breath makes the water inside your mind still and clear.",
    ],
  },
  fern: {
    slug: "fern",
    name: "Fern the Fox",
    species: "Red Fox",
    bookSlug: "algorithms",
    bookTitle: "Fern the Fox and the Clever Trails",
    shelf: "tech",
    greeting: "Ready to map a trail? Every big problem is just a sequence of small, clever steps!",
    badgeName: "🦊 Clever Trailblazer Badge",
    starterQuestions: [
      "What is an algorithm in forest words?",
      "How do you break a giant puzzle into small steps?",
      "What happens when a trail step is out of order?",
    ],
    storyFacts: [
      "An algorithm is a clear, step-by-step recipe for solving a problem or reaching a destination.",
      "Fern tests her trails one step at a time so if she takes a wrong turn, she knows right where to debug it.",
      "Sorting acorns and landmarks before you start saves twice as much time on the journey.",
    ],
  },
  penny: {
    slug: "penny",
    name: "Penny the Squirrel",
    species: "Woodland Squirrel",
    bookSlug: "richdadpoordad",
    bookTitle: "Penny the Squirrel and the Acorn Orchard",
    shelf: "money",
    greeting: "Welcome to the Acorn Orchard! Did you know one planted acorn can grow a whole tree of future acorns?",
    badgeName: "🌰 Golden Orchard Grower Badge",
    starterQuestions: [
      "Why did you plant acorns instead of eating them all today?",
      "What is the difference between an acorn you eat and an orchard tree?",
      "How can I save for something special?",
    ],
    storyFacts: [
      "Eating every acorn today leaves your basket empty tomorrow, but planting acorns creates an asset—an orchard that grows more acorns every season.",
      "Compounding means your planted trees grow new acorns, and those new acorns grow even more trees over time.",
      "Splitting your acorns into 'Enjoy Now', 'Save for Later', and 'Plant to Grow' builds smart money habits early.",
    ],
  },
  basil: {
    slug: "basil",
    name: "Basil the Beaver",
    species: "River Beaver",
    bookSlug: "designpatterns",
    bookTitle: "Basil the Beaver and the Pattern Book",
    shelf: "tech",
    greeting: "Grab your blueprint! Good builders reuse proven patterns instead of reinventing the dam every morning.",
    badgeName: "🦫 Master Blueprint Builder Badge",
    starterQuestions: [
      "Why do you keep a Pattern Book by the river?",
      "How does the Observer bell warn the river crew?",
      "What is your favorite building pattern?",
    ],
    storyFacts: [
      "Design patterns are reusable solutions to problems that happen over and over when building big things.",
      "The Observer pattern lets one lookout notify the whole river crew automatically when water levels rise.",
      "The Decorator pattern lets Basil add strong layers to a lodge without tearing down the original walls.",
    ],
  },
};

export async function ensureFamilySyncTables(db: DBLike): Promise<void> {
  await ensureOnce(db, "family_sync_tables_v1", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS family_sync_rooms (
          user_id TEXT PRIMARY KEY,
          active_profile_id TEXT NOT NULL DEFAULT 'default',
          active_book_slug TEXT,
          chapter_num INTEGER NOT NULL DEFAULT 1,
          page_index INTEGER NOT NULL DEFAULT 0,
          view_edition TEXT NOT NULL DEFAULT 'readalong',
          audio_track_id TEXT NOT NULL DEFAULT 'ch1',
          audio_position_sec INTEGER NOT NULL DEFAULT 0,
          is_playing INTEGER NOT NULL DEFAULT 0,
          sleep_remaining_sec INTEGER NOT NULL DEFAULT 3600,
          daily_limit_reached INTEGER NOT NULL DEFAULT 0,
          connected_devices_json TEXT DEFAULT '[]',
          updated_at INTEGER NOT NULL
        )`
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS cast_companion_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          profile_id TEXT NOT NULL DEFAULT 'default',
          character_slug TEXT NOT NULL,
          book_slug TEXT NOT NULL,
          question_text TEXT NOT NULL,
          answer_text TEXT NOT NULL,
          badge_awarded TEXT,
          created_at INTEGER NOT NULL
        )`
      )
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS cast_companion_user_idx ON cast_companion_sessions(user_id, profile_id, created_at)"
      )
      .run();
  });
}

export async function getFamilySyncState(
  db: DBLike,
  userId: string
): Promise<FamilyRoomState> {
  await ensureFamilySyncTables(db);
  const row: any = await db
    .prepare("SELECT * FROM family_sync_rooms WHERE user_id = ?")
    .bind(userId)
    .first();

  if (!row) {
    return {
      user_id: userId,
      active_profile_id: "default",
      active_book_slug: null,
      chapter_num: 1,
      page_index: 0,
      view_edition: "readalong",
      audio_track_id: "ch1",
      audio_position_sec: 0,
      is_playing: false,
      sleep_remaining_sec: 3600,
      daily_limit_reached: false,
      connected_devices: [],
      updated_at: Math.floor(Date.now() / 1000),
    };
  }

  let devices: { deviceId: string; label: string; lastSeen: number }[] = [];
  try {
    devices = JSON.parse(row.connected_devices_json || "[]");
  } catch {}

  return {
    user_id: String(row.user_id),
    active_profile_id: String(row.active_profile_id || "default"),
    active_book_slug: row.active_book_slug ? String(row.active_book_slug) : null,
    chapter_num: Number(row.chapter_num || 1),
    page_index: Number(row.page_index || 0),
    view_edition: String(row.view_edition || "readalong"),
    audio_track_id: String(row.audio_track_id || "ch1"),
    audio_position_sec: Number(row.audio_position_sec || 0),
    is_playing: Boolean(row.is_playing),
    sleep_remaining_sec: Number(row.sleep_remaining_sec ?? 3600),
    daily_limit_reached: Boolean(row.daily_limit_reached),
    connected_devices: devices,
    updated_at: Number(row.updated_at || 0),
  };
}

export async function updateFamilySyncState(
  db: DBLike,
  userId: string,
  patch: Partial<{
    active_profile_id: string;
    active_book_slug: string | null;
    chapter_num: number;
    page_index: number;
    view_edition: string;
    audio_track_id: string;
    audio_position_sec: number;
    is_playing: boolean;
    sleep_remaining_sec: number;
    daily_limit_reached: boolean;
    device_id: string;
    device_label: string;
  }>
): Promise<FamilyRoomState> {
  const current = await getFamilySyncState(db, userId);
  const now = Math.floor(Date.now() / 1000);

  let devices = current.connected_devices.filter((d) => now - d.lastSeen < 86400);
  if (patch.device_id) {
    const existingIdx = devices.findIndex((d) => d.deviceId === patch.device_id);
    const entry = {
      deviceId: patch.device_id,
      label: patch.device_label || "Family Device",
      lastSeen: now,
    };
    if (existingIdx >= 0) devices[existingIdx] = entry;
    else devices.push(entry);
    devices = devices.slice(-6);
  }

  const next: FamilyRoomState = {
    user_id: userId,
    active_profile_id: patch.active_profile_id ?? current.active_profile_id,
    active_book_slug:
      patch.active_book_slug !== undefined ? patch.active_book_slug : current.active_book_slug,
    chapter_num: patch.chapter_num ?? current.chapter_num,
    page_index: patch.page_index ?? current.page_index,
    view_edition: patch.view_edition ?? current.view_edition,
    audio_track_id: patch.audio_track_id ?? current.audio_track_id,
    audio_position_sec: patch.audio_position_sec ?? current.audio_position_sec,
    is_playing: patch.is_playing !== undefined ? patch.is_playing : current.is_playing,
    sleep_remaining_sec: patch.sleep_remaining_sec ?? current.sleep_remaining_sec,
    daily_limit_reached:
      patch.daily_limit_reached !== undefined
        ? patch.daily_limit_reached
        : current.daily_limit_reached,
    connected_devices: devices,
    updated_at: now,
  };

  await db
    .prepare(
      `INSERT INTO family_sync_rooms
        (user_id, active_profile_id, active_book_slug, chapter_num, page_index, view_edition,
         audio_track_id, audio_position_sec, is_playing, sleep_remaining_sec, daily_limit_reached,
         connected_devices_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         active_profile_id = excluded.active_profile_id,
         active_book_slug = excluded.active_book_slug,
         chapter_num = excluded.chapter_num,
         page_index = excluded.page_index,
         view_edition = excluded.view_edition,
         audio_track_id = excluded.audio_track_id,
         audio_position_sec = excluded.audio_position_sec,
         is_playing = excluded.is_playing,
         sleep_remaining_sec = excluded.sleep_remaining_sec,
         daily_limit_reached = excluded.daily_limit_reached,
         connected_devices_json = excluded.connected_devices_json,
         updated_at = excluded.updated_at`
    )
    .bind(
      userId,
      next.active_profile_id,
      next.active_book_slug,
      next.chapter_num,
      next.page_index,
      next.view_edition,
      next.audio_track_id,
      Math.max(0, Math.round(next.audio_position_sec)),
      next.is_playing ? 1 : 0,
      Math.max(0, Math.round(next.sleep_remaining_sec)),
      next.daily_limit_reached ? 1 : 0,
      JSON.stringify(next.connected_devices),
      now
    )
    .run();

  return next;
}

// Guardrailed Kid-Safe "Talk to the Cast" Companion
export async function askCastCompanion(
  db: DBLike,
  env: any,
  params: {
    userId: string;
    profileId?: string;
    characterSlug: string;
    question: string;
  }
): Promise<{
  character: CastCharacterPersona;
  question: string;
  answer: string;
  badgeAwarded: string;
  canonSources: string[];
}> {
  await ensureFamilySyncTables(db);
  const key = String(params.characterSlug || "mira").toLowerCase().trim();
  const persona = CAST_PERSONAS[key] || CAST_PERSONAS.mira;
  const cleanQ = String(params.question || "").slice(0, 240).trim() || persona.starterQuestions[0];

  const canon = await retrieveCanonContinuity(
    db,
    env,
    `${persona.name} ${cleanQ}`,
    persona.bookSlug
  );

  let answer = "";

  // If Vercel AI Gateway is configured, route through Vercel AI Gateway (model sale)
  const gatewayUrl = env?.VERCEL_AI_GATEWAY_URL;
  const gatewayKey = env?.VERCEL_AI_GATEWAY_KEY || env?.OPENAI_API_KEY;
  if (gatewayUrl && gatewayKey) {
    try {
      const resp = await fetch(gatewayUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${gatewayKey}`,
        },
        body: JSON.stringify({
          model: env?.VERCEL_AI_MODEL || "google/gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content: `You are ${persona.name} (${persona.species}) from the children's book "${persona.bookTitle}" on Big Brain Shelf. Speak warmly to a child aged 4-10 in 2-3 short, encouraging sentences. Stay strictly within the story lesson (${persona.storyFacts.join(" ")}) and never ask for personal information.\n${canon.continuityPromptBlock}`,
            },
            { role: "user", content: cleanQ },
          ],
          max_tokens: 160,
        }),
      });
      if (resp.ok) {
        const data: any = await resp.json();
        answer = String(data?.choices?.[0]?.message?.content || "").trim();
        await recordGenerationCost(db, {
          book_slug: persona.bookSlug,
          gateway: "vercel-ai-gateway",
          stage: "script",
          model: env?.VERCEL_AI_MODEL || "google/gemini-2.5-flash",
          units: 1,
          cost_cents: 1,
          metadata: { feature: "cast_companion", character: persona.slug },
        });
      }
    } catch {}
  }

  // Deterministic story-grounded response when offline or no external LLM key
  if (!answer) {
    const qLow = cleanQ.toLowerCase();
    if (persona.slug === "mira") {
      if (qLow.includes("frustrat") || qLow.includes("practic") || qLow.includes("hard")) {
        answer = `When practicing feels frustrating, I take one slow heron breath and let the ripples settle! Remember what Ansel showed me by the still water: every mistake is just showing your wings how to balance next time.`;
      } else if (qLow.includes("shortcut") || qLow.includes("otter")) {
        answer = `The Otter loved quick splashes, but shortcuts only catch tiny minnows! When you take your time and practice one small step each day, you build real mastery that stays with you forever.`;
      } else {
        answer = `${persona.greeting} ${persona.storyFacts[0]} What is one skill you are practicing this week?`;
      }
    } else if (persona.slug === "fern") {
      if (qLow.includes("order") || qLow.includes("wrong") || qLow.includes("debug")) {
        answer = `When a trail step is out of order, we don't panic—we debug! Just walk back to the last landmark that worked, swap the tangled step, and test the path again.`;
      } else {
        answer = `${persona.greeting} ${persona.storyFacts[0]} Try breaking your next big chore or puzzle into 3 tiny fox steps!`;
      }
    } else if (persona.slug === "penny") {
      if (qLow.includes("save") || qLow.includes("plant") || qLow.includes("orchard")) {
        answer = `${persona.storyFacts[0]} Even saving one acorn out of every five starts your very own orchard!`;
      } else {
        answer = `${persona.greeting} ${persona.storyFacts[1]}`;
      }
    } else {
      answer = `${persona.greeting} ${persona.storyFacts[0]}`;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const id = `cc_${now}_${Math.random().toString(36).slice(2, 8)}`;
  await db
    .prepare(
      `INSERT INTO cast_companion_sessions
        (id, user_id, profile_id, character_slug, book_slug, question_text, answer_text, badge_awarded, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      params.userId,
      params.profileId || "default",
      persona.slug,
      persona.bookSlug,
      cleanQ,
      answer,
      persona.badgeName,
      now
    )
    .run();

  return {
    character: persona,
    question: cleanQ,
    answer,
    badgeAwarded: persona.badgeName,
    canonSources: canon.canonFacts.map((f) => f.title),
  };
}

export async function listCastCompanionBadges(
  db: DBLike,
  userId: string,
  profileId?: string
): Promise<{ badge: string; characterSlug: string; bookSlug: string; awardedAt: number }[]> {
  await ensureFamilySyncTables(db);
  const res = profileId
    ? await db
        .prepare(
          "SELECT DISTINCT badge_awarded, character_slug, book_slug, MAX(created_at) as awarded_at FROM cast_companion_sessions WHERE user_id = ? AND profile_id = ? AND badge_awarded IS NOT NULL GROUP BY badge_awarded"
        )
        .bind(userId, profileId)
        .all()
    : await db
        .prepare(
          "SELECT DISTINCT badge_awarded, character_slug, book_slug, MAX(created_at) as awarded_at FROM cast_companion_sessions WHERE user_id = ? AND badge_awarded IS NOT NULL GROUP BY badge_awarded"
        )
        .bind(userId)
        .all();
  return ((res.results || (res as any).rows || []) as any[]).map((r) => ({
    badge: String(r.badge_awarded),
    characterSlug: String(r.character_slug),
    bookSlug: String(r.book_slug),
    awardedAt: Number(r.awarded_at || 0),
  }));
}
