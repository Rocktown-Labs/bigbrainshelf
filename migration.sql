CREATE TABLE IF NOT EXISTS bibles (
  id TEXT PRIMARY KEY,
  book_slug TEXT NOT NULL UNIQUE,
  book_title TEXT NOT NULL,
  big_idea TEXT NOT NULL,
  setting TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  bible_id TEXT REFERENCES bibles(id),
  status TEXT NOT NULL DEFAULT 'draft',
  price INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  picture_book_key TEXT,
  coloring_book_key TEXT,
  cover_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  story_chapter TEXT NOT NULL,
  story_title TEXT NOT NULL,
  real_concept TEXT,
  takeaway TEXT,
  plan TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  species TEXT NOT NULL,
  source TEXT NOT NULL,
  personality TEXT,
  visual TEXT NOT NULL,
  real_maps_to TEXT,
  jpg_key TEXT,
  svg_key TEXT,
  created_at INTEGER NOT NULL
);

-- Better-auth tables (generated via `better-auth generate`, email+password)
create table if not exists "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table if not exists "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table if not exists "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table if not exists "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create index if not exists "session_userId_idx" on "session" ("userId");

create index if not exists "account_userId_idx" on "account" ("userId");

create index if not exists "verification_identifier_idx" on "verification" ("identifier");

-- Book Club subscribers (added 2026-10-27; POST /api/subscribe)
CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'footer',
  name TEXT
);

-- Newsletter subscriber name (added 2026-10-28): the footer form's
-- optional first name, stored on the subscriber row. Also ensured at
-- runtime by ensureSubscribersTable (src/lib/email-validate.ts) with
-- the same pragma pattern as the columns below.
ALTER TABLE subscribers ADD COLUMN name TEXT;

-- Checkout/delivery idempotency (added 2026-10-27, applied to production D1)
-- orders gains: delivery_token (per-order secret for emailed download
-- links), cart_fingerprint (checkout dedupe), physical_status (printed
-- pre-order fulfillment: preorder_received, in_print, shipped, delivered).
ALTER TABLE orders ADD COLUMN delivery_token TEXT;
ALTER TABLE orders ADD COLUMN cart_fingerprint TEXT;
ALTER TABLE orders ADD COLUMN physical_status TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS orders_delivery_token_idx ON orders(delivery_token) WHERE delivery_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_pending_fp_idx ON orders(user_id, cart_fingerprint) WHERE status = 'pending';

-- Every Stripe webhook event id is recorded before processing; a replay
-- of a fully processed event is skipped.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  result TEXT
);

-- Every buyer email is enqueued here first; the unique (order_id, kind)
-- index guarantees exactly one email of each kind per order. Rows are
-- marked sent only when the provider accepts them.
CREATE TABLE IF NOT EXISTS email_outbox (
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
  sent_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS email_outbox_order_kind_idx ON email_outbox(order_id, kind) WHERE order_id IS NOT NULL;

-- Audiobook deliverable (key set when a book's audiobook file exists).
ALTER TABLE books ADD COLUMN audiobook_key TEXT;

-- Audio Cast verdicts (added 2026-10-27, applied to production D1).
-- One row per (voice_model, lang): the admin's No / Maybe / Yes verdict
-- for each Deepgram Aura-2 voice in the /admin/cast audition tool.
CREATE TABLE IF NOT EXISTS cast_ratings (
  voice_model TEXT NOT NULL,
  lang TEXT NOT NULL,
  verdict TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (voice_model, lang)
);

-- Audio Cast A Team verdicts (added 2026-10-27, applied to production D1).
-- Parallel to cast_ratings so Gemini verdicts (/admin/cast-gemini) never
-- collide with the Aura B Team's rows. One row per (voice_id, lang).
CREATE TABLE IF NOT EXISTS cast_ratings_gemini (
  voice_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  verdict TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (voice_id, lang)
);

-- Book Club founding queue (added 2026-10-27, applied to production D1).
-- Signups from /book-club: 'queued' (founding) until the club goes live
-- on 2027-01-01, then 'live'. No billing attached in this pass.
CREATE TABLE IF NOT EXISTS club_signups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  shelf TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL
);

-- Customer reviews (added 2026-10-27, applied to production D1).
-- Every review starts 'pending' and is only public once an admin
-- approves it in /admin/reviews. Media lives in R2 under reviews/.
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  book_slug TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  rating INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  media_keys TEXT NOT NULL DEFAULT '[]',
  video_key TEXT,
  verified_purchase INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_book_status_idx ON reviews(book_slug, status);
CREATE INDEX IF NOT EXISTS reviews_user_idx ON reviews(user_id);

-- Shipping + Shippo labels (Phase 5, added 2026-10-27, applied to
-- production D1). Stripe Checkout collects the shipping address for
-- physical orders; Shippo label purchases store carrier, tracking and
-- the label PDF URL on the order.
ALTER TABLE orders ADD COLUMN ship_name TEXT;
ALTER TABLE orders ADD COLUMN ship_address TEXT;
ALTER TABLE orders ADD COLUMN shipping_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN carrier TEXT;
ALTER TABLE orders ADD COLUMN tracking_number TEXT;
ALTER TABLE orders ADD COLUMN label_url TEXT;
ALTER TABLE orders ADD COLUMN shippo_shipment_id TEXT;
ALTER TABLE orders ADD COLUMN shippo_transaction_id TEXT;

-- Carrier tracking status text (2026-10-29): the scheduled Shippo
-- tracking poll stores the carrier's latest status detail on shipped
-- orders; ensured at runtime by ensureOrderTrackingColumns in
-- src/lib/shippo.ts, mirrored here like the other runtime columns.
ALTER TABLE orders ADD COLUMN tracking_status TEXT;

-- Pass-through shipping (2026-10-28): checkout quotes the real Shippo
-- rate for the buyer's address and charges exactly that. The order
-- stores the quoted carrier + service level and the Shippo rate id
-- (shipping_cents, ship_name and ship_address carry the charge and the
-- destination) so fulfillment can buy the quoted rate and surface any
-- label-cost difference. Also mirrored at runtime by
-- ensureOrderQuoteColumns in src/lib/shippo.ts.
ALTER TABLE orders ADD COLUMN quoted_carrier TEXT;
ALTER TABLE orders ADD COLUMN quoted_service TEXT;
ALTER TABLE orders ADD COLUMN shippo_rate_id TEXT;

-- Book Club paid membership (Workstream 2, added 2026-10-27, applied
-- to production D1). Membership requires an account and charges today
-- via a Stripe subscription; the webhook marks rows paid/canceled.
-- Also mirrored at runtime by ensureClubTable in src/lib/club.ts.
ALTER TABLE club_signups ADD COLUMN user_id TEXT;
ALTER TABLE club_signups ADD COLUMN plan TEXT;
ALTER TABLE club_signups ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE club_signups ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE club_signups ADD COLUMN first_ship_date TEXT;
ALTER TABLE club_signups ADD COLUMN paid_at INTEGER;
ALTER TABLE club_signups ADD COLUMN canceled_at INTEGER;

-- Club funnel emails (Workstream 3, added 2026-10-27, applied to
-- production D1). send_after delays an outbox row (the day-3 club
-- follow-up); from_email overrides the sender (marketing sends from
-- news@). Marketing opt-outs and unsubscribe tokens live in their own
-- tables; transactional order mail never consults them. Also mirrored
-- at runtime by ensureOutboxColumns (src/lib/orders.ts) and
-- ensureMarketingTables (src/lib/marketing.ts).
ALTER TABLE email_outbox ADD COLUMN send_after INTEGER;
ALTER TABLE email_outbox ADD COLUMN from_email TEXT;
CREATE TABLE IF NOT EXISTS marketing_opt_outs (
  email TEXT PRIMARY KEY,
  unsubscribed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_unsubscribe_tokens (
  email TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE
);

-- Book Club V2: cycles, book choice, billing health, and a real
-- scheduler (added 2026-10-28). Mirrored at runtime by
-- ensureClubCycleTables (src/lib/club-cycles.ts), ensureClubTable
-- (src/lib/club.ts), and ensureOutboxColumns (src/lib/orders.ts), so
-- production upgrades in place when the code runs; this section is the
-- schema record. One club_cycle_boxes row per member per quarterly
-- ship date (Jan 1 / Apr 1 / Jul 1 / Oct 1); the worker cron (every 15
-- minutes, registered by deploy.py) generates, reminds, locks, and
-- resolves them.
ALTER TABLE club_signups ADD COLUMN subscription_status TEXT;
ALTER TABLE club_signups ADD COLUMN payment_failed_at INTEGER;

-- Club plans (added 2026-10-28, CG rethink): club_plan is the plan
-- dimension, 'physical' (printed boxes + all-access digital) or
-- 'audio' (Audio Club, listening only). Distinct from the older plan
-- column, which is the billing period (quarterly | annual | monthly).
-- Rows that predate it carry NULL and are physical. Also mirrored at
-- runtime by ensureClubTable in src/lib/club.ts.
ALTER TABLE club_signups ADD COLUMN club_plan TEXT DEFAULT 'physical';
CREATE TABLE IF NOT EXISTS club_cycle_boxes (
  id TEXT PRIMARY KEY,
  signup_id TEXT NOT NULL,
  ship_date TEXT NOT NULL,
  selected_book_slug TEXT,
  resolved_book_slug TEXT,
  selection_source TEXT NOT NULL DEFAULT 'surprise',
  allow_repeat INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'awaiting_selection',
  carrier TEXT,
  tracking_number TEXT,
  label_url TEXT,
  locked_at INTEGER,
  shipped_at INTEGER,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (signup_id, ship_date)
);
CREATE INDEX IF NOT EXISTS club_cycle_boxes_signup_ship_idx ON club_cycle_boxes(signup_id, ship_date);
CREATE INDEX IF NOT EXISTS club_cycle_boxes_ship_status_idx ON club_cycle_boxes(ship_date, status);
CREATE INDEX IF NOT EXISTS club_cycle_boxes_status_ship_idx ON club_cycle_boxes(status, ship_date);
CREATE INDEX IF NOT EXISTS club_signups_status_idx ON club_signups(status, created_at);
CREATE INDEX IF NOT EXISTS orders_user_status_idx ON orders(user_id, status);
CREATE INDEX IF NOT EXISTS orders_email_status_idx ON orders(email, status);
-- Cycle emails are not order mail: dedupe_key carries the unique
-- idempotency key club_box:{boxId}:{kind} (one send per member, cycle,
-- and kind) and club_box_id links the outbox row to its cycle box so
-- the HTML renderer can rebuild the model at send time.
ALTER TABLE email_outbox ADD COLUMN dedupe_key TEXT;
ALTER TABLE email_outbox ADD COLUMN club_box_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS email_outbox_dedupe_idx ON email_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Digital bundle price (2026-10-27, applied to production D1): Mira's
-- digital bundle includes its audiobook when books.audiobook_key is
-- set, and the digital price is $8.99.
UPDATE books
SET price = 899,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE slug = 'mastery';
UPDATE books
SET audiobook_key = 'books/mastery/audiobook.m4b',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE slug = 'mastery';

-- Docker price correction (2026-10-27, applied to production D1):
-- Wally's digital price was a stale 699 left over from the retired
-- $6.99 bundle price; the standard digital price is $8.99 (its
-- price_print was already the standard 2000). One-time correction,
-- separate from the publish stamp: every other row is untouched, and
-- the 0/0 books pick up the standard prices from the publish action
-- (publishPriceStamp in src/lib/offers.ts) when they are published.
UPDATE books
SET price = 899,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE slug = 'docker';

-- Page takes (2026-10-28, applied to production D1): the editor's
-- Takes UI records every archived-version pick applied to a page (or,
-- for a whole-book load, to each page) so the choice is auditable.
CREATE TABLE IF NOT EXISTS page_takes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_slug TEXT NOT NULL,
  chapter_num INTEGER NOT NULL,
  page_index INTEGER NOT NULL,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS page_takes_book_idx ON page_takes (book_slug, chapter_num, page_index);

-- Page takes twin handling (2026-10-28, applied to production D1):
-- whether the version's color twin was applied alongside the line take,
-- and the plain-language note recorded when the version had no color
-- copy (the color page then predates the line art; the next colorize
-- redoes it and discards the current color art).
ALTER TABLE page_takes ADD COLUMN twin_applied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page_takes ADD COLUMN twin_note TEXT;

-- Casting registry (2026-10-28, applied to production D1): casting is
-- per CHARACTER and persistent across books and versions (CG's casting
-- model). character_voices is the registry; voice_assignment_log is the
-- audit trail. `source` marks the casts that already shipped in
-- published audiobooks ('recorded') versus page assignments ('admin').
CREATE TABLE IF NOT EXISTS character_voices (
  character_name TEXT PRIMARY KEY,
  voice_id TEXT,
  voice_name TEXT,
  first_book_slug TEXT,
  source TEXT NOT NULL DEFAULT 'admin',
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS voice_assignment_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_name TEXT,
  voice_id TEXT,
  book_slug TEXT,
  action TEXT,
  created_at INTEGER
);
-- Recorded casts of record (working casts, revisable from the casting
-- page): Mira's published audiobook is Kore, Wally's is Riko, Basil's
-- is Enzo. INSERT OR IGNORE so a later admin assignment always wins.
INSERT OR IGNORE INTO character_voices (character_name, voice_id, voice_name, first_book_slug, source, updated_at)
VALUES ('Mira', 'kore', 'Kore', 'mastery', 'recorded', CAST(strftime('%s', 'now') AS INTEGER));
INSERT OR IGNORE INTO character_voices (character_name, voice_id, voice_name, first_book_slug, source, updated_at)
VALUES ('Wally', 'riko', 'Riko', 'docker', 'recorded', CAST(strftime('%s', 'now') AS INTEGER));
INSERT OR IGNORE INTO character_voices (character_name, voice_id, voice_name, first_book_slug, source, updated_at)
VALUES ('Basil', 'enzo', 'Enzo', 'designpatterns', 'recorded', CAST(strftime('%s', 'now') AS INTEGER));

-- Release announcements (2026-10-28, applied to production D1):
-- books.published_at is stamped (unix seconds) by the publish action
-- the FIRST time a book is published and never overwritten; it drives
-- the public "Published {date}" line and the two announcement waves
-- (Book Club members first, subscribers +3 days) enqueued through the
-- email outbox with dedupe keys release:{slug}:{wave}:{email}. Also
-- ensured at runtime by ensurePublishedAtColumn (src/lib/releases.ts).
ALTER TABLE books ADD COLUMN published_at INTEGER;

-- Story Review notes (2026-10-28): per-page QC notes CG leaves while
-- listening to the audiobook and scrolling the pages in
-- /admin/books/[slug]/review. page_key is "{chapterNum}:{pageIndex}"
-- (chapter 1-based, page 0-based), the same page identity the
-- change-request / redo machinery uses, so the future redo queue can
-- consume these rows directly. Also ensured at runtime by
-- ensureReviewNotesTable (src/lib/review-notes.ts).
CREATE TABLE IF NOT EXISTS review_notes (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  page_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'line',
  note TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS review_notes_slug_idx ON review_notes(slug, page_key);

-- Lift jobs (2026-10-28): the async queue behind the cast crop
-- editor's "Lift this pose" action. The editor enqueues a row with a
-- snapshot of the pose's saved box; the VM lift worker service claims
-- jobs over /api/lift/worker (bearer LIFT_WORKER_TOKEN), runs the
-- matte pipeline, and posts back a transparent cutout + a placed
-- composition, which the hub lands on the gallery via applyLiftedPose
-- (the pose's poseMeta gains lifted/cutoutKey/liftedBox). Also ensured
-- at runtime by ensureLiftJobsTable (src/lib/lift-jobs.ts).
CREATE TABLE IF NOT EXISTS lift_jobs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  pose_index INTEGER NOT NULL,
  box TEXT NOT NULL,
  sheet_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS lift_jobs_slug_idx ON lift_jobs(slug, created_at);
CREATE INDEX IF NOT EXISTS lift_jobs_status_idx ON lift_jobs(status, created_at);

-- Shippo label detail (added 2026-10-28, applied to production D1).
-- carrier/tracking/label_url already exist from Phase 5; the label
-- flow now also stores the chosen service level and the actual label
-- cost. Also ensured at runtime by ensureOrderLabelColumns
-- (src/lib/shippo.ts).
ALTER TABLE orders ADD COLUMN carrier_service TEXT;
ALTER TABLE orders ADD COLUMN label_cost_cents INTEGER;

-- Public book slugs (added 2026-10-28): title-based public URLs.
-- The internal books.slug stays the system key (D1 joins, R2 paths,
-- factory, admin, orders); public_slug is the slug public routes
-- carry (/books/{public_slug}, /read/{public_slug}), slugified from
-- the book title, so public links stop referencing the source
-- material the books were adapted from. Minted by the publish path
-- (ensureBookPublicSlug in src/lib/public-slugs.ts) and backfilled
-- for the existing catalog; also ensured at runtime there with the
-- same pragma pattern as the columns above.
ALTER TABLE books ADD COLUMN public_slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS books_public_slug_idx ON books(public_slug);

-- Download counts (added 2026-10-29): the per-purchase download
-- budget for owned files (5 per file kind), keyed by the granting
-- order (or "club-box:{id}" for books that arrived in a shipped club
-- box). Written by both download routes so the account library and
-- the guest email links share one budget per purchase. Also ensured
-- at runtime by ensureDownloadCountsTable (src/lib/download-guard.ts).
CREATE TABLE IF NOT EXISTS download_counts (
  grant_key TEXT NOT NULL,
  order_id TEXT,
  slug TEXT NOT NULL,
  file_kind TEXT NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (grant_key, slug, file_kind)
);
CREATE INDEX IF NOT EXISTS download_counts_order_idx ON download_counts(order_id);


-- Family Onboarding, Kid Profiles & Synced Reading/Listening Progress (2026-10-31):
-- Parent onboarding preferences & PIN gate, switchable Kid Profiles (ages 4-8,
-- 9-12, 13-18) with daily time budgets and default sleep timers, and synced
-- book viewer + audiobook playback state.
CREATE TABLE IF NOT EXISTS parent_onboarding (
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
);

CREATE TABLE IF NOT EXISTS kid_profiles (
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
);
CREATE INDEX IF NOT EXISTS kid_profiles_user_idx ON kid_profiles(user_id, created_at);

CREATE TABLE IF NOT EXISTS reading_progress (
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL DEFAULT 'parent',
  book_slug TEXT NOT NULL,
  chapter_num INTEGER NOT NULL DEFAULT 1,
  page_index INTEGER NOT NULL DEFAULT 0,
  view_edition TEXT NOT NULL DEFAULT 'story',
  view_mode TEXT NOT NULL DEFAULT 'flip',
  audio_track_id TEXT NOT NULL DEFAULT 'ch1',
  audio_position_sec INTEGER NOT NULL DEFAULT 0,
  audio_duration_sec INTEGER NOT NULL DEFAULT 0,
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  daily_minutes_used INTEGER NOT NULL DEFAULT 0,
  usage_date TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, profile_id, book_slug)
);
CREATE INDEX IF NOT EXISTS reading_progress_user_updated_idx ON reading_progress(user_id, updated_at);

-- Better Auth username & admin plugin columns on "user"
ALTER TABLE "user" ADD COLUMN username TEXT;
ALTER TABLE "user" ADD COLUMN displayUsername TEXT;
ALTER TABLE "user" ADD COLUMN role TEXT DEFAULT 'user';
ALTER TABLE "user" ADD COLUMN banned INTEGER DEFAULT 0;
ALTER TABLE "user" ADD COLUMN banReason TEXT;
ALTER TABLE "user" ADD COLUMN banExpires INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS user_username_idx ON "user"(username) WHERE username IS NOT NULL;

-- Better Auth passkey plugin + rate-limit tables (2026-10-31).
-- Both also self-heal at runtime via ensureAuthUserSchema.
CREATE TABLE IF NOT EXISTS "passkey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT,
  "publicKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "credentialID" TEXT NOT NULL,
  "counter" INTEGER NOT NULL,
  "deviceType" TEXT NOT NULL,
  "backedUp" INTEGER NOT NULL,
  "transports" TEXT,
  "createdAt" DATE,
  "aaguid" TEXT
);
CREATE INDEX IF NOT EXISTS passkey_userId_idx ON "passkey"("userId");
CREATE INDEX IF NOT EXISTS passkey_credentialID_idx ON "passkey"("credentialID");
CREATE TABLE IF NOT EXISTS "rateLimit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "lastRequest" INTEGER NOT NULL
);

-- Transmedia & RevOps tables (2026-10)
-- Note: D1 tables for vector_embeddings, family_sync_rooms, reading_telemetry_rollups,
-- and basin_event_log act as local metadata / fallback scaffolding when Cloudflare Vectorize,
-- FamilyRoomDurableObject, Workers Analytics Engine, or Basin bindings are not yet provisioned.
CREATE TABLE IF NOT EXISTS vector_embeddings (
  id TEXT PRIMARY KEY,
  index_name TEXT NOT NULL,
  book_slug TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content_text TEXT NOT NULL,
  age_band TEXT,
  topic_tags_json TEXT NOT NULL DEFAULT '[]',
  embedding_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vector_embeddings_index_slug_idx ON vector_embeddings(index_name, book_slug);
CREATE INDEX IF NOT EXISTS vector_embeddings_entity_idx ON vector_embeddings(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS generation_cost_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_slug TEXT NOT NULL,
  stage TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'vercel-ai-gateway',
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
  gateway_cached INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS generation_cost_book_stage_idx ON generation_cost_ledger(book_slug, stage);
CREATE INDEX IF NOT EXISTS generation_cost_created_idx ON generation_cost_ledger(created_at);

CREATE TABLE IF NOT EXISTS family_sync_rooms (
  family_user_id TEXT PRIMARY KEY,
  active_kid_id INTEGER,
  active_book_slug TEXT,
  active_format TEXT NOT NULL DEFAULT 'story',
  chapter_index INTEGER NOT NULL DEFAULT 0,
  page_index INTEGER NOT NULL DEFAULT 0,
  audio_position_sec REAL NOT NULL DEFAULT 0,
  is_playing INTEGER NOT NULL DEFAULT 0,
  auto_flip_enabled INTEGER NOT NULL DEFAULT 1,
  daily_limit_minutes INTEGER NOT NULL DEFAULT 45,
  minutes_used_today REAL NOT NULL DEFAULT 0,
  last_activity_date TEXT,
  active_device_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS family_sync_rooms_updated_idx ON family_sync_rooms(updated_at);

CREATE TABLE IF NOT EXISTS cast_companion_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kid_profile_id INTEGER,
  book_slug TEXT NOT NULL,
  character_name TEXT NOT NULL,
  question_text TEXT NOT NULL,
  response_text TEXT NOT NULL,
  comprehension_badge TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cast_companion_user_book_idx ON cast_companion_sessions(user_id, book_slug);

CREATE TABLE IF NOT EXISTS reading_telemetry_rollups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_slug TEXT NOT NULL,
  chapter_index INTEGER NOT NULL DEFAULT 0,
  page_index INTEGER NOT NULL DEFAULT 0,
  event_type TEXT NOT NULL,
  total_events INTEGER NOT NULL DEFAULT 0,
  avg_dwell_seconds REAL NOT NULL DEFAULT 0,
  replay_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reading_telemetry_unique_idx ON reading_telemetry_rollups(book_slug, chapter_index, page_index, event_type);

CREATE TABLE IF NOT EXISTS basin_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_name TEXT NOT NULL,
  event_name TEXT NOT NULL,
  user_id TEXT,
  book_slug TEXT,
  revenue_cents INTEGER NOT NULL DEFAULT 0,
  cogs_cents INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  synced_to_basin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS basin_event_stream_created_idx ON basin_event_log(stream_name, created_at);
CREATE INDEX IF NOT EXISTS basin_event_book_idx ON basin_event_log(book_slug);

CREATE TABLE IF NOT EXISTS revops_lifecycle_events (
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
);
CREATE INDEX IF NOT EXISTS revops_lifecycle_email_idx ON revops_lifecycle_events(email, play_type);

-- Promo codes (2026-11-01, src/lib/promo.ts; also ensured at
-- runtime so a deploy never depends on this file being applied).
CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  percent_off INTEGER NOT NULL,
  min_subtotal_cents INTEGER NOT NULL DEFAULT 0,
  max_redemptions INTEGER NOT NULL,
  grant_months INTEGER NOT NULL DEFAULT 12,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE,
  email TEXT,
  user_id TEXT,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reserved',
  note TEXT,
  club_signup_id TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
INSERT OR IGNORE INTO promo_codes (code, percent_off, min_subtotal_cents, max_redemptions, grant_months, active, created_at)
VALUES ('FOUNDING15', 15, 3000, 10, 12, 1, 1793577600);
ALTER TABLE orders ADD COLUMN promo_code TEXT;
ALTER TABLE orders ADD COLUMN promo_discount_cents INTEGER;
ALTER TABLE club_signups ADD COLUMN comp_until INTEGER;

-- Retired public slugs keep resolving after a rename (2026-11-02):
-- resolveBookForPublicRoute consults this table after live public
-- slugs and 301s alias hits to the book's canonical public URL.
CREATE TABLE IF NOT EXISTS book_slug_aliases (
  alias TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  created_at INTEGER
);
