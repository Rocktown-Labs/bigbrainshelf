import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  getEffectiveSession,
  checkUsernameAvailabilityInDb,
  updateUserUsernameInDb,
} from "../../../lib/auth";
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

export const GET: APIRoute = async ({ request, locals }) => {
  const db = (env as any).DB;
  const session = await getEffectiveSession(request, locals, db);
  if (!session?.user?.id) {
    return json({ error: "Sign in required" }, 401);
  }
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

export const POST: APIRoute = async ({ request, url, locals }) => {
  const db = (env as any).DB;
  const session = await getEffectiveSession(request, locals, db);
  if (!session?.user?.id) {
    return json({ error: "Sign in required" }, 401);
  }
  const userId = String(session.user.id);
  const userEmail = session.user.email ? String(session.user.email) : null;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = String(body.action || "save_onboarding");

  if (action === "check_username") {
    const check = await checkUsernameAvailabilityInDb(
      db,
      String(body.username || ""),
      userId
    );
    return json({
      ok: true,
      available: check.available,
      normalized: check.normalized,
      displayUsername: check.displayUsername,
      error: check.error || null,
    });
  }

  if (action === "verify_pin") {
    const valid = await verifyParentPin(db, userId, String(body.pin || ""));
    return json({ ok: valid, valid }, valid ? 200 : 403);
  }

  if (action === "send_birthday_gift") {
    if (!userEmail) {
      return json({ error: "Account email required" }, 400);
    }
    const [kids, existingOb] = await Promise.all([
      listKidProfiles(db, userId),
      getParentOnboarding(db, userId),
    ]);
    const requestedId = body.profile_id || body.kid_id;
    const targetKid =
      (requestedId && kids.find((k) => k.id === String(requestedId))) || kids[0] || null;
    if (!targetKid) {
      return json({ error: "Add a child profile first to send a birthday gift" }, 400);
    }
    await enqueueBirthdayGiftEmail(
      db,
      userId,
      userEmail,
      existingOb?.parent_name || session.user.name || null,
      targetKid,
      url.origin
    );
    return json({ ok: true, sentTo: userEmail, kidName: targetKid.name });
  }

  if (action === "save_onboarding") {
    if (body.username !== undefined && String(body.username || "").trim()) {
      const uRes = await updateUserUsernameInDb(
        db,
        userId,
        String(body.username),
        body.parent_name ? String(body.parent_name) : undefined
      );
      if (!uRes.ok) {
        return json({ error: uRes.error || "Username is not available." }, 400);
      }
    } else if (body.parent_name && String(body.parent_name).trim()) {
      await updateUserUsernameInDb(db, userId, null, String(body.parent_name));
    }
    // If customer also included a first kid profile in the onboarding wizard,
    // upsert it first so the welcome email and birthday gift can personalize with the child's name.
    let savedKid = null;
    if (body.kid_profile && body.kid_profile.name) {
      try {
        savedKid = await upsertKidProfile(db, userId, {
          id: body.kid_profile.id,
          name: String(body.kid_profile.name),
          handle: body.kid_profile.handle ? String(body.kid_profile.handle) : null,
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
      } catch (err) {
        // SECURITY (F4): a client-supplied profile id that belongs to
        // another family is rejected by the lib; surface it as a 404
        // and change nothing.
        if (String((err as any)?.message || "").startsWith("not_found:")) {
          return json({ error: "That child profile was not found for this account." }, 404);
        }
        throw err;
      }
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
    let profile;
    try {
      profile = await upsertKidProfile(db, userId, profileInput);
    } catch (err) {
      // SECURITY (F4): a client-supplied profile id that belongs to
      // another family is rejected by the lib; surface it as a 404
      // and change nothing.
      if (String((err as any)?.message || "").startsWith("not_found:")) {
        return json({ error: "That child profile was not found for this account." }, 404);
      }
      throw err;
    }
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

export const DELETE: APIRoute = async ({ request, url, locals }) => {
  const db = (env as any).DB;
  const session = await getEffectiveSession(request, locals, db);
  if (!session?.user?.id) {
    return json({ error: "Sign in required" }, 401);
  }
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
