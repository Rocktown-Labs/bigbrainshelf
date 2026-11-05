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
import {
  validateUsernameFormat,
  normalizeUsername,
  authClient,
} from "../src/lib/auth-client";
import { normalizePin, isKidHandleTaken, buildFamilyWelcomeEmailText } from "../src/lib/family";
import { formatDateUS, formatDateLong } from "../src/lib/dates";
import { buildCast } from "../src/lib/cast-public";
import {
  ensureAuthUserSchema,
  checkUsernameAvailabilityInDb,
  updateUserUsernameInDb,
  getEffectiveSessionWith,
} from "../src/lib/auth-users";
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

  test("Customer Hub surfaces (/account, /accounts, /read/[slug] QC reader) include sleep timer and sync controls", () => {
    expect(existsSync(resolve(root, "src/pages/accounts.astro"))).toBe(true);
    const accountsRedirect = readFileSync(resolve(root, "src/pages/accounts.astro"), "utf8");
    expect(accountsRedirect).toContain("/account");

    // The stage viewer and audio dock retired in the hub rebuild
    // (CG, 2026-11-01): reading and listening live in the QC reader
    // at /read/[slug], framed by the account sidebar.
    const readerSrc = readFileSync(
      resolve(root, "src/pages/read/[slug].astro"),
      "utf8"
    );
    expect(readerSrc).toContain('id="art-color"');
    expect(readerSrc).toContain('id="view-flip"');
    expect(readerSrc).toContain("sleep-timer");
    expect(readerSrc).toContain("/api/account/progress");
    expect(existsSync(resolve(root, "src/components/CustomerBookViewer.astro"))).toBe(false);
    expect(existsSync(resolve(root, "src/components/CustomerAudioDock.astro"))).toBe(false);
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

    expect(CURRENT_TOPIC_OPTIONS.map((t) => t.id)).toEqual(["tech", "money", "courage"]);
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
    expect(bdayOutbox[0].subject).toContain("Happy Birthday to Zoe");
    const bdayHtml = await renderOutboxEmailHtml(db, "https://bigbrainshelf.com", bdayOutbox[0]);
    expect(bdayHtml).toContain("Happy Birthday to Zoe");
    expect(bdayHtml).toContain("Open your birthday gift");

    // Read-along lives in the QC reader now: scroll/flip views with
    // chapter-synced audio (the retired stage's theater tabs are gone).
    const readerSrc2 = readFileSync(
      resolve(root, "src/pages/read/[slug].astro"),
      "utf8"
    );
    expect(readerSrc2).toContain('id="view-scroll"');
    expect(readerSrc2).toContain('id="view-flip"');
    expect(readerSrc2).toContain("CustomerShell");

    const referralsSrc = readFileSync(resolve(root, "src/pages/account/referrals.astro"), "utf8");
    expect(referralsSrc).toContain('id="referrals"');
    const onboardingSrc = readFileSync(resolve(root, "src/pages/onboarding.astro"), "utf8");
    expect(onboardingSrc).toContain('name="future_topics"');
    expect(onboardingSrc).toContain('name="tos_accepted"');
    expect(onboardingSrc).toContain('name="marketing_opt_in"');
    expect(onboardingSrc).toContain('name="first_kid_dob"');
    expect(onboardingSrc).toContain("kid_profile");
  });

  test("Better Auth username plugin, availability checker, user account menu, and admin /accounts access", async () => {
    const db = makeD1FromSqlite();
    await ensureAuthUserSchema(db);

    expect(typeof authClient).toBe("function");
    expect(normalizeUsername("@Alex_Family")).toBe("alex_family");
    expect(validateUsernameFormat("ab").valid).toBe(false);
    expect(validateUsernameFormat("bad handle!").valid).toBe(false);
    expect(validateUsernameFormat("Alex_Family.1").valid).toBe(true);

    // Seed a user row and test username availability + update
    const nowIso = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "role", "createdAt", "updatedAt")
         VALUES (?, ?, ?, 1, 'user', ?, ?)`
      )
      .bind("u_1", "Alex", "alex@example.com", nowIso, nowIso)
      .run();
    await db
      .prepare(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "role", "createdAt", "updatedAt")
         VALUES (?, ?, ?, 1, 'user', ?, ?)`
      )
      .bind("u_2", "Sam", "sam@example.com", nowIso, nowIso)
      .run();

    const avail1 = await checkUsernameAvailabilityInDb(db, "Alex_Family");
    expect(avail1.available).toBe(true);

    const up1 = await updateUserUsernameInDb(db, "u_1", "Alex_Family", "Alex");
    expect(up1.ok).toBe(true);
    expect(up1.username).toBe("alex_family");
    expect(up1.displayUsername).toBe("Alex_Family");

    // Same user checking their own username stays available
    const availSelf = await checkUsernameAvailabilityInDb(db, "alex_family", "u_1");
    expect(availSelf.available).toBe(true);

    // Another user checking the taken username gets available: false
    const availOther = await checkUsernameAvailabilityInDb(db, "ALEX_FAMILY", "u_2");
    expect(availOther.available).toBe(false);
    const up2 = await updateUserUsernameInDb(db, "u_2", "alex_family");
    expect(up2.ok).toBe(false);

    // Admin session bridge: an owner signed in via locals.user (admin_session)
    // gets a valid session on /account & /accounts without redirecting to /login.
    const adminReq = new Request("https://bigbrainshelf.com/account");
    const adminSession = await getEffectiveSessionWith(
      adminReq,
      { user: { email: "cg@rocktownlabs.com" } },
      db,
      async () => null
    );
    expect(adminSession).not.toBeNull();
    expect(adminSession?.user.email).toBe("cg@rocktownlabs.com");
    expect(adminSession?.user.isAdmin).toBe(true);

    // Verify source wiring across auth.ts, login, signup, account, SiteHeader, AdminShell, and CustomerShell
    const authSrc = readFileSync(resolve(root, "src/lib/auth.ts"), "utf8");
    expect(authSrc).toContain("username(");
    expect(authSrc).toContain('"/sign-in/username"');
    expect(authSrc).toContain("changeEmail");

    const loginSrc = readFileSync(resolve(root, "src/pages/login.astro"), "utf8");
    expect(loginSrc).toContain("/api/auth/sign-in/username");
    expect(loginSrc).toContain("Email or username");

    const signupSrc = readFileSync(resolve(root, "src/pages/signup.astro"), "utf8");
    expect(signupSrc).toContain("/api/auth/is-username-available");
    expect(signupSrc).toContain('id="username"');

    const accountSrc = readFileSync(resolve(root, "src/pages/onboarding.astro"), "utf8");
    expect(accountSrc).toContain('id="ob-username"');
    expect(accountSrc).toContain("/api/auth/is-username-available");
    expect(accountSrc).toContain("/api/auth/update-user");

    const siteHeaderSrc = readFileSync(resolve(root, "src/components/SiteHeader.astro"), "utf8");
    expect(siteHeaderSrc).toContain("user-account-menu-wrap");
    expect(siteHeaderSrc).toContain('href="/account"');
    expect(siteHeaderSrc).not.toContain('href="/accounts"');
    expect(siteHeaderSrc).toContain('href="/admin"');

    const adminShellSrc = readFileSync(resolve(root, "src/components/AdminShell.astro"), "utf8");
    expect(adminShellSrc).toContain("bbs-admin-user-popover");
    expect(adminShellSrc).toContain('href="/account"');
    expect(adminShellSrc).not.toContain('href="/accounts"');
    expect(adminShellSrc).not.toContain('#qc-viewer');

    const custShellSrc = readFileSync(resolve(root, "src/components/CustomerShell.astro"), "utf8");
    // DESIGN.md chrome (CG correction, 2026-11-01): a sidebar with
    // the same mechanics as /admin (fixed rail, grouped nav, user
    // popover), the store top bar above it, and the family switcher
    // inside the sidebar.
    expect(custShellSrc).toContain("SiteHeader");
    expect(custShellSrc).toContain("cust-profile-switcher");
    expect(custShellSrc).toContain('href="/account/orders"');
    expect(custShellSrc).toContain('href="/account/library"');
    expect(custShellSrc).toContain("cust-sb");
    // Every identifier the nav badges reference must be destructured
    // from Astro.props: a bare reference throws at render time and
    // blanks every account page, and astro build does not render
    // auth-gated pages to catch it (this exact bug shipped 2026-11-01).
    expect(custShellSrc).toContain("audioCount = 0");
    expect(custShellSrc).toContain("bookCount = 0");
  });

  test("Book overview price identifiers all resolve to real lib/offers exports", () => {
    // The overview's buy-cards section renders only for books the
    // family does not own, so a phantom price constant there blanks
    // the page for club members while owned books keep working
    // (shipped 2026-11-01: STANDARD_STANDARD_* imports + an
    // un-imported STANDARD_PRINT_PRICE_CENTS use).
    const overviewSrc = readFileSync(
      resolve(root, "src/pages/account/book/[slug].astro"),
      "utf8"
    );
    const offersSrc = readFileSync(resolve(root, "src/lib/offers.ts"), "utf8");
    const exported = new Set(
      [...offersSrc.matchAll(/export const ([A-Z][A-Z0-9_]*)/g)].map((m) => m[1])
    );
    const used = new Set(
      [...overviewSrc.matchAll(/\b([A-Z][A-Z0-9_]*_CENTS)\b/g)].map((m) => m[1])
    );
    expect(used.size).toBeGreaterThan(0);
    for (const id of used) {
      expect(exported.has(id)).toBe(true);
    }
    expect(overviewSrc).not.toContain("STANDARD_STANDARD");
    // The audio-only state keeps print buyable in place: the $7
    // unlock card plus printed and gift set cards (2026-11-01
    // signed-in verification found only the unlock, no print path).
    const audioOnlySection = overviewSrc.slice(overviewSrc.indexOf("{audioOnly &&"));
    expect(audioOnlySection).toContain('format: "printed"');
    expect(audioOnlySection).toContain('format: "giftset"');
  });

  test("Shelf format icons sit on the topic line, never over cover art", () => {
    // CG, 2026-11-01: the circles covered the covers' title art.
    // They belong on the meta line under the book (title, then
    // icons + topic), on both shelf surfaces.
    for (const rel of ["src/pages/account/library.astro", "src/pages/account/index.astro"]) {
      const src = readFileSync(resolve(root, rel), "utf8");
      expect(src).not.toContain("absolute left-2 top-2 z-10 flex items-center gap-1.5");
      expect(src).toContain("fcircle fmt-digital");
      expect(src).toContain("fcircle fmt-audio");
    }
  });

  test("No account surface links at the dead /books index", () => {
    // The catalog lives on / (SectionNav Books -> /); /books has no
    // index page, so account links there 404'd until 2026-11-01.
    // A stub now redirects /books to /, and the links point home.
    for (const rel of [
      "src/components/CustomerShell.astro",
      "src/pages/account/index.astro",
      "src/pages/account/library.astro",
      "src/pages/account/orders.astro",
    ]) {
      const src = readFileSync(resolve(root, rel), "utf8");
      expect(src).not.toContain('href="/books"');
      expect(src).not.toContain('href: "/books"');
    }
    const stub = readFileSync(resolve(root, "src/pages/books/index.astro"), "utf8");
    expect(stub).toContain('Astro.redirect("/", 301)');
  });

  test("Dedication page v2 carries CG's fixes (2026-11-01)", () => {
    const stampSrc = readFileSync(resolve(root, "src/lib/pdf-stamp.ts"), "utf8");
    // Just "Presents" under the logo, never the doubled name line.
    expect(stampSrc).toContain("P R E S E N T S");
    expect(stampSrc).not.toContain("BIG BRAIN SHELF PRESENTS");
    // Blurb A, word for word.
    expect(stampSrc).toContain(
      "To a curious reader: every big idea starts as a small question. May you ask a thousand more."
    );
    // Production date line plus the two made-in lines, no heart.
    // The Arkansas line names the town (CG: "say Searcy, Arkansas").
    expect(stampSrc).toContain("Produced on");
    expect(stampSrc).toContain("Made in the USA");
    expect(stampSrc).toContain("Designed, assembled and packaged in Searcy, Arkansas");
    expect(stampSrc).not.toContain("❤");
    // Text wordmark fallback keeps Brain orange.
    expect(stampSrc).toContain('["BRAIN", ORANGE]');
    // The logo art is bundled into the stamp (always accessible at
    // assembly), and the page prints even with no reader name.
    expect(stampSrc).toContain("logoStackedPngBytes");
    expect(stampSrc).not.toContain("if (name) {\n    try {\n      await insertDedicationPage");
    // The download route feeds title and purchase date in.
    const dlSrc = readFileSync(resolve(root, "src/pages/api/download.ts"), "utf8");
    expect(dlSrc).toContain("bookTitle");
    expect(dlSrc).toContain("producedOn");
    // The site footer carries the same Searcy line.
    const footerSrc = readFileSync(resolve(root, "src/components/SiteFooter.astro"), "utf8");
    expect(footerSrc).toContain("Designed, assembled and packaged in Searcy, Arkansas");
  });

  test("Hub simplification surfaces stay wired (2026-11-01 pass 2)", () => {
    const clubSrc = readFileSync(resolve(root, "src/pages/account/club.astro"), "utf8");
    // The box picker is the Shelf (CG picked it from the HTML
    // prototype over the grid, 2026-11-01): box slots + a shelf of
    // covers on a plank. The radio list and the grid are both gone.
    expect(clubSrc).toContain("data-pick-shelf");
    expect(clubSrc).toContain("data-boxslot");
    expect(clubSrc).not.toContain("data-pick-grid");
    expect(clubSrc).not.toContain('name="club-pick"');
    // Downgrade: Book members can schedule a switch to The Audio
    // Club from the club page, undo it, and start audio after the
    // switch lands.
    expect(clubSrc).toContain("data-club-downgrade");
    expect(clubSrc).toContain("data-club-downgrade-undo");
    expect(existsSync(resolve(root, "src/pages/api/club/downgrade.ts"))).toBe(true);
    const policySrc = readFileSync(resolve(root, "src/lib/route-policy.ts"), "utf8");
    expect(policySrc).toContain('"/api/club/downgrade"');
    const clubLibSrc = readFileSync(resolve(root, "src/lib/club.ts"), "utf8");
    expect(clubLibSrc).toContain("downgrade_to_audio_at");
    expect(clubLibSrc).toContain("club_downgrade_ready");
    const renderSrc = readFileSync(resolve(root, "src/lib/email-render.ts"), "utf8");
    expect(renderSrc).toContain("club_downgrade_ready");

    // Reviews: stat cards + pending reviews are editable in place,
    // backed by a PATCH handler that only opens pending rows.
    const reviewsPageSrc = readFileSync(resolve(root, "src/pages/account/reviews.astro"), "utf8");
    expect(reviewsPageSrc).toContain("reviewStats");
    expect(reviewsPageSrc).toContain("data-edit-form");
    const reviewsApiSrc = readFileSync(resolve(root, "src/pages/api/reviews.ts"), "utf8");
    expect(reviewsApiSrc).toContain("export const PATCH");
    expect(reviewsApiSrc).toContain('"pending"');

    // Referrals: real tracking (joined + ordered) from the rows the
    // system actually records.
    const referralsSrc2 = readFileSync(resolve(root, "src/pages/account/referrals.astro"), "utf8");
    expect(referralsSrc2).toContain("referralJoined");
    expect(referralsSrc2).toContain("referred_by_code");

    // Settings: renamed, and email preferences save through the
    // family API onto the onboarding row.
    const settingsSrc = readFileSync(resolve(root, "src/pages/account/settings.astro"), "utf8");
    expect(settingsSrc).toContain("<title>Settings · Big Brain Shelf</title>");
    expect(settingsSrc).toContain("notif-prefs-form");
    const familyApiSrc = readFileSync(resolve(root, "src/pages/api/account/family.ts"), "utf8");
    expect(familyApiSrc).toContain("save_notification_prefs");
    const familyLibSrc = readFileSync(resolve(root, "src/lib/family.ts"), "utf8");
    expect(familyLibSrc).toContain("parseNotificationPrefs");
    expect(familyLibSrc).toContain("notification_prefs");

    // Orders: sort + pagination + a status pill for digital orders.
    const ordersSrc = readFileSync(resolve(root, "src/pages/account/orders.astro"), "utf8");
    expect(ordersSrc).toContain("orders-sort-form");
    expect(ordersSrc).toContain("In your library");

    // The Listening Shelf's club lookup follows the F1 rule: the
    // email arm of the match is gated on a verified session email
    // (PR #5 fixed the dashboard but missed this page; fixed in
    // main 2026-11-01 so it survives either merge order).
    const listenSrc = readFileSync(resolve(root, "src/pages/account/listen.astro"), "utf8");
    expect(listenSrc).toContain("? = 1 AND LOWER(email)");
    expect(listenSrc).toContain("emailVerified");

    // Notification preferences are honored, not just stored: the
    // send-time flush suppresses by category, release announcements
    // and club reminders check at enqueue, and the birthday
    // scheduler checks family_notes.
    const emailLibSrc = readFileSync(resolve(root, "src/lib/email.ts"), "utf8");
    expect(emailLibSrc).toContain("familyNote");
    expect(emailLibSrc).toContain("notification_prefs");
    const releasesSrc = readFileSync(resolve(root, "src/lib/releases.ts"), "utf8");
    expect(releasesSrc).toContain("getNotificationPrefsForEmail");
    const clubEmailsSrc = readFileSync(resolve(root, "src/lib/club-emails.ts"), "utf8");
    expect(clubEmailsSrc).toContain("getNotificationPrefsForUser");
    const revopsSrc = readFileSync(resolve(root, "src/lib/revops.ts"), "utf8");
    expect(revopsSrc).toContain("parseNotificationPrefs");
    expect(revopsSrc).toContain("family_notes");
  });
});

describe("Customer-view fixes (CG, 2026-11-05)", () => {
  test("the parent PIN is exactly four digits", async () => {
    expect(normalizePin("1234")).toBe("1234");
    expect(normalizePin("12345")).toBeNull();
    expect(normalizePin("123456")).toBeNull();
    expect(normalizePin("123")).toBeNull();
    expect(normalizePin("")).toBeNull();
    expect(normalizePin(null)).toBeNull();

    // A longer PIN saved before the strict rule still verifies raw,
    // so nobody is locked out of Kid View by the tightened field.
    const db = makeD1FromSqlite();
    await ensureFamilyTables(db);
    await saveParentOnboarding(db, "user_pin", "p@example.com", { parent_name: "Pat" }, "https://bigbrainshelf.com");
    await db
      .prepare("UPDATE parent_onboarding SET parent_pin = ? WHERE user_id = ?")
      .bind("123456", "user_pin")
      .run();
    expect(await verifyParentPin(db, "user_pin", "123456")).toBe(true);
    expect(await verifyParentPin(db, "user_pin", "1234")).toBe(false);
  });

  test("re-saving a kid without an id updates instead of duplicating", async () => {
    const db = makeD1FromSqlite();
    await ensureFamilyTables(db);

    const first = await upsertKidProfile(db, "user_dup", {
      name: "Ruby",
      handle: "rubyjoy",
      birth_date: "2021-03-25",
      age: 5,
    });
    // The wizard's old payload: same child, no id.
    const second = await upsertKidProfile(db, "user_dup", {
      name: "Ruby",
      handle: "rubyjoy",
      birth_date: "2021-03-25",
      age: 5,
      default_sleep_timer_minutes: 45,
    });
    expect(second.id).toBe(first.id);
    expect(second.default_sleep_timer_minutes).toBe(45);
    expect((await listKidProfiles(db, "user_dup")).length).toBe(1);

    // Name + birthday alone also match when no handle is in play.
    const third = await upsertKidProfile(db, "user_dup", {
      name: "Ruby",
      birth_date: "2021-03-25",
      age: 5,
    });
    expect(third.id).toBe(first.id);
    expect((await listKidProfiles(db, "user_dup")).length).toBe(1);

    // A genuinely different child still creates a second profile.
    await upsertKidProfile(db, "user_dup", { name: "Leo", birth_date: "2019-06-01", age: 7 });
    expect((await listKidProfiles(db, "user_dup")).length).toBe(2);
  });

  test("kid email is stored when valid and cleared when not", async () => {
    const db = makeD1FromSqlite();
    await ensureFamilyTables(db);
    const kid = await upsertKidProfile(db, "user_mail", {
      name: "Ruby",
      email: "Ruby@Example.com",
      age: 5,
    });
    expect(kid.email).toBe("ruby@example.com");
    const cleared = await upsertKidProfile(db, "user_mail", {
      id: kid.id,
      name: "Ruby",
      email: "not-an-email",
      age: 5,
    });
    expect(cleared.email).toBeNull();
  });

  test("kid handle availability spans profiles but not the profile itself", async () => {
    const db = makeD1FromSqlite();
    await ensureFamilyTables(db);
    const kid = await upsertKidProfile(db, "user_h", { name: "Ruby", handle: "rubyjoy", age: 5 });
    expect(await isKidHandleTaken(db, "rubyjoy")).toBe(true);
    expect(await isKidHandleTaken(db, "@RubyJoy")).toBe(true);
    expect(await isKidHandleTaken(db, "rubyjoy", kid.id)).toBe(false);
    expect(await isKidHandleTaken(db, "freehandle")).toBe(false);
  });

  test("customer dates render US style, never ISO", () => {
    expect(formatDateUS("2021-03-25")).toBe("03/25/2021");
    expect(formatDateUS("2026-11-05")).toBe("11/05/2026");
    expect(formatDateLong("2021-03-25")).toBe("March 25, 2021");
    expect(formatDateUS(null)).toBe("");
    expect(formatDateUS("not a date")).toBe("not a date");
  });

  test("Meet the Cast includes the renamed heroes via the gallery aliases", () => {
    const rows = [
      { name: "Fenix", species: "Fox", book_slug: "algorithms", book_title: "Fenix the Fox and the Clever Trails", book_topic: "tech", picture_book_key: "books/algorithms/picture-book.pdf", book_public_slug: "fenix-the-fox-and-the-clever-trails" },
      { name: "Blaze", species: "Beaver", book_slug: "designpatterns", book_title: "Blaze the Beaver and the Pattern Book", book_topic: "tech", picture_book_key: "books/designpatterns/picture-book.pdf", book_public_slug: "blaze-the-beaver-and-the-pattern-book" },
      { name: "Wells", species: "Whale", book_slug: "docker", book_title: "Wells the Whale and the Great Harbor", book_topic: "tech", picture_book_key: "books/docker/picture-book.pdf", book_public_slug: "wells-the-whale-and-the-great-harbor" },
    ];
    const members = buildCast(rows as any[]);
    expect(members.map((m) => m.slug).sort()).toEqual(["blaze", "fenix", "wells"]);
    for (const m of members) expect(m.portrait).toBeTruthy();
  });
});

describe("Customer-view follow-up (2026-11-05)", () => {
  test("dashboard chip restore keys visibility off the server-rendered state", () => {
    const dash = readFileSync(resolve(root, "src/pages/account/index.astro"), "utf8");
    expect(dash).toContain("parentChipHidden");
    expect(dash).toContain('classList.contains("hidden")');
  });
});

describe("Onboarding option ids (CG, 2026-11-05)", () => {
  test("saves keep only registered option ids, so 'on' can never be stored again", async () => {
    const db = makeD1FromSqlite();
    await ensureFamilyTables(db);
    const saved = await saveParentOnboarding(
      db,
      "user_topics",
      "t@example.com",
      {
        parent_name: "Pat",
        future_topics: ["on", "science", "on", "math", "science"],
        favorite_topics: ["on", "tech"],
        reading_goals: ["bogus", "read_along"],
        discovery_source: "Google or web search",
      },
      "https://bigbrainshelf.com"
    );
    expect(saved.future_topics).toEqual(["science", "math"]);
    expect(saved.favorite_topics).toEqual(["tech"]);
    expect(saved.reading_goals).toEqual(["read_along"]);
    expect(saved.discovery_source).toBeNull();

    const again = await saveParentOnboarding(
      db,
      "user_topics",
      "t@example.com",
      { discovery_source: "search" },
      "https://bigbrainshelf.com"
    );
    expect(again.discovery_source).toBe("search");
    // Untouched lists survive an unrelated save.
    expect(again.future_topics).toEqual(["science", "math"]);
  });

  test("the welcome email prints topic labels and drops unknown ids", () => {
    const { bodyText } = buildFamilyWelcomeEmailText({
      parentName: "CG",
      familyNickname: null,
      kidName: "Ruby",
      sleepMinutes: 60,
      futureTopics: ["on", "science"],
      referralCode: "SHELF-TEST",
      site: "https://bigbrainshelf.com",
    });
    expect(bodyText).toContain("Science & Nature");
    expect(bodyText).not.toContain("(on");
    const none = buildFamilyWelcomeEmailText({
      parentName: "CG",
      familyNickname: null,
      kidName: "Ruby",
      sleepMinutes: 60,
      futureTopics: ["on"],
      site: "https://bigbrainshelf.com",
    });
    expect(none.bodyText).not.toContain("explore next");
  });

  test("the wizard and Kids page bind option ids, never .key", () => {
    const onboarding = readFileSync(resolve(root, "src/pages/onboarding.astro"), "utf8");
    expect(onboarding).not.toContain("t.key");
    expect(onboarding).not.toContain("g.key");
    expect(onboarding).not.toContain("d.key");
    expect(onboarding).not.toContain("a.key");
    expect(onboarding).toContain("reading_goals:");
    const kids = readFileSync(resolve(root, "src/pages/account/kids.astro"), "utf8");
    expect(kids).not.toContain("a.key");
    expect(kids).toContain("a.id === kid.avatar_key");
  });
});
