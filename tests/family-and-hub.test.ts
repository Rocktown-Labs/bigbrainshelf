import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { ensureOnce, ensuredKeysForDb } from "../src/lib/schema-cache";
import {
  classifyApiRoute,
  isLocalDevHostname,
  CUSTOMER_SELF_AUTH_API_ROUTES,
} from "../src/lib/route-policy";
import {
  classifyAgeGroup,
  calculateAgeFromDob,
  isBirthdayMonthAndDay,
  generateReferralCode,
  computeOnboardingChecklist,
  ensureFamilyTables,
  getParentOnboarding,
  saveParentOnboarding,
  verifyParentPin,
  listKidProfiles,
  upsertKidProfile,
  deleteKidProfile,
  saveReadingProgress,
  getReadingProgress,
  enqueueBirthdayGiftEmail,
  SLEEP_TIMER_PRESETS,
  KID_AVATARS,
  CURRENT_TOPIC_OPTIONS,
  FUTURE_TOPIC_OPTIONS,
} from "../src/lib/family";
import { renderOutboxEmailHtml } from "../src/lib/email-render";
import * as corePkg from "../packages/core/src/index";
import * as schema from "../db/schema";

const root = resolve(import.meta.dir, "..");

function makeD1FromSqlite() {
  const raw = new Database(":memory:");
  let prepareCount = 0;
  const db = {
    get prepareCount() {
      return prepareCount;
    },
    prepare(sql: string) {
      prepareCount++;
      const runStmt = (args: any[]) => {
        const stmt = raw.query(sql);
        return {
          all: async () => ({ results: stmt.all(...args), rows: stmt.all(...args) }),
          first: async () => (stmt.get(...args) as any) ?? null,
          run: async () => {
            stmt.run(...args);
            return { success: true };
          },
        };
      };
      return {
        bind(...args: any[]) {
          return runStmt(args);
        },
        all: async () => runStmt([]).all(),
        first: async () => runStmt([]).first(),
        run: async () => runStmt([]).run(),
      };
    },
  };
  return db;
}

describe("Phase 1: Monorepo & Deployment Consolidation", () => {
  test("package.json, wrangler.jsonc, and void.config.ts align on bigbrainshelf and workspaces", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(pkg.name).toBe("bigbrainshelf");
    expect(pkg.workspaces).toEqual(["packages/*", "apps/*"]);

    const wrangler = readFileSync(resolve(root, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"name": "bigbrainshelf"');
    expect(wrangler).toContain('"binding": "BOOKS"');

    const voidCfg = readFileSync(resolve(root, "void.config.ts"), "utf8");
    expect(voidCfg).toContain("bigbrainshelf");

    const deployPy = readFileSync(resolve(root, "deploy.py"), "utf8");
    expect(deployPy).toContain("os.path.dirname(os.path.abspath(__file__))");
    expect(deployPy).not.toContain('\nBASE = "/home/hatch/workspace/kidsbook-hub"');
  });

  test("workspace packages (@bigbrainshelf/core, apps/web, apps/api, apps/mobile) exist and export shared domain", () => {
    expect(existsSync(resolve(root, "packages/core/package.json"))).toBe(true);
    expect(existsSync(resolve(root, "apps/web/package.json"))).toBe(true);
    expect(existsSync(resolve(root, "apps/api/src/index.ts"))).toBe(true);
    expect(existsSync(resolve(root, "apps/mobile/src/index.ts"))).toBe(true);
    expect(typeof corePkg.classifyAgeGroup).toBe("function");
    expect(typeof corePkg.ensureOnce).toBe("function");
    expect(corePkg.schema.kidProfiles).toBeDefined();
  });
});

describe("Phase 2: Drizzle Schema Synchronization & Memoized ensureOnce", () => {
  test("db/schema.ts defines all core, commerce, club, and family tables", () => {
    expect(schema.bibles).toBeDefined();
    expect(schema.books).toBeDefined();
    expect(schema.chapters).toBeDefined();
    expect(schema.characters).toBeDefined();
    expect(schema.orders).toBeDefined();
    expect(schema.emailOutbox).toBeDefined();
    expect(schema.clubSignups).toBeDefined();
    expect(schema.clubCycleBoxes).toBeDefined();
    expect(schema.reviews).toBeDefined();
    expect(schema.parentOnboarding).toBeDefined();
    expect(schema.kidProfiles).toBeDefined();
    expect(schema.readingProgress).toBeDefined();
  });

  test("ensureOnce executes DDL once per DB instance and memoizes subsequent calls", async () => {
    const db = makeD1FromSqlite();
    let runs = 0;
    await ensureOnce(db, "test_table", async () => {
      runs++;
      await db.prepare("CREATE TABLE IF NOT EXISTS t1 (id TEXT PRIMARY KEY)").bind().run();
    });
    await ensureOnce(db, "test_table", async () => {
      runs++;
    });
    expect(runs).toBe(1);
    expect(ensuredKeysForDb(db).includes("test_table")).toBe(true);
  });
});

describe("Phase 3: Declarative Route Policy & Unified Auth", () => {
  test("classifyApiRoute distinguishes public, customer self-auth, service token, and admin routes", () => {
    const emptyParams = new URLSearchParams();
    expect(classifyApiRoute("/api/stripe/webhook", "POST", emptyParams)).toBe("public");
    expect(classifyApiRoute("/api/audio-sample/foo/intro", "GET", emptyParams)).toBe("public");
    expect(
      classifyApiRoute("/api/books", "GET", new URLSearchParams("status=complete"))
    ).toBe("public");
    expect(classifyApiRoute("/api/books", "POST", emptyParams)).toBe("admin");

    expect(CUSTOMER_SELF_AUTH_API_ROUTES.has("/api/account/family")).toBe(true);
    expect(CUSTOMER_SELF_AUTH_API_ROUTES.has("/api/account/progress")).toBe(true);
    expect(CUSTOMER_SELF_AUTH_API_ROUTES.has("/api/account/book-pages")).toBe(true);
    expect(classifyApiRoute("/api/account/family", "POST", emptyParams)).toBe("customer_self_auth");
    expect(classifyApiRoute("/api/library/page/foo/1", "GET", emptyParams)).toBe(
      "customer_self_auth"
    );
    expect(classifyApiRoute("/api/lift/worker", "POST", emptyParams)).toBe("service_token");
    expect(classifyApiRoute("/api/admin/orders-badge", "GET", emptyParams)).toBe("admin");
  });

  test("isLocalDevHostname only matches local dev hosts", () => {
    expect(isLocalDevHostname("localhost")).toBe(true);
    expect(isLocalDevHostname("127.0.0.1")).toBe(true);
    expect(isLocalDevHostname("bigbrainshelf.com")).toBe(false);
  });
});

describe("Phase 4: Family Onboarding, Kid Profiles, PIN Gate, Limits & Synced Progress", () => {
  test("classifyAgeGroup maps ages 4-8, 9-12, and 13-18", () => {
    expect(classifyAgeGroup(4)).toBe("4-8");
    expect(classifyAgeGroup(8)).toBe("4-8");
    expect(classifyAgeGroup(9)).toBe("9-12");
    expect(classifyAgeGroup(12)).toBe("9-12");
    expect(classifyAgeGroup(15)).toBe("13-18");
  });

  test("Parent onboarding starts at 25% endowed progress, saves PIN, and enqueues welcome email once", async () => {
    const db = makeD1FromSqlite();
    await ensureFamilyTables(db);

    const initialChecklist = computeOnboardingChecklist(null, [], []);
    expect(initialChecklist.percent).toBe(25);
    expect(initialChecklist.isComplete).toBe(false);

    const kid = await upsertKidProfile(db, "user_1", {
      name: "Maya",
      age: 6,
      avatar_key: "mira",
      daily_limit_minutes: 45,
      default_sleep_timer_minutes: 60,
    });
    expect(kid.age_group).toBe("4-8");
    expect(kid.default_sleep_timer_minutes).toBe(60);

    const ob = await saveParentOnboarding(
      db,
      "user_1",
      "parent@example.com",
      {
        parent_name: "Alex",
        parent_pin: "4321",
        reading_goals: ["bedtime_calm", "read_along"],
        mark_complete: true,
      },
      "https://bigbrainshelf.com"
    );
    expect(ob.parent_name).toBe("Alex");
    expect(ob.parent_pin).toBe("4321");
    expect(ob.completed_at).toBeGreaterThan(0);

    // Verify PIN gate
    expect(await verifyParentPin(db, "user_1", "4321")).toBe(true);
    expect(await verifyParentPin(db, "user_1", "0000")).toBe(false);

    // Check welcome email was enqueued in email_outbox and renders HTML cleanly
    const outboxRows = (
      await db
        .prepare("SELECT * FROM email_outbox WHERE kind = 'family_onboarding'")
        .bind()
        .all()
    ).results as any[];
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].subject).toContain("Maya");
    const html = await renderOutboxEmailHtml(db, "https://bigbrainshelf.com", outboxRows[0]);
    expect(html).toContain("Open your family shelf");
    expect(html).toContain("Sleep Timer");
  });

  test("Synced reading & audiobook progress tracks page, edition, audio position, and daily kid limits", async () => {
    const db = makeD1FromSqlite();
    await ensureFamilyTables(db);

    const kid = await upsertKidProfile(db, "user_2", {
      name: "Leo",
      age: 7,
      avatar_key: "wally",
      daily_limit_minutes: 30,
      default_sleep_timer_minutes: 60,
    });

    const firstSave = await saveReadingProgress(db, "user_2", {
      profile_id: kid.id,
      book_slug: "little-saver",
      chapter_num: 2,
      page_index: 5,
      view_edition: "coloring",
      view_mode: "flip",
      audio_track_id: "ch2",
      audio_position_sec: 42.5,
      audio_duration_sec: 180,
      sync_enabled: true,
      elapsed_minutes_delta: 20,
    });

    expect(firstSave.progress.chapter_num).toBe(2);
    expect(firstSave.progress.page_index).toBe(5);
    expect(firstSave.progress.view_edition).toBe("coloring");
    expect(firstSave.progress.audio_track_id).toBe("ch2");
    expect(firstSave.progress.audio_position_sec).toBe(42.5);
    expect(firstSave.limitReached).toBe(false);
    expect(firstSave.remainingMinutes).toBe(10);

    // Second save crosses the 30-minute daily limit
    const secondSave = await saveReadingProgress(db, "user_2", {
      profile_id: kid.id,
      book_slug: "little-saver",
      elapsed_minutes_delta: 15,
    });
    expect(secondSave.limitReached).toBe(true);
    expect(secondSave.remainingMinutes).toBe(0);

    const loaded = await getReadingProgress(db, "user_2", kid.id, "little-saver");
    expect(loaded?.audio_track_id).toBe("ch2");

    await deleteKidProfile(db, "user_2", kid.id);
    expect((await listKidProfiles(db, "user_2")).length).toBe(0);
  });

  test("Customer Hub components (/account, /accounts, QC viewer, Audio Dock, /read/[slug]) include sleep timer and sync controls", () => {
    expect(existsSync(resolve(root, "src/pages/accounts.astro"))).toBe(true);
    const accountsRedirect = readFileSync(resolve(root, "src/pages/accounts.astro"), "utf8");
    expect(accountsRedirect).toContain("/account");

    const viewerSrc = readFileSync(
      resolve(root, "src/components/CustomerBookViewer.astro"),
      "utf8"
    );
    expect(viewerSrc).toContain('data-qc-edition="story"');
    expect(viewerSrc).toContain('data-qc-edition="coloring"');
    expect(viewerSrc).toContain('data-qc-edition="fullcolor"');
    expect(viewerSrc).toContain('data-qc-edition="cover"');
    expect(viewerSrc).toContain("qc-audio-sync-check");

    const audioDockSrc = readFileSync(
      resolve(root, "src/components/CustomerAudioDock.astro"),
      "utf8"
    );
    expect(audioDockSrc).toContain("audio-sleep-select");
    expect(audioDockSrc).toContain("persistent-audio-dock");
    expect(audioDockSrc).toContain("bbsCustomerHub");
    expect(SLEEP_TIMER_PRESETS.some((p) => p.minutes === 60)).toBe(true);
    expect(KID_AVATARS.length).toBeGreaterThanOrEqual(5);

    const readPageSrc = readFileSync(resolve(root, "src/pages/read/[slug].astro"), "utf8");
    expect(readPageSrc).toContain('id="sleep-timer"');
    expect(readPageSrc).toContain('value="60" selected');
  });

  test("Onboarding captures TOS, marketing opt-in, current & future topics, DOB, Birthday Gift email, referrals, and Read-Along auto-flip", async () => {
    const db = makeD1FromSqlite();
    await ensureFamilyTables(db);

    expect(calculateAgeFromDob("2020-05-15", new Date("2026-06-01T00:00:00Z"))).toBe(6);
    expect(isBirthdayMonthAndDay("2020-10-31", "2026-10-31")).toBe(true);
    expect(isBirthdayMonthAndDay("2020-10-31", "2026-11-01")).toBe(false);

    const refCode = generateReferralCode("Alex", "user_ref_99");
    expect(refCode).toContain("ALEX-");

    expect(CURRENT_TOPIC_OPTIONS.map((t) => t.id)).toEqual(["tech", "finance", "courage"]);
    expect(FUTURE_TOPIC_OPTIONS.some((t) => t.id === "science")).toBe(true);
    expect(FUTURE_TOPIC_OPTIONS.some((t) => t.id === "history")).toBe(true);
    expect(FUTURE_TOPIC_OPTIONS.some((t) => t.id === "math")).toBe(true);

    const kid = await upsertKidProfile(db, "user_bday", {
      name: "Zoe",
      birth_date: "2020-04-12",
      avatar_key: "mira",
      favorite_topics: ["tech", "courage"],
    });
    expect(kid.birth_date).toBe("2020-04-12");
    expect(kid.age_group).toBe("4-8");

    const ob = await saveParentOnboarding(
      db,
      "user_bday",
      "zoe-parent@example.com",
      {
        parent_name: "Jordan",
        favorite_topics: ["tech", "courage"],
        future_topics: ["science", "history", "math"],
        custom_topic_request: "Ancient Egypt & Volcanoes",
        tos_accepted: true,
        marketing_opt_in: true,
        mark_complete: true,
      },
      "https://bigbrainshelf.com"
    );
    expect(ob.tos_accepted).toBe(true);
    expect(ob.tos_accepted_at).toBeGreaterThan(0);
    expect(ob.marketing_opt_in).toBe(true);
    expect(ob.favorite_topics).toEqual(["tech", "courage"]);
    expect(ob.future_topics).toEqual(["science", "history", "math"]);
    expect(ob.custom_topic_request).toBe("Ancient Egypt & Volcanoes");
    expect(ob.referral_code.startsWith("JORDAN-")).toBe(true);

    // Verify marketing opt-in synced to newsletter_subscribers
    const subRow = await db
      .prepare("SELECT email, source FROM newsletter_subscribers WHERE email = ?")
      .bind("zoe-parent@example.com")
      .first();
    expect(subRow?.email).toBe("zoe-parent@example.com");

    // Trigger Birthday Gift email and verify outbox + React Email HTML rendering
    const giftQueued = await enqueueBirthdayGiftEmail(
      db,
      "user_bday",
      "zoe-parent@example.com",
      "Jordan",
      kid,
      "https://bigbrainshelf.com"
    );
    expect(giftQueued).toBe(true);

    const bdayOutbox = (
      await db
        .prepare("SELECT * FROM email_outbox WHERE kind = 'birthday_gift'")
        .bind()
        .all()
    ).results as any[];
    expect(bdayOutbox.length).toBe(1);
    expect(bdayOutbox[0].subject).toContain("Happy Birthday, Zoe!");
    const bdayHtml = await renderOutboxEmailHtml(db, "https://bigbrainshelf.com", bdayOutbox[0]);
    expect(bdayHtml).toContain("Happy Birthday, Zoe!");
    expect(bdayHtml).toContain("Open Zoe");

    // Verify Read-Along Theater Mode & Referrals markup
    const viewerSrc = readFileSync(
      resolve(root, "src/components/CustomerBookViewer.astro"),
      "utf8"
    );
    expect(viewerSrc).toContain('data-qc-edition="readalong"');
    expect(viewerSrc).toContain("qc-inline-theater-player");
    expect(viewerSrc).toContain("qc-auto-flip-check");

    const audioDockSrc = readFileSync(
      resolve(root, "src/components/CustomerAudioDock.astro"),
      "utf8"
    );
    expect(audioDockSrc).toContain("autoFlipPageForCurrentTime");

    const accountSrc = readFileSync(resolve(root, "src/pages/account/index.astro"), "utf8");
    expect(accountSrc).toContain('id="referrals"');
    expect(accountSrc).toContain('name="future_topics"');
    expect(accountSrc).toContain('name="tos_accepted"');
    expect(accountSrc).toContain('name="marketing_opt_in"');
    expect(accountSrc).toContain('name="kid_birth_date"');
  });
});
