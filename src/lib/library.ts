// Customer library: who owns which book digitally, and the reader's
// page data. This is the entitlement layer behind /account's My Shelf,
// the /read/[slug] reader, and the /api/library/audio streaming route.
//
// Digital ownership comes from exactly two places:
//
//   1. Completed orders. The digital-carrying formats (digital,
//      printed, gift set) include the full digital edition AND the
//      audiobook: offers.formatDetail says "digital included" for both
//      the printed book and the gift set, and the digital bundle lists
//      the audiobook among its contents. The audio format is the one
//      exception: an audiobook-only purchase grants listening (stream
//      plus audiobook downloads) and nothing else, no book files.
//      formatGrantsDigital / formatGrantsAudio encode that split in
//      one place; a format that ships without digital must stay out of
//      formatGrantsDigital AND stop saying "digital included" in
//      formatDetail. The Book Club's day-one join grant is already a
//      $0 completed order (see grantClubFirstBoxDigital in club.ts),
//      so it flows through this path with no special case.
//
//   2. Book Club cycle boxes that have actually shipped (or been
//      delivered). A shipped box's resolved book joins the member's
//      library even though no order row exists for it. Boxes still
//      being chosen, locked, or prepared do not grant anything yet.
//      A member who later cancels keeps the books already sent to
//      them, so current membership status is not re-checked here.
//
//   3. The live membership layer (club plans, 2026-10-28). While a
//      membership is ACTIVE (paid and in good billing standing, see
//      clubMembershipActive in club.ts), it grants access on top of
//      ownership: a physical member gets the digital edition and the
//      audiobook of EVERY published book; an audio member gets
//      listening rights to every audio-published book (a cover and
//      an audiobook on file, any book status; CG, 2026-10-29), and
//      nothing else (the grants ride the same formatGrantsAudio
//      split as an audiobook-only purchase, so no page reading and
//      no book files). Physical members also listen to every
//      audio-published book. Unlike sources 1 and 2 this layer is
//      re-checked on every read: when the subscription lapses, is
//      canceled, or goes past due, the layer disappears and only
//      owned books remain. Entitlement.membership records which plan
//      produced the layer so the shelf can label it.
//
// THE LOCK MODEL (CG, 2026-10-29): membership is access, not
// ownership. Sources 1 and 2 are OWNED (Entitlement.owned): the buyer
// bought the book, or it arrived in a shipped box, and owned books are
// the ones whose files download. The membership layer (source 3)
// grants reading and listening in the library only and never sets
// owned, even where it sets the same digital/audio flags as a
// purchase. /api/download requires owned; the reader and the audio
// streaming route require only the access flags. A book that is both
// owned and membership-reached is owned.
//
// Orders are matched by account user id, falling back to the account
// email for rows written before accounts were tied (the same pattern
// as club-cycles.getOwnedBookSlugs).
//
// SECURITY (2026-10-31, SECURITY-FINDINGS F1): the email fallback is
// only honored for a session whose email is VERIFIED. Without the
// gate, anyone could register a guest buyer's address and inherit
// that buyer's library, club membership, and box selection, because
// email+password sign-up creates a session without ever proving
// inbox ownership. Magic-link and Google sessions are verified by
// Better Auth; password accounts verify by clicking the email sent on
// sign-up (emailVerification.sendOnSignUp in lib/auth).

import { parseItems, type DBLike } from "./orders";
import { ensurePublicSlugColumn } from "./public-slugs";
import { ensureClubTable, clubMembershipActive, clubPlanOf, getClubMembership, type ClubPlanId } from "./club";
import { ensureClubCycleTables } from "./club-cycles";
import { colorTwinKey } from "./takes";
import dockerChapters from "../data/docker_chapters.json";

export type EntitlementSource = "order" | "club";

export interface Entitlement {
  slug: string;
  sources: EntitlementSource[];
  /** Full digital edition: read the pages, download every book file. */
  digital: boolean;
  /** Listening: stream the audiobook and download its files. */
  audio: boolean;
  /**
   * The club plan whose live membership layer reaches this book, when
   * one does: "physical" members reach every published book (digital)
   * and every audio-published book (listening), "audio" members reach
   * every audio-published book (listening only). Null when no active
   * membership touches the book. Ownership (sources) is independent
   * of this: a book can be owned AND membership-reached.
   */
  membership: ClubPlanId | null;
  /**
   * The lock model: true when the book is the buyer's to keep, set
   * only by a completed order or a shipped/delivered club box, never
   * by the live membership layer. Downloads (/api/download, and the
   * shelf's download controls) require owned; reading and streaming
   * require only the digital/audio flags above.
   */
  owned: boolean;
}

export interface LibraryUser {
  id: string;
  email: string;
  /**
   * True when the session's email is verified (Better Auth:
   * magic-link + Google sessions set this; password accounts verify
   * by clicking the sign-up email). When false, the email fallback in
   * entitlement matching is disabled and only rows carrying this
   * account's user_id match — see the header (SECURITY-FINDINGS F1).
   */
  emailVerified?: boolean;
}

/** Does a purchased line item carry the digital edition? See header. */
export function formatGrantsDigital(format: string): boolean {
  return format === "digital" || format === "printed" || format === "giftset";
}

/**
 * Does a purchased line item carry listening rights? Every
 * digital-carrying format includes the book's audiobook, and the
 * audio format is listening on its own. See header.
 */
export function formatGrantsAudio(format: string): boolean {
  return formatGrantsDigital(format) || format === "audio";
}

/**
 * The digital entitlements for one signed-in user, keyed by book slug.
 * Pure over the orders / club tables: no R2, no session handling, so
 * tests can drive it with an in-memory database.
 */
export async function getDigitalEntitlements(
  db: DBLike,
  user: LibraryUser
): Promise<Map<string, Entitlement>> {
  const out = new Map<string, Entitlement>();
  const add = (
    slug: string,
    source: EntitlementSource,
    grant: "digital" | "audio",
    membership: ClubPlanId | null = null
  ) => {
    if (!slug) return;
    // Calls from the membership layer pass a plan; every other call
    // (a completed order, a shipped/delivered box) is a purchase or a
    // delivery, and those are what make a book owned (the lock model).
    const grantsOwnership = membership === null;
    const cur = out.get(slug);
    if (cur) {
      if (!cur.sources.includes(source)) cur.sources.push(source);
      if (grant === "digital") {
        cur.digital = true;
        cur.audio = true;
      } else {
        cur.audio = true;
      }
      if (membership && !cur.membership) cur.membership = membership;
      if (grantsOwnership) cur.owned = true;
    } else {
      out.set(slug, {
        slug,
        sources: [source],
        digital: grant === "digital",
        audio: true,
        membership,
        owned: grantsOwnership,
      });
    }
  };

  const userId = String(user?.id || "");
  // The email fallback (guest orders, pre-account rows) is only
  // honored for verified sessions; an unverified session matches by
  // user_id alone. A blank email matches no rows.
  const email =
    user?.emailVerified === true
      ? String(user?.email || "").trim().toLowerCase()
      : "";

  // 1. Completed orders (real purchases and the $0 club join grants).
  const { results } = await db
    .prepare(
      "SELECT * FROM orders WHERE status = 'complete' AND (user_id = ? OR email = ?) ORDER BY created_at ASC"
    )
    .bind(userId, email)
    .all();
  for (const order of (results || []) as any[]) {
    const items = parseItems(order);
    for (const item of items) {
      if (formatGrantsDigital(item.format)) add(item.slug, "order", "digital");
      else if (formatGrantsAudio(item.format)) add(item.slug, "order", "audio");
    }
    // book_slugs is the order's slug set, maintained beside items by
    // every writer, and it is what /api/download has always keyed
    // ownership on. A slug listed with no items row behind it is a
    // legacy row (written before items existed) and grants the full
    // digital edition, exactly as it always did. A slug whose items
    // ARE recorded takes its grant from those items alone, so an
    // audiobook-only purchase never widens into book files just
    // because its slug sits in book_slugs.
    try {
      const slugs = JSON.parse(order?.book_slugs || "[]");
      if (Array.isArray(slugs)) {
        for (const s of slugs) {
          const slug = String(s);
          if (!items.some((i) => i.slug === slug)) add(slug, "order", "digital");
        }
      }
    } catch { /* malformed rows grant nothing extra */ }
  }

  // 2. Shipped or delivered Book Club cycle boxes for this member.
  // 3. The live membership layer for an active member of either plan.
  try {
    await ensureClubTable(db);
    await ensureClubCycleTables(db);
    const member = (await db
      .prepare("SELECT id FROM club_signups WHERE email = ? OR user_id = ? LIMIT 1")
      .bind(email, userId)
      .first()) as any;
    if (member?.id) {
      // Option A boxes resolve two titles; a shipped/delivered box
      // grants BOTH (club book + back catalog second book).
      const boxes = await db
        .prepare(
          `SELECT resolved_book_slug, second_resolved_book_slug FROM club_cycle_boxes
           WHERE signup_id = ? AND (resolved_book_slug IS NOT NULL OR second_resolved_book_slug IS NOT NULL)
             AND status IN ('shipped', 'delivered')`
        )
        .bind(member.id)
        .all();
      for (const box of (boxes.results || []) as any[]) {
        add(String(box.resolved_book_slug || ""), "club", "digital");
        add(String(box.second_resolved_book_slug || ""), "club", "digital");
      }
    }

    // The membership layer reads the full row (plan + billing health),
    // not just the id the box lookup needed. Reading stays gated on
    // the published book (status 'complete'): ready_for_qa books are
    // not published and their pages are not granted. Listening is
    // wider (CG, 2026-10-29): every audio-published book (a cover and
    // an audiobook on file, any book status) is listenable by members
    // of either plan, audio-only, never reading.
    const membership = await getClubMembership(db, { id: userId, email, emailVerified: user?.emailVerified === true });
    if (clubMembershipActive(membership)) {
      const plan = clubPlanOf(membership);
      if (plan === "physical") {
        const { results } = await db
          .prepare("SELECT slug FROM books WHERE status = 'complete'")
          .bind()
          .all();
        for (const b of (results || []) as any[]) {
          add(String(b.slug || ""), "club", "digital", "physical");
        }
        const { results: audioRows } = await db
          .prepare(
            "SELECT slug FROM books WHERE cover_key IS NOT NULL AND audiobook_key IS NOT NULL"
          )
          .bind()
          .all();
        for (const b of (audioRows || []) as any[]) {
          add(String(b.slug || ""), "club", "audio", "physical");
        }
      } else {
        const { results } = await db
          .prepare(
            "SELECT slug FROM books WHERE cover_key IS NOT NULL AND audiobook_key IS NOT NULL"
          )
          .bind()
          .all();
        for (const b of (results || []) as any[]) {
          add(String(b.slug || ""), "club", "audio", "audio");
        }
      }
    }
  } catch (err) {
    // Club tables are additive; a library read must never fail because
    // the club side is unavailable. Orders above already answered.
    console.error("library club entitlement lookup failed", (err as any)?.message || err);
  }

  return out;
}

export async function ownsDigitalBook(
  db: DBLike,
  user: LibraryUser,
  slug: string
): Promise<boolean> {
  if (!slug) return false;
  const entitlements = await getDigitalEntitlements(db, user);
  return entitlements.get(slug)?.digital === true;
}

/** Listening rights only: true for digital owners and audio-only buyers. */
export async function ownsAudioBook(
  db: DBLike,
  user: LibraryUser,
  slug: string
): Promise<boolean> {
  if (!slug) return false;
  const entitlements = await getDigitalEntitlements(db, user);
  return entitlements.get(slug)?.audio === true;
}

/**
 * Download rights (the lock model): the book must be OWNED (bought, or
 * arrived in a shipped club box) and carry the format's access flag.
 * A book reached only through the live membership layer never
 * downloads, on either plan. Book files follow the digital flag; the
 * audiobook file follows the audio flag, so an audiobook-only purchase
 * still downloads its audiobook.
 */
export function entitlementDownloads(ent: Entitlement | undefined, format: "book" | "audiobook"): boolean {
  if (!ent || ent.owned !== true) return false;
  return format === "audiobook" ? ent.audio === true : ent.digital === true;
}

export interface LibraryBook {
  slug: string;
  /** Title-based public slug (lib/public-slugs.ts); read links are
   *  built from it, downloads keep keying on slug. */
  public_slug: string | null;
  title: string;
  topic: string | null;
  cover_key: string | null;
  picture_book_key: string | null;
  coloring_book_key: string | null;
  epub_key: string | null;
  color_book_key: string | null;
  audiobook_key: string | null;
  price: number | null;
  price_print: number | null;
  sources: EntitlementSource[];
  /** Full digital edition owned (read pages, download book files). */
  digital: boolean;
  /** Listening owned (included in every digital grant). */
  audio: boolean;
  /** Audio owned WITHOUT digital: a listen-only shelf entry. */
  audioOnly: boolean;
  /**
   * The lock model: true when the book is the buyer's to keep (an
   * order or a shipped club box stands behind it). The shelf renders
   * download controls only for owned rows; membership-only rows get
   * Read / Listen and nothing to download.
   */
  owned: boolean;
  /**
   * The club plan whose live membership layer reaches this book
   * ("physical" | "audio"), or null. The shelf labels membership
   * books from this, distinct from owned books.
   */
  clubPlan: ClubPlanId | null;
}

/**
 * Book rows for everything in the user's library (digital grants and
 * audio-only grants alike), title order. Each row carries its grant
 * shape (digital / audio / audioOnly) so the shelf can render a
 * listen-only entry for audiobook-only purchases.
 */
export async function getLibraryBooks(db: DBLike, user: LibraryUser): Promise<LibraryBook[]> {
  const entitlements = await getDigitalEntitlements(db, user);
  const slugs = [...entitlements.keys()];
  if (!slugs.length) return [];
  await ensurePublicSlugColumn(db).catch(() => {});
  const ph = slugs.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT slug, public_slug, title, topic, cover_key, picture_book_key, coloring_book_key, epub_key, color_book_key, audiobook_key, price, price_print
       FROM books WHERE slug IN (${ph}) ORDER BY title ASC`
    )
    .bind(...slugs)
    .all();
  return ((results || []) as any[]).map((b) => {
    const ent = entitlements.get(String(b.slug));
    const digital = ent?.digital === true;
    const audio = ent?.audio === true;
    return {
      ...b,
      sources: ent?.sources || [],
      digital,
      audio,
      audioOnly: audio && !digital,
      owned: ent?.owned === true,
      clubPlan: ent?.membership ?? null,
    };
  }) as LibraryBook[];
}

// ---------------------------------------------------------------------------
// Reader page data. Mirrors the admin Story Review page exactly: pages
// come from the factory-written books/{slug}/editor_chapters.json in
// the BOOKS bucket (docker falls back to the bundled copy), reconciled
// with each chapter's finale page from its plan (see lib/book-pages,
// editor_chapters.json omits finales), and a color
// twin counts only when its R2 uploaded time is at least the line
// page's (the stale-twin rule). Customer-facing shape: viewer page
// numbers and story text only, no factory labels or plan metadata.

import { keyFromMediaValue, libraryPageUrl } from "./media";
import { keyFromImageUrl } from "./takes";
import { loadChapterFinales, withFinalePages } from "./book-pages";

/** Page-image keys the customer reader route may serve for a book:
 * the standard line/color locations, plus the legacy root-level page
 * files (docker's baked chapters and editor uploads share the
 * {slug}/S{n}-page-{m}[-r{ts}] shape). Anything else is refused, so a
 * book's entitlement can never be stretched into another book's pages
 * or into non-page objects. */
export function readerPageKeyAllowed(slug: string, key: string): boolean {
  if (!key || key.includes("..")) return false;
  if (!/\.(jpe?g|png|webp)$/i.test(key)) return false;
  if (key.startsWith(`books/${slug}/images/`) || key.startsWith(`books/${slug}/images-color/`)) {
    return true;
  }
  if (key.startsWith(`${slug}/`)) {
    const base = key.slice(key.lastIndexOf("/") + 1);
    return /^S\d+-(page-\d+|finale)(-r\d+)?\.(jpe?g|png|webp)$/i.test(base);
  }
  return false;
}

export interface ReaderPage {
  viewer: number; // 1-based page number within the chapter
  text: string;
  lineUrl: string;
  colorUrl: string | null;
}

export interface ReaderChapter {
  num: number;
  title: string;
  pages: ReaderPage[];
}

export interface ReaderBook {
  chapters: ReaderChapter[];
  totalPages: number;
  colorCount: number;
  hasColor: boolean;
  error: string | null;
}

async function listAllKeys(
  books: any,
  prefix: string
): Promise<{ key: string; uploaded: number }[]> {
  const out: { key: string; uploaded: number }[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await books.list({ prefix, cursor, limit: 1000 });
    for (const o of res.objects || []) {
      out.push({ key: o.key, uploaded: o.uploaded ? new Date(o.uploaded).getTime() : 0 });
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

const baseName = (key: string) => key.slice(key.lastIndexOf("/") + 1);

export async function loadReaderBook(books: any, slug: string): Promise<ReaderBook> {
  const empty: ReaderBook = { chapters: [], totalPages: 0, colorCount: 0, hasColor: false, error: null };
  let chaptersRaw: any[] | null = null;
  try {
    const obj = await books.get(`books/${slug}/editor_chapters.json`);
    if (obj) {
      chaptersRaw = JSON.parse(await obj.text());
    } else if (slug === "docker") {
      chaptersRaw = dockerChapters as any[];
    } else {
      return { ...empty, error: "This book's pages are not ready to read online yet." };
    }
  } catch {
    return { ...empty, error: "This book's pages could not be loaded." };
  }
  if (!chaptersRaw) return { ...empty, error: "This book's pages are not ready to read online yet." };

  const [lineObjs, colorObjs, finales] = await Promise.all([
    listAllKeys(books, `books/${slug}/images/`).catch(() => []),
    listAllKeys(books, `books/${slug}/images-color/`).catch(() => []),
    loadChapterFinales(books, slug, chaptersRaw.length).catch(
      () => new Map<number, { text: string; imageKey: string }>()
    ),
  ]);
  const lineByBase = new Map<string, number>();
  for (const o of lineObjs) lineByBase.set(baseName(o.key), o.uploaded);
  const colorByBase = new Map<string, number>();
  for (const o of colorObjs) colorByBase.set(baseName(o.key), o.uploaded);

  // editor_chapters.json omits each chapter's finale page; the plans
  // carry it, and the assembled book includes it. Append it (when its
  // art exists in the line listing) so the reader shows the whole book.
  const fullChapters = withFinalePages(
    chaptersRaw,
    finales,
    new Set(lineObjs.map((o) => o.key))
  );

  const chapters: ReaderChapter[] = fullChapters.map((ch: any, ci: number) => {
    const num = ci + 1;
    const pages: ReaderPage[] = (ch.pages || []).map((pg: any, pi: number) => {
      const rawImage = String(pg.image || "");
      const lineKey = keyFromMediaValue(rawImage) || keyFromImageUrl(rawImage) || "";
      const twinKey = lineKey ? colorTwinKey(lineKey, slug) : null;
      const file = lineKey ? baseName(lineKey) : "";
      const colorUploaded = twinKey ? colorByBase.get(file) : undefined;
      const lineUploaded = lineByBase.get(file) ?? 0;
      // Page images are served only through the entitlement-checked
      // reader route; the stored factory URLs are never emitted.
      const lineUrl =
        lineKey && readerPageKeyAllowed(slug, lineKey)
          ? libraryPageUrl(slug, lineKey) || ""
          : "";
      const colorUrl =
        twinKey && colorUploaded !== undefined && colorUploaded >= lineUploaded
          ? libraryPageUrl(slug, twinKey)
          : null;
      return {
        viewer: pi + 1,
        text: String(pg.text || ""),
        lineUrl,
        colorUrl,
      };
    });
    return { num, title: String(ch.title || `Chapter ${num}`), pages };
  });

  const totalPages = chapters.reduce((s, c) => s + c.pages.length, 0);
  const colorCount = chapters.reduce((s, c) => s + c.pages.filter((p) => p.colorUrl).length, 0);
  return { chapters, totalPages, colorCount, hasColor: colorCount > 0, error: null };
}
