import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getAuth } from "../../../lib/auth";
import {
  KID_AVATARS,
  SLEEP_TIMER_PRESETS,
  DAILY_LIMIT_PRESETS,
  READING_GOAL_OPTIONS,
  CURRENT_TOPIC_OPTIONS,
  FUTURE_TOPIC_OPTIONS,
  DISCOVERY_SOURCE_OPTIONS,
  computeOnboardingChecklist,
  deleteKidProfile,
  enqueueBirthdayGiftEmail,
  getParentOnboarding,
  listKidProfiles,
  listReadingProgress,
  saveParentOnboarding,
  upsertKidProfile,
  verifyParentPin,
} from "../../../lib/family";

export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const GET: APIRoute = async ({ request }) => {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return json({ error: "Sign in required" }, 401);
  }
  const db = (env as any).DB;
  const userId = String(session.user.id);
  const [onboarding, kidProfiles, progress] = await Promise.all([
    getParentOnboarding(db, userId),
    listKidProfiles(db, userId),
    listReadingProgress(db, userId),
  ]);
  const checklist = computeOnboardingChecklist(onboarding, kidProfiles, progress);

  return json({
    ok: true,
    onboarding: onboarding
      ? { ...onboarding, has_pin: Boolean(onboarding.parent_pin), parent_pin: undefined }
      : null,
    kidProfiles,
    progress,
    checklist,
    avatars: KID_AVATARS,
    sleepPresets: SLEEP_TIMER_PRESETS,
    dailyLimitPresets: DAILY_LIMIT_PRESETS,
    readingGoalOptions: READING_GOAL_OPTIONS,
    currentTopicOptions: CURRENT_TOPIC_OPTIONS,
    futureTopicOptions: FUTURE_TOPIC_OPTIONS,
    discoverySourceOptions: DISCOVERY_SOURCE_OPTIONS,
  });
};

export const POST: APIRoute = async ({ request, url }) => {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return json({ error: "Sign in required" }, 401);
  }
  const db = (env as any).DB;
  const userId = String(session.user.id);
  const userEmail = session.user.email ? String(session.user.email) : null;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = String(body.action || "save_onboarding");

  if (action === "verify_pin") {
    const valid = await verifyParentPin(db, userId, String(body.pin || ""));
    return json({ ok: valid, valid }, valid ? 200 : 403);
  }

  if (action === "send_birthday_gift") {
    if (!userEmail) {
      return json({ error: "Account email required" }, 400);
    }
    const kids = await listKidProfiles(db, userId);
    const targetKid =
      (body.profile_id && kids.find((k) => k.id === String(body.profile_id))) || kids[0] || null;
    if (!targetKid) {
      return json({ error: "Add a child profile first to send a birthday gift" }, 400);
    }
    await enqueueBirthdayGiftEmail(db, userId, userEmail, targetKid, url.origin);
    return json({ ok: true, sentTo: userEmail, kidName: targetKid.name });
  }

  if (action === "save_onboarding") {
    // If customer also included a first kid profile in the onboarding wizard,
    // upsert it first so the welcome email and birthday gift can personalize with the child's name.
    let savedKid = null;
    if (body.kid_profile && body.kid_profile.name) {
      savedKid = await upsertKidProfile(db, userId, {
        id: body.kid_profile.id,
        name: String(body.kid_profile.name),
        birth_date: body.kid_profile.birth_date || null,
        age: Number(body.kid_profile.age || 6),
        age_group: body.kid_profile.age_group,
        avatar_key: body.kid_profile.avatar_key || "mira",
        favorite_themes: Array.isArray(body.kid_profile.favorite_themes)
          ? body.kid_profile.favorite_themes
          : Array.isArray(body.favorite_topics)
            ? body.favorite_topics
            : [],
        daily_limit_minutes:
          body.kid_profile.daily_limit_minutes !== undefined
            ? Number(body.kid_profile.daily_limit_minutes)
            : 60,
        default_sleep_timer_minutes:
          body.kid_profile.default_sleep_timer_minutes !== undefined
            ? Number(body.kid_profile.default_sleep_timer_minutes)
            : 60,
        bedtime_cutoff: body.kid_profile.bedtime_cutoff || null,
        allow_audio_autoplay:
          body.kid_profile.allow_audio_autoplay !== undefined
            ? Boolean(body.kid_profile.allow_audio_autoplay)
            : true,
        is_default: true,
      });
    }

    const onboarding = await saveParentOnboarding(
      db,
      userId,
      userEmail,
      {
        parent_name: body.parent_name,
        family_nickname: body.family_nickname,
        discovery_source: body.discovery_source,
        reading_goals: Array.isArray(body.reading_goals) ? body.reading_goals : undefined,
        favorite_topics: Array.isArray(body.favorite_topics) ? body.favorite_topics : undefined,
        future_topics: Array.isArray(body.future_topics) ? body.future_topics : undefined,
        custom_topic_request: body.custom_topic_request,
        tos_accepted: body.tos_accepted !== undefined ? Boolean(body.tos_accepted) : undefined,
        marketing_opt_in:
          body.marketing_opt_in !== undefined ? Boolean(body.marketing_opt_in) : undefined,
        referred_by_code: body.referred_by_code,
        parent_pin: body.parent_pin,
        onboarding_step: body.onboarding_step,
        mark_complete: Boolean(body.mark_complete),
      },
      url.origin
    );

    const kidProfiles = await listKidProfiles(db, userId);
    const progress = await listReadingProgress(db, userId);
    const checklist = computeOnboardingChecklist(onboarding, kidProfiles, progress);

    return json({
      ok: true,
      onboarding: { ...onboarding, has_pin: Boolean(onboarding.parent_pin), parent_pin: undefined },
      savedKid,
      kidProfiles,
      checklist,
    });
  }

  if (action === "upsert_kid") {
    const existingOnboarding = await getParentOnboarding(db, userId);
    if (existingOnboarding?.parent_pin && body.require_pin) {
      const pinOk = await verifyParentPin(db, userId, String(body.pin || ""));
      if (!pinOk) {
        return json({ error: "Parent PIN required to change profile limits" }, 403);
      }
    }
    const profileInput = body.profile || body;
    if (!profileInput?.name) {
      return json({ error: "Child name is required" }, 400);
    }
    const profile = await upsertKidProfile(db, userId, profileInput);
    const kidProfiles = await listKidProfiles(db, userId);
    return json({ ok: true, profile, kidProfiles });
  }

  if (action === "set_pin") {
    const existing = await getParentOnboarding(db, userId);
    if (existing?.parent_pin) {
      const ok = await verifyParentPin(db, userId, String(body.current_pin || ""));
      if (!ok) {
        return json({ error: "Current Parent PIN does not match" }, 403);
      }
    }
    const updated = await saveParentOnboarding(
      db,
      userId,
      userEmail,
      { parent_pin: body.new_pin ? String(body.new_pin) : null },
      url.origin
    );
    return json({
      ok: true,
      has_pin: Boolean(updated.parent_pin),
    });
  }

  return json({ error: "Unknown action" }, 400);
};

export const DELETE: APIRoute = async ({ request, url }) => {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return json({ error: "Sign in required" }, 401);
  }
  const db = (env as any).DB;
  const userId = String(session.user.id);
  const id = url.searchParams.get("id") || "";
  if (!id) {
    return json({ error: "Profile id required" }, 400);
  }
  const pin = url.searchParams.get("pin") || "";
  const existing = await getParentOnboarding(db, userId);
  if (existing?.parent_pin && pin) {
    const ok = await verifyParentPin(db, userId, pin);
    if (!ok) return json({ error: "Invalid Parent PIN" }, 403);
  }
  await deleteKidProfile(db, userId, id);
  const kidProfiles = await listKidProfiles(db, userId);
  return json({ ok: true, kidProfiles });
};
