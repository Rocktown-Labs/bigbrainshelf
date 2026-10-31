import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// Story bibles: one per book. The source of truth for characters, concepts, metaphors.
export const bibles = sqliteTable("bibles", {
  id: text("id").primaryKey(),
  bookSlug: text("book_slug").notNull().unique(),
  bookTitle: text("book_title").notNull(),
  bigIdea: text("big_idea").notNull(),
  setting: text("setting").notNull(),
  // JSON: characters[], locations[], conceptLadder[], arc{}, runningGags[], vocab[]
  data: text("data").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Books: the final products. status=complete shows on the public storefront.
export const books = sqliteTable(
  "books",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    publicSlug: text("public_slug"),
    title: text("title").notNull(),
    bibleId: text("bible_id").references(() => bibles.id),
    status: text("status").notNull().default("draft"), // draft | in_progress | ready_for_qa | complete | failed
    stage: text("stage"),
    stageDetail: text("stage_detail"),
    topic: text("topic").default("tech"),
    topics: text("topics"),
    price: integer("price").notNull().default(0), // digital price in cents
    pricePrint: integer("price_print").default(0), // printed price in cents
    description: text("description"),
    // R2 keys for deliverables
    pictureBookKey: text("picture_book_key"),
    coloringBookKey: text("coloring_book_key"),
    epubKey: text("epub_key"),
    colorBookKey: text("color_book_key"),
    audiobookKey: text("audiobook_key"),
    videoKey: text("video_key"),
    coverKey: text("cover_key"),
    publishedAt: integer("published_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("books_public_slug_idx").on(table.publicSlug)]
);

// Chapters: story chapters within a book.
export const chapters = sqliteTable("chapters", {
  id: text("id").primaryKey(),
  bookId: text("book_id")
    .notNull()
    .references(() => books.id),
  storyChapter: text("story_chapter").notNull(), // S1, S2, ...
  storyTitle: text("story_title").notNull(),
  realConcept: text("real_concept"),
  takeaway: text("takeaway"),
  // JSON: pages[{characters[], imagePrompt, storyText}], newStorySoFar
  plan: text("plan"),
  status: text("status").notNull().default("planned"), // planned | art_done | complete
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Characters: the reusable character library.
export const characters = sqliteTable("characters", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  species: text("species").notNull(),
  source: text("source").notNull(), // cover | library | invented
  personality: text("personality"), // JSON array
  visual: text("visual").notNull(), // image-safe description
  realMapsTo: text("real_maps_to"),
  // R2 keys for the art
  jpgKey: text("jpg_key"),
  svgKey: text("svg_key"),
  sheetApproved: integer("sheet_approved").default(0),
  createdAt: integer("created_at").notNull(),
});

// Orders: storefront purchases, club day-one grants, and physical fulfillment.
export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    email: text("email").notNull(),
    bookSlugs: text("book_slugs").notNull(),
    items: text("items"),
    stripeSessionId: text("stripe_session_id").unique(),
    amount: integer("amount").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    status: text("status").notNull().default("pending"), // pending | complete | expired
    deliveryToken: text("delivery_token"),
    cartFingerprint: text("cart_fingerprint"),
    physicalStatus: text("physical_status"), // preorder_received | in_print | packed | shipped | delivered
    shipName: text("ship_name"),
    shipAddress: text("ship_address"),
    shippingCents: integer("shipping_cents").notNull().default(0),
    carrier: text("carrier"),
    carrierService: text("carrier_service"),
    trackingNumber: text("tracking_number"),
    trackingStatus: text("tracking_status"),
    labelUrl: text("label_url"),
    labelCostCents: integer("label_cost_cents"),
    shippoShipmentId: text("shippo_shipment_id"),
    shippoTransactionId: text("shippo_transaction_id"),
    quotedCarrier: text("quoted_carrier"),
    quotedService: text("quoted_service"),
    shippoRateId: text("shippo_rate_id"),
    seenAt: integer("seen_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("orders_user_status_idx").on(table.userId, table.status),
    index("orders_email_status_idx").on(table.email, table.status),
  ]
);

// Stripe webhook idempotency log.
export const webhookEvents = sqliteTable("webhook_events", {
  eventId: text("event_id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: integer("received_at").notNull(),
  processedAt: integer("processed_at"),
  result: text("result"),
});

// Transactional & lifecycle email outbox.
export const emailOutbox = sqliteTable("email_outbox", {
  id: text("id").primaryKey(),
  orderId: text("order_id"),
  kind: text("kind").notNull(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  bodyText: text("body_text").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  sendAfter: integer("send_after"),
  fromEmail: text("from_email"),
  dedupeKey: text("dedupe_key"),
  clubBoxId: text("club_box_id"),
  createdAt: integer("created_at").notNull(),
  sentAt: integer("sent_at"),
});

// Newsletter subscribers.
export const subscribers = sqliteTable("subscribers", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  source: text("source").notNull().default("footer"),
  createdAt: integer("created_at").notNull(),
});

// Marketing opt-outs and unsubscribe tokens.
export const marketingOptOuts = sqliteTable("marketing_opt_outs", {
  email: text("email").primaryKey(),
  unsubscribedAt: integer("unsubscribed_at").notNull(),
});

export const emailUnsubscribeTokens = sqliteTable("email_unsubscribe_tokens", {
  email: text("email").primaryKey(),
  token: text("token").notNull().unique(),
});

// Book Club & Audio Club memberships.
export const clubSignups = sqliteTable(
  "club_signups",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    shelf: text("shelf").notNull(),
    status: text("status").notNull().default("queued"), // queued | live | paid | canceled
    userId: text("user_id"),
    plan: text("plan"), // quarterly | annual | monthly
    clubPlan: text("club_plan").default("physical"), // physical | audio
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    subscriptionStatus: text("subscription_status"),
    firstShipDate: text("first_ship_date"),
    paidAt: integer("paid_at"),
    canceledAt: integer("canceled_at"),
    paymentFailedAt: integer("payment_failed_at"),
    seenAt: integer("seen_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("club_signups_status_idx").on(table.status, table.createdAt)]
);

// Book Club V2 quarterly cycle boxes.
export const clubCycleBoxes = sqliteTable(
  "club_cycle_boxes",
  {
    id: text("id").primaryKey(),
    signupId: text("signup_id").notNull(),
    shipDate: text("ship_date").notNull(),
    selectedBookSlug: text("selected_book_slug"),
    resolvedBookSlug: text("resolved_book_slug"),
    secondSelectedBookSlug: text("second_selected_book_slug"),
    secondResolvedBookSlug: text("second_resolved_book_slug"),
    selectionSource: text("selection_source").notNull().default("surprise"),
    allowRepeat: integer("allow_repeat").notNull().default(0),
    status: text("status").notNull().default("awaiting_selection"),
    carrier: text("carrier"),
    trackingNumber: text("tracking_number"),
    labelUrl: text("label_url"),
    lockedAt: integer("locked_at"),
    shippedAt: integer("shipped_at"),
    deliveredAt: integer("delivered_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("club_cycle_boxes_signup_ship_idx").on(table.signupId, table.shipDate),
    index("club_cycle_boxes_ship_status_idx").on(table.shipDate, table.status),
    index("club_cycle_boxes_status_ship_idx").on(table.status, table.shipDate),
  ]
);

// Customer reviews.
export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    bookSlug: text("book_slug").notNull(),
    userId: text("user_id").notNull(),
    userEmail: text("user_email").notNull(),
    displayName: text("display_name").notNull(),
    rating: integer("rating").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    mediaKeys: text("media_keys").notNull().default("[]"),
    videoKey: text("video_key"),
    verifiedPurchase: integer("verified_purchase").notNull().default(0),
    status: text("status").notNull().default("pending"),
    seenAt: integer("seen_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("reviews_book_status_idx").on(table.bookSlug, table.status),
    index("reviews_user_idx").on(table.userId),
  ]
);

// Cast ratings & voice registry.
export const castRatings = sqliteTable(
  "cast_ratings",
  {
    voiceModel: text("voice_model").notNull(),
    lang: text("lang").notNull(),
    verdict: text("verdict").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.voiceModel, table.lang] })]
);

export const castRatingsGemini = sqliteTable(
  "cast_ratings_gemini",
  {
    voiceId: text("voice_id").notNull(),
    lang: text("lang").notNull(),
    verdict: text("verdict").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.voiceId, table.lang] })]
);

export const characterVoices = sqliteTable("character_voices", {
  characterName: text("character_name").primaryKey(),
  voiceId: text("voice_id"),
  voiceName: text("voice_name"),
  firstBookSlug: text("first_book_slug"),
  source: text("source").notNull().default("admin"),
  updatedAt: integer("updated_at"),
});

export const voiceAssignmentLog = sqliteTable("voice_assignment_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  characterName: text("character_name"),
  voiceId: text("voice_id"),
  bookSlug: text("book_slug"),
  action: text("action"),
  createdAt: integer("created_at"),
});

// Editorial & QC tables.
export const pageTakes = sqliteTable(
  "page_takes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookSlug: text("book_slug").notNull(),
    chapterNum: integer("chapter_num").notNull(),
    pageIndex: integer("page_index").notNull(),
    version: integer("version").notNull(),
    appliedAt: text("applied_at").notNull(),
    twinApplied: integer("twin_applied").notNull().default(0),
    twinNote: text("twin_note"),
  },
  (table) => [index("page_takes_book_idx").on(table.bookSlug, table.chapterNum, table.pageIndex)]
);

export const reviewNotes = sqliteTable(
  "review_notes",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    pageKey: text("page_key").notNull(),
    kind: text("kind").notNull().default("line"),
    note: text("note").notNull().default(""),
    tags: text("tags").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
    resolved: integer("resolved").notNull().default(0),
  },
  (table) => [index("review_notes_slug_idx").on(table.slug, table.pageKey)]
);

export const liftJobs = sqliteTable(
  "lift_jobs",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    poseIndex: integer("pose_index").notNull(),
    box: text("box").notNull(),
    sheetKey: text("sheet_key").notNull().default(""),
    status: text("status").notNull().default("queued"),
    error: text("error"),
    attemptCount: integer("attempt_count").notNull().default(0),
    workerId: text("worker_id"),
    cutoutKey: text("cutout_key"),
    compositeKey: text("composite_key"),
    liftedBox: text("lifted_box"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    index("lift_jobs_slug_idx").on(table.slug, table.createdAt),
    index("lift_jobs_status_idx").on(table.status, table.createdAt),
  ]
);

export const publishOverrides = sqliteTable("publish_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bookSlug: text("book_slug").notNull(),
  createdAt: integer("created_at").notNull(),
  reasons: text("reasons").notNull(),
  state: text("state").notNull(),
  protagonist: text("protagonist"),
  castVoiceId: text("cast_voice_id"),
  audiobookVoiceId: text("audiobook_voice_id"),
});

export const bookQa = sqliteTable("book_qa", {
  bookSlug: text("book_slug").primaryKey(),
  coverApproved: integer("cover_approved").notNull().default(0),
  storyApproved: integer("story_approved").notNull().default(0),
  printTestOrdered: integer("print_test_ordered").notNull().default(0),
  printTestApproved: integer("print_test_approved").notNull().default(0),
  linePurity: integer("line_purity"),
  notes: text("notes").notNull().default(""),
  updatedAt: integer("updated_at").notNull(),
});

export const bookMarketing = sqliteTable("book_marketing", {
  bookSlug: text("book_slug").primaryKey(),
  hook: text("hook").notNull().default(""),
  parentAngle: text("parent_angle").notNull().default(""),
  adCopyShort: text("ad_copy_short").notNull().default(""),
  adCopyLong: text("ad_copy_long").notNull().default(""),
  launchChecklist: text("launch_checklist").notNull().default("{}"),
  updatedAt: integer("updated_at").notNull(),
});

export const downloadCounts = sqliteTable(
  "download_counts",
  {
    grantKey: text("grant_key").notNull(),
    orderId: text("order_id"),
    slug: text("slug").notNull(),
    fileKind: text("file_kind").notNull(),
    downloadCount: integer("download_count").notNull().default(0),
    updatedAt: integer("updated_at").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.grantKey, table.slug, table.fileKind] }),
    index("download_counts_order_idx").on(table.orderId),
  ]
);

// ---------------------------------------------------------------------------
// Family Onboarding, Kid Profiles & Synced Reading/Listening Progress
// ---------------------------------------------------------------------------

export const parentOnboarding = sqliteTable("parent_onboarding", {
  userId: text("user_id").primaryKey(),
  parentName: text("parent_name"),
  familyNickname: text("family_nickname"),
  discoverySource: text("discovery_source"),
  readingGoals: text("reading_goals"),
  favoriteTopics: text("favorite_topics").default('["tech","money","courage"]'),
  futureTopics: text("future_topics").default("[]"),
  customTopicRequest: text("custom_topic_request"),
  tosAccepted: integer("tos_accepted").notNull().default(0),
  tosAcceptedAt: integer("tos_accepted_at"),
  marketingOptIn: integer("marketing_opt_in").notNull().default(0),
  referralCode: text("referral_code"),
  referredByCode: text("referred_by_code"),
  parentPin: text("parent_pin"),
  onboardingStep: integer("onboarding_step").notNull().default(1),
  completedAt: integer("completed_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const kidProfiles = sqliteTable(
  "kid_profiles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    birthDate: text("birth_date"),
    birthdayGiftSentYear: integer("birthday_gift_sent_year"),
    age: integer("age").notNull().default(6),
    ageGroup: text("age_group").notNull().default("4-8"), // "4-8" | "9-12" | "13-18"
    avatarKey: text("avatar_key").notNull().default("mira"), // mira | penny | fern | wally | basil
    favoriteThemes: text("favorite_themes").default('["tech","money","courage"]'),
    dailyLimitMinutes: integer("daily_limit_minutes").notNull().default(60), // 0 = unlimited, default 60m
    defaultSleepTimerMinutes: integer("default_sleep_timer_minutes").notNull().default(60), // default 60m sleep timer
    bedtimeCutoff: text("bedtime_cutoff"),
    allowAudioAutoplay: integer("allow_audio_autoplay").notNull().default(1),
    allowedBookSlugs: text("allowed_book_slugs"),
    dailyMinutesUsed: integer("daily_minutes_used").notNull().default(0),
    dailyMinutesDate: text("daily_minutes_date"),
    isDefault: integer("is_default").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("kid_profiles_user_idx").on(table.userId, table.createdAt)]
);

export const readingProgress = sqliteTable(
  "reading_progress",
  {
    userId: text("user_id").notNull(),
    profileId: text("profile_id").notNull().default("parent"),
    bookSlug: text("book_slug").notNull(),
    chapterNum: integer("chapter_num").notNull().default(1),
    pageIndex: integer("page_index").notNull().default(0),
    viewEdition: text("view_edition").notNull().default("story"), // story | coloring | color | cover
    viewMode: text("view_mode").notNull().default("flip"), // flip | scroll
    audioTrackId: text("audio_track_id").notNull().default("ch1"),
    audioPositionSec: integer("audio_position_sec").notNull().default(0),
    audioDurationSec: integer("audio_duration_sec").notNull().default(0),
    syncEnabled: integer("sync_enabled").notNull().default(1),
    dailyMinutesUsed: integer("daily_minutes_used").notNull().default(0),
    usageDate: text("usage_date").notNull().default(""), // YYYY-MM-DD in America/Chicago
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.profileId, table.bookSlug] }),
    index("reading_progress_user_updated_idx").on(table.userId, table.updatedAt),
  ]
);

// ---------------------------------------------------------------------------
// Better Auth Core + Username & Admin Plugin Tables
// ---------------------------------------------------------------------------

export const authUsers = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("emailVerified").notNull().default(0),
    image: text("image"),
    username: text("username").unique(),
    displayUsername: text("displayUsername"),
    role: text("role").default("user"),
    banned: integer("banned").default(0),
    banReason: text("banReason"),
    banExpires: integer("banExpires"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [uniqueIndex("user_username_idx").on(table.username)]
);

export const authSessions = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: text("expiresAt").notNull(),
    token: text("token").notNull().unique(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => authUsers.id),
  },
  (table) => [index("session_userId_idx").on(table.userId)]
);

export const authAccounts = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => authUsers.id),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: text("accessTokenExpiresAt"),
    refreshTokenExpiresAt: text("refreshTokenExpiresAt"),
    scope: text("scope"),
    password: text("password"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)]
);

export const authVerifications = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: text("expiresAt").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
);

