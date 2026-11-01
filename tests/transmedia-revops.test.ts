// End-to-end test suite for Pillars 1-6:
//   1. Pixar Braintrust (Vectorize/D1 semantic search, Canon RAG, Demand Clustering, AI COGS Ledger)
//   2. HyperFrames Book-to-YouTube Composition Builder (16:9 Episode & 9:16 Short)
//   3. FamilyRoom Cross-Device Sync & Guardrailed "Talk to the Cast" Companion
//   4. Smart Fulfillment Router (Mode A Shippo / Mode B POD / Mode C 3PL) & Phygital QR/NFC Unlocks
//   5. High-Cardinality Reading Telemetry & Cloudflare Basin Iceberg Streamer
//   6. RevOps Lifecycle Engine (offers.ts pricing ladder, BDAY10 cron, 80% completion upsell,
//      Club skip/switch-to-audio/annual-upgrade retention actions)
//
// Run with: bun tests/transmedia-revops.test.ts

import { Database } from "bun:sqlite";
import {
  indexCatalogVectors,
  semanticAskTheShelf,
  retrieveCanonContinuity,
  clusterParentTopicDemand,
  recordGenerationCost,
  getGenerationCostSummary,
} from "../src/lib/braintrust";
import { buildHyperFramesComposition } from "../src/lib/hyperframes-video";
import {
  getFamilySyncState,
  updateFamilySyncState,
  askCastCompanion,
  listCastCompanionBadges,
} from "../src/lib/family-sync";
import {
  routePhysicalOrderFulfillment,
  mintPhygitalClaimToken,
  redeemPhygitalClaim,
  getFulfillmentRouterSummary,
} from "../src/lib/fulfillment-router";
import {
  recordReadingTelemetry,
  streamToBasinPipeline,
  getReadingTelemetrySummary,
} from "../src/lib/telemetry";
import {
  runBirthdayGiftScheduler,
  checkAndEnqueueCompletionUpsell,
  applyClubRetentionAction,
  getRevOpsDashboardMetrics,
  scoreAccountRevOps,
} from "../src/lib/revops";
import {
  AUDIO_CLUB_ANNUAL_PRICE_CENTS,
  AUDIO_CLUB_PRICE_CENTS,
  AUDIO_PRICE_CENTS,
  CLUB_ANNUAL_PRICE_CENTS,
  CLUB_PRICE_CENTS,
  GIFT_SET_PRICE_CENTS,
  STANDARD_DIGITAL_PRICE_CENTS,
  STANDARD_PRINT_PRICE_CENTS,
} from "../src/lib/offers";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else {
    failures += 1;
    console.error("FAIL:", label);
  }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  username TEXT UNIQUE,
  displayUsername TEXT,
  role TEXT DEFAULT 'user'
);
CREATE TABLE books (
  slug TEXT PRIMARY KEY,
  public_slug TEXT,
  title TEXT,
  topic TEXT,
  topics TEXT,
  description TEXT,
  status TEXT,
  cover_key TEXT,
  picture_book_key TEXT,
  coloring_book_key TEXT,
  audiobook_key TEXT
);
CREATE TABLE bibles (
  book_slug TEXT PRIMARY KEY,
  big_idea TEXT,
  data TEXT
);
CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  book_slug TEXT,
  name TEXT,
  species TEXT,
  visual_prompt TEXT,
  role TEXT
);
CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  book_slug TEXT,
  num INTEGER,
  title TEXT,
  real_concept TEXT,
  summary TEXT,
  content TEXT,
  pages TEXT
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  book_slugs TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'complete',
  created_at INTEGER NOT NULL,
  items TEXT DEFAULT ''
);
CREATE TABLE club_signups (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  shelf TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid',
  plan TEXT DEFAULT 'quarterly',
  club_plan TEXT DEFAULT 'physical',
  first_ship_date TEXT DEFAULT '2026-10-31',
  subscription_status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  kind TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  send_after INTEGER,
  from_email TEXT
);

INSERT INTO "user" (id, name, email, username) VALUES
  ('u-parent-1', 'Sarah Miller', 'sarah@example.com', 'sarahm'),
  ('u-club-1', 'David Chen', 'david@example.com', 'davidc');

INSERT INTO books (slug, public_slug, title, topic, topics, description, status, cover_key, picture_book_key, coloring_book_key, audiobook_key) VALUES
  ('mastery', 'mira-the-heron-and-the-still-water', 'Mira the Heron and the Still Water', 'courage', 'mastery,patience,practice', 'A young heron learns patience and deliberate practice by the still water.', 'complete', 'covers/mastery.jpg', 'books/mastery/pic.pdf', 'books/mastery/col.pdf', 'books/mastery/audio.m4b'),
  ('richdadpoordad', 'penny-the-squirrel-and-the-acorn-orchard', 'Penny the Squirrel and the Acorn Orchard', 'money', 'saving,investing,compounding', 'A squirrel plants acorns to grow a compounding orchard.', 'complete', 'covers/penny.jpg', 'books/penny/pic.pdf', 'books/penny/col.pdf', 'books/penny/audio.m4b'),
  ('algorithms', 'fern-the-fox-and-the-clever-trails', 'Fern the Fox and the Clever Trails', 'tech', 'algorithms,coding,steps', 'A clever fox breaks giant forest problems into step-by-step trails.', 'complete', 'covers/fern.jpg', 'books/fern/pic.pdf', 'books/fern/col.pdf', 'books/fern/audio.m4b');

INSERT INTO bibles (book_slug, big_idea, data) VALUES
  ('mastery', 'Deliberate practice and patience beat flashy shortcuts when learning hard things.', '{"conceptLadder":["patience","deliberate practice","handling frustration"]}'),
  ('richdadpoordad', 'Planting acorns into assets grows a compounding orchard over time.', '{"conceptLadder":["saving","assets","compound interest"]}'),
  ('algorithms', 'Every complex puzzle can be solved with a clear step-by-step recipe.', '{"conceptLadder":["algorithms","debugging","step by step"]}');

INSERT INTO characters (id, book_slug, name, species, visual_prompt, role) VALUES
  ('char-mira', 'mastery', 'Mira', 'Great Blue Heron', 'Tall blue-grey heron with a warm leather satchel', 'The Learner'),
  ('char-penny', 'richdadpoordad', 'Penny', 'Woodland Squirrel', 'Bright red squirrel holding a golden acorn', 'The Builder'),
  ('char-fern', 'algorithms', 'Fern', 'Red Fox', 'Curious red fox with a compass and trail map', 'The Mapper');

INSERT INTO chapters (id, book_slug, num, title, real_concept, summary, content) VALUES
  ('ch-mira-1', 'mastery', 1, 'The Ripples on the Pond', 'Handling frustration when learning', 'Mira splashes after fish and gets frustrated until Ansel teaches her to wait.', 'Mira stood by the pond.\n\nEvery splash scared the fish away until she took a slow breath.'),
  ('ch-penny-1', 'richdadpoordad', 1, 'One Acorn or a Whole Tree', 'Saving vs spending and compound growth', 'Penny discovers that planting acorns grows an orchard.', 'Penny held five acorns in her paws.\n\nShe planted two in the sunny clearing.');
`);

const r2Store = new Map<string, string>();
const mockEnv = {
  BOOKS: {
    async put(key: string, val: string) {
      r2Store.set(key, val);
    },
    async get(key: string) {
      return r2Store.get(key) || null;
    },
  },
};

const db = {
  prepare(sql: string) {
    return {
      bind(...args: any[]) {
        const stmt = raw.query(sql);
        return {
          async run() {
            const r = stmt.run(...args) as any;
            return { meta: { changes: r?.changes ?? 0 } };
          },
          async first() {
            return stmt.get(...args) ?? null;
          },
          async all() {
            return { results: stmt.all(...args) };
          },
        };
      },
      async run() {
        const r = raw.query(sql).run() as any;
        return { meta: { changes: r?.changes ?? 0 } };
      },
      async first() {
        return raw.query(sql).get() ?? null;
      },
      async all() {
        return { results: raw.query(sql).all() };
      },
    };
  },
} as any;

// ---- 1. Pillar 1: Pixar Braintrust (Vectors, Semantic Search, Canon RAG, COGS) ----
{
  const idx = await indexCatalogVectors(db, mockEnv);
  assert(idx.indexed >= 8 && idx.curriculumCount >= 4 && idx.canonCount >= 4, "Braintrust indexes books, bibles, chapters, and characters");

  const frustrationHits = await semanticAskTheShelf(
    db,
    mockEnv,
    "my 6-year-old gets frustrated when losing games and needs patience",
    { namespace: "curriculum", onlyPublished: true }
  );
  assert(
    frustrationHits.length > 0 && frustrationHits[0].bookSlug === "mastery",
    "Semantic search matches 'frustrated losing games / patience' to Mira the Heron (mastery)"
  );

  const moneyHits = await semanticAskTheShelf(
    db,
    mockEnv,
    "how saving money and compound interest works for kids",
    { namespace: "curriculum", onlyPublished: true }
  );
  assert(
    moneyHits.length > 0 && moneyHits[0].bookSlug === "richdadpoordad",
    "Semantic search matches 'saving money and compound interest' to Penny the Squirrel (richdadpoordad)"
  );

  const canon = await retrieveCanonContinuity(db, mockEnv, "Mira satchel and patience", "mastery");
  assert(
    canon.canonFacts.length > 0 && canon.continuityPromptBlock.includes("BIG BRAIN SHELF CANON CONTINUITY"),
    "retrieveCanonContinuity returns canon prompt block for script/video generation"
  );

  await recordGenerationCost(db, {
    book_slug: "mastery",
    gateway: "vercel-ai-gateway",
    stage: "script",
    model: "google/gemini-2.5-flash",
    units: 1,
    cost_cents: 4,
  });
  const cogs = await getGenerationCostSummary(db);
  assert(cogs.totalCents >= 4 && cogs.byGateway["vercel-ai-gateway"] === 4, "Vercel AI Gateway COGS ledger tracks per-book spend");
}

// ---- 2. Pillar 2: HyperFrames Book-to-YouTube Composition Builder ----
{
  const ep = await buildHyperFramesComposition(db, mockEnv, "mastery", { aspect: "16:9" });
  assert(ep.width === 1920 && ep.height === 1080 && ep.fps === 30, "HyperFrames 16:9 episode has 1920x1080@30fps contract");
  assert(ep.html.includes('data-composition-id="main"') && ep.html.includes('class="clip scene-clip"'), "HyperFrames HTML contains required composition root and scene clips");
  assert(r2Store.has(ep.htmlKey) && r2Store.has(ep.manifestKey), "HyperFrames composition HTML and manifest are saved to R2");

  const short = await buildHyperFramesComposition(db, mockEnv, "algorithms", { aspect: "9:16" });
  assert(short.width === 1080 && short.height === 1920, "HyperFrames 9:16 Short has 1080x1920 vertical dimensions");
}

// ---- 3. Pillar 3: FamilyRoom Cross-Device Sync & Cast Companion ----
{
  const synced = await updateFamilySyncState(db, "u-parent-1", {
    active_profile_id: "kid-leo",
    active_book_slug: "mastery",
    chapter_num: 1,
    page_index: 3,
    view_edition: "readalong",
    audio_track_id: "ch1",
    audio_position_sec: 142,
    is_playing: true,
    device_id: "ipad-living-room",
    device_label: "Leo's iPad",
  });
  assert(
    synced.active_book_slug === "mastery" &&
      synced.audio_position_sec === 142 &&
      synced.connected_devices.length === 1,
    "FamilyRoom sync persists cross-device Read-Along position and connected device"
  );

  const chat = await askCastCompanion(db, mockEnv, {
    userId: "u-parent-1",
    profileId: "kid-leo",
    characterSlug: "mira",
    question: "What should I do when practicing feels frustrating?",
  });
  assert(
    chat.character.slug === "mira" &&
      chat.answer.length > 20 &&
      chat.badgeAwarded.includes("Still-Water"),
    "Cast Companion returns story-grounded Mira response and awards comprehension badge"
  );

  const badges = await listCastCompanionBadges(db, "u-parent-1", "kid-leo");
  assert(badges.length === 1 && badges[0].characterSlug === "mira", "Cast Companion badge is saved to child profile");
}

// ---- 4. Pillar 4: Smart Fulfillment Router & Phygital QR/NFC Unlocks ----
{
  const routeUs = await routePhysicalOrderFulfillment(db, {
    id: "ord_us_1",
    book_slugs: "mastery",
    items: JSON.stringify([{ slug: "mastery", format: "giftset", quantity: 1 }]),
    shipping_country: "US",
    has_physical: 1,
  });
  assert(
    routeUs?.mode === "mode_a_home_shippo" && routeUs.phygital_tokens.length === 1,
    "Single US $25 Gift Set routes to Mode A (Home Studio Shippo) and mints Phygital token"
  );

  const routeIntl = await routePhysicalOrderFulfillment(db, {
    id: "ord_uk_1",
    book_slugs: "richdadpoordad",
    items: JSON.stringify([{ slug: "richdadpoordad", format: "printed", quantity: 1 }]),
    shipping_country: "GB",
    has_physical: 1,
  });
  assert(
    routeIntl?.mode === "mode_b_pod",
    "International UK $20 Printed Book routes to Mode B (Global Print-on-Demand)"
  );

  const route3pl = await routePhysicalOrderFulfillment(db, {
    id: "ord_3pl_1",
    book_slugs: "mastery,algorithms",
    items: JSON.stringify([
      { slug: "mastery", format: "club_box", quantity: 2 },
      { slug: "mira-plush", format: "plush", quantity: 1 },
    ]),
    shipping_country: "US",
    has_physical: 1,
  });
  assert(
    route3pl?.mode === "mode_c_3pl",
    "Quarterly Club Box + Plush Toy order routes to Mode C (3PL Warehouse)"
  );

  const minted = await mintPhygitalClaimToken(db, {
    token: "bbs-mira-plush-001",
    skuType: "plush_toy",
    bookSlug: "algorithms",
    characterSlug: "fern",
  });
  const claimed = await redeemPhygitalClaim(db, minted.token, {
    id: "u-parent-1",
    email: "sarah@example.com",
  });
  assert(claimed.ok && claimed.claim?.claimed_by_user_id === "u-parent-1", "Phygital QR/NFC claim token redeems and unlocks book in orders");
  const summary = await getFulfillmentRouterSummary(db);
  assert(summary.phygitalStats.totalClaimed >= 1, "Fulfillment router tracks claimed Phygital tokens");
}

// ---- 5. Pillar 5: Reading Telemetry & Basin Lakehouse Streamer ----
{
  const tel = await recordReadingTelemetry(db, mockEnv, {
    bookSlug: "mastery",
    chapterNum: 1,
    pageIndex: 8,
    edition: "readalong",
    audioPositionSec: 185,
    audioDurationSec: 200,
    listenDeltaSec: 30,
  });
  assert(tel.completionPct === 93 && tel.isCompleted80 === true, "Reading telemetry computes 93% completion and flags 80%+ threshold");

  const basin = await streamToBasinPipeline(db, mockEnv, {
    tableTarget: "reading_iceberg",
    eventName: "chapter_completed",
    payload: { bookSlug: "mastery", chapterNum: 1 },
  });
  assert(basin.id.startsWith("basin_"), "Basin pipeline streamer logs structured Iceberg event");

  const telSummary = await getReadingTelemetrySummary(db);
  assert(telSummary.totalHeartbeats >= 1 && telSummary.readAlongSharePct === 100, "Telemetry summary calculates Read-Along share");
}

// ---- 6. Pillar 6: RevOps Lifecycle Engine (offers.ts, BDAY10, 80% Upsell, Club Retention) ----
{
  // Verify offers.ts constants match the exact store pricing
  assert(AUDIO_PRICE_CENTS === 199, "Audiobook only is $1.99");
  assert(STANDARD_DIGITAL_PRICE_CENTS === 899, "Digital bundle is $8.99");
  assert(STANDARD_PRINT_PRICE_CENTS === 2000, "Printed book is $20.00");
  assert(GIFT_SET_PRICE_CENTS === 2500, "Gift Set is $25.00");
  assert(CLUB_PRICE_CENTS === 6000 && CLUB_ANNUAL_PRICE_CENTS === 19900, "Book Club is $60/quarter or $199/year");
  assert(AUDIO_CLUB_PRICE_CENTS === 599 && AUDIO_CLUB_ANNUAL_PRICE_CENTS === 4900, "Audio Club is $5.99/month or $49/year");

  // 80% completion upsell for non-Club parent
  const upsell1 = await checkAndEnqueueCompletionUpsell(db, "https://bigbrainshelf.com", {
    userId: "u-parent-1",
    userEmail: "sarah@example.com",
    userName: "Sarah",
    bookSlug: "mastery",
    completionPct: 88,
  });
  assert(upsell1.triggered === true, "80% completion triggers Audio Club ($5.99/mo) & Book Club ($60/qtr) upsell email");
  const upsellDupe = await checkAndEnqueueCompletionUpsell(db, "https://bigbrainshelf.com", {
    userId: "u-parent-1",
    userEmail: "sarah@example.com",
    userName: "Sarah",
    bookSlug: "mastery",
    completionPct: 95,
  });
  assert(upsellDupe.triggered === false && upsellDupe.reason === "already_sent", "80% completion upsell is strictly deduped per user+book");

  // Birthday Gift Cron (`BDAY10` 10 days before child's birthday)
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS kid_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        birth_date TEXT,
        birthday_gift_sent_year INTEGER,
        age INTEGER DEFAULT 6,
        age_group TEXT DEFAULT '4-8',
        avatar_key TEXT DEFAULT 'mira',
        favorite_themes TEXT DEFAULT '[]',
        daily_limit_minutes INTEGER DEFAULT 60,
        default_sleep_timer_minutes INTEGER DEFAULT 60,
        bedtime_cutoff TEXT,
        allow_audio_autoplay INTEGER DEFAULT 1,
        allowed_book_slugs TEXT,
        daily_minutes_used INTEGER DEFAULT 0,
        daily_minutes_date TEXT,
        is_default INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT 0
      )`
    )
    .run();
  await db
    .prepare(
      "INSERT INTO kid_profiles (id, user_id, name, birth_date, age) VALUES ('kid-bday-1', 'u-parent-1', 'Leo', '2020-11-05', 6)"
    )
    .run();

  const bdayRun1 = await runBirthdayGiftScheduler(
    db,
    "https://bigbrainshelf.com",
    new Date("2026-10-31T15:00:00Z")
  );
  assert(bdayRun1.sent === 1, "Birthday cron sends BDAY10 email when child's birthday is within 10 days");
  const bdayRun2 = await runBirthdayGiftScheduler(
    db,
    "https://bigbrainshelf.com",
    new Date("2026-10-31T18:00:00Z")
  );
  assert(bdayRun2.sent === 0, "Birthday cron dedupes BDAY10 email for the same calendar year");

  // Club Retention Actions ($60/qtr physical Book Club -> Skip Box -> Switch to $5.99/mo Audio Club -> Upgrade to $49/yr Annual)
  await db
    .prepare(
      `INSERT INTO club_signups (id, user_id, name, email, shelf, status, plan, club_plan, first_ship_date, subscription_status, created_at)
       VALUES ('club-1', 'u-club-1', 'David Chen', 'david@example.com', 'courage', 'paid', 'quarterly', 'physical', '2026-10-31', 'active', 1700000000)`
    )
    .run();

  const skipRes = await applyClubRetentionAction(
    db,
    { id: "u-club-1", email: "david@example.com" },
    "skip_next_box"
  );
  assert(
    skipRes.ok && skipRes.updatedMember.first_ship_date === "2027-01-31",
    "Club retention 'skip_next_box' pushes $60/quarter physical box anchor forward by 3 months"
  );

  const switchAudioRes = await applyClubRetentionAction(
    db,
    { id: "u-club-1", email: "david@example.com" },
    "switch_to_audio_club"
  );
  assert(
    switchAudioRes.ok &&
      switchAudioRes.updatedMember.club_plan === "audio" &&
      switchAudioRes.updatedMember.plan === "monthly" &&
      switchAudioRes.message?.includes("$5.99/month"),
    "Club retention 'switch_to_audio_club' downsells $60/quarter Book Club to $5.99/month Audio Club"
  );

  const annualRes = await applyClubRetentionAction(
    db,
    { id: "u-club-1", email: "david@example.com" },
    "upgrade_to_annual"
  );
  assert(
    annualRes.ok &&
      annualRes.updatedMember.plan === "annual" &&
      annualRes.message?.includes("$49/year"),
    "Club retention 'upgrade_to_annual' upgrades Audio Club member to $49/year Annual plan"
  );

  const b2bScore = scoreAccountRevOps({
    email: "principal@oakridge.edu",
    readingGoal: "classroom curriculum",
    kidCount: 3,
    onboardingCompleted: true,
  });
  assert(
    b2bScore.isB2BInstitutional && b2bScore.lifecycleStage === "b2b_mql",
    "RevOps lead scorer identifies .edu / classroom accounts as B2B2C Institutional MQLs"
  );

  const metrics = await getRevOpsDashboardMetrics(db);
  assert(
    metrics.clubMetrics.audioAnnualActive === 1 &&
      metrics.clubMetrics.estimatedArrCents === AUDIO_CLUB_ANNUAL_PRICE_CENTS,
    "RevOps dashboard calculates exact ARR from active Club memberships"
  );
}

console.log(failures === 0 ? "\nALL TRANSMEDIA & REVOPS TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
