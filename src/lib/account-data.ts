import { getEffectiveSession } from "./auth";
import { getLibraryBooks } from "./library";
import {
  computeOnboardingChecklist,
  generateReferralCode,
  getParentOnboarding,
  listKidProfiles,
  listReadingProgress,
  type KidProfile,
  type OnboardingChecklist,
  type ParentOnboarding,
  type ReadingProgressRow,
} from "./family";

export interface CustomerHubContext {
  session: any;
  books: any[];
  audioBooksCount: number;
  parentOnboarding: ParentOnboarding | null;
  kidProfiles: KidProfile[];
  readingProgressList: ReadingProgressRow[];
  onboardingChecklist: OnboardingChecklist;
  defaultKidProfile: KidProfile | null;
  defaultSleepMinutes: number;
  familyReferralCode: string;
  referralShareUrl: string;
}

/**
 * Shared loader for all `/account/*` pages.
 * Runs independent D1 queries in parallel (`Promise.all`) to avoid waterfalls.
 */
export async function loadCustomerHubContext(
  request: Request,
  locals: any,
  db: any,
  origin: string
): Promise<CustomerHubContext | null> {
  const session = await getEffectiveSession(request, locals, db);
  if (!session) return null;

  const [libraryBooks, parentOnboarding, kidProfiles, readingProgressList] = await Promise.all([
    getLibraryBooks(db, {
      id: session.user.id,
      email: String(session.user.email || ""),
    }).catch(() => []),
    getParentOnboarding(db, session.user.id).catch(() => null),
    listKidProfiles(db, session.user.id).catch(() => []),
    listReadingProgress(db, session.user.id).catch(() => []),
  ]);

  let books: any[] = (libraryBooks || []) as any[];
  // If an admin account has no test orders yet, seed published books onto the
  // shelf so they experience the exact same customer shelf & player as a buyer.
  if (session.user.isAdmin && books.length === 0) {
    try {
      const allComplete = await db
        .prepare(
          `SELECT slug, public_slug, title, topic, cover_key, picture_book_key, coloring_book_key, epub_key, color_book_key, audiobook_key, price, price_print
           FROM books WHERE status = 'complete' ORDER BY title ASC`
        )
        .bind()
        .all();
      const completeRows = (allComplete?.results || allComplete?.rows || []) as any[];
      books = completeRows.map((b) => ({
        ...b,
        sources: ["order"],
        digital: true,
        audio: Boolean(b.audiobook_key),
        audioOnly: false,
        owned: true,
        clubPlan: null,
      }));
    } catch {
      // Keep empty if query fails
    }
  }

  const audioBooksCount = books.filter((b) => Boolean(b.audiobook_key)).length;
  const onboardingChecklist = computeOnboardingChecklist(
    parentOnboarding,
    kidProfiles,
    readingProgressList
  );
  const defaultKidProfile = kidProfiles.find((k) => k.is_default) || kidProfiles[0] || null;
  const defaultSleepMinutes = defaultKidProfile ? defaultKidProfile.default_sleep_timer_minutes : 60;
  const familyReferralCode =
    parentOnboarding?.referral_code ||
    generateReferralCode(
      parentOnboarding?.parent_name || String(session.user.email || "FAMILY"),
      session.user.id
    );
  const referralShareUrl = `${origin}/?ref=${encodeURIComponent(familyReferralCode)}`;

  return {
    session,
    books,
    audioBooksCount,
    parentOnboarding,
    kidProfiles,
    readingProgressList,
    onboardingChecklist,
    defaultKidProfile,
    defaultSleepMinutes,
    familyReferralCode,
    referralShareUrl,
  };
}
