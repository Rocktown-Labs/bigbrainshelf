// Customer reviews (Phase 3). Amazon-style in shape (stars, title, text,
// photos, one video, verified purchase badge) but NEVER auto-published:
// every review lands as 'pending' and only appears on a book page after
// an admin approves it in /admin/reviews.

import type { DBLike } from "./orders";

export const REVIEW_PHOTO_MAX_BYTES = 10 * 1024 * 1024; // 10MB per photo
export const REVIEW_VIDEO_MAX_BYTES = 50 * 1024 * 1024; // 50MB per video
export const REVIEW_MAX_PHOTOS = 4;
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

export async function ensureReviewsTable(db: DBLike): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS reviews (
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
       )`
    )
    .run();
  await db
    .prepare("CREATE INDEX IF NOT EXISTS reviews_book_status_idx ON reviews(book_slug, status)")
    .run();
  await db
    .prepare("CREATE INDEX IF NOT EXISTS reviews_user_idx ON reviews(user_id)")
    .run();
}

// Does this account own the book? Complete orders carry their slugs in
// book_slugs (JSON), whatever format each item was bought in.
// Who may review a book (CG, 2026-10-31): signed-in readers who
// bought it or can listen/read it through a club. That is exactly
// the storefront entitlement map (orders matched by user id OR
// email, plus club memberships), so reviews and the library can
// never disagree about who has the book. One review per reader per
// book, ever: any existing review (pending, approved, or rejected)
// blocks another, the same rule the submit API has always kept.
export async function reviewEligibility(
  db: DBLike,
  user: { id: string; email?: string | null },
  slug: string
): Promise<{ allowed: boolean; verified: boolean; reason: "not_entitled" | "already_reviewed" | null }> {
  const { getDigitalEntitlements } = await import("./library");
  const ent = (await getDigitalEntitlements(db, { id: user.id, email: user.email || "" } as any)).get(slug);
  if (!ent) return { allowed: false, verified: false, reason: "not_entitled" };
  const existing: any = await db
    .prepare("SELECT status FROM reviews WHERE user_id = ? AND book_slug = ?")
    .bind(user.id, slug)
    .first()
    .catch(() => null);
  if (existing) {
    return { allowed: false, verified: !!ent.owned, reason: "already_reviewed" };
  }
  return { allowed: true, verified: !!ent.owned, reason: null };
}

export async function userOwnsBook(db: DBLike, userId: string, slug: string): Promise<boolean> {
  const rows = await db
    .prepare("SELECT book_slugs FROM orders WHERE user_id = ? AND status = 'complete'")
    .bind(userId)
    .all();
  for (const o of (rows.results || []) as any[]) {
    try {
      const slugs = JSON.parse(o.book_slugs || "[]");
      if (Array.isArray(slugs) && slugs.map(String).includes(slug)) return true;
    } catch { /* keep looking */ }
  }
  return false;
}

// The moderation action behind /api/admin/reviews. Only pending reviews
// can be decided; anything else is reported back without changes.
export async function setReviewStatus(
  db: DBLike,
  reviewId: string,
  status: "approved" | "rejected"
): Promise<{ ok: boolean; error?: string }> {
  if (status !== "approved" && status !== "rejected") {
    return { ok: false, error: `unknown review status: ${status}` };
  }
  const row = await db.prepare("SELECT id, status FROM reviews WHERE id = ?").bind(reviewId).first();
  if (!row) return { ok: false, error: "review not found" };
  if (row.status !== "pending") return { ok: false, error: `review is already ${row.status}` };
  await db.prepare("UPDATE reviews SET status = ? WHERE id = ?").bind(status, reviewId).run();
  return { ok: true };
}

export function reviewMediaKeys(review: any): string[] {
  try {
    const keys = JSON.parse(review?.media_keys || "[]");
    return Array.isArray(keys) ? keys.map(String) : [];
  } catch {
    return [];
  }
}

// Resolve which stored object a media request refers to: which=video
// for the video, which=<0-based index> for photos. Returns the R2 key
// or null when the request does not name a real attachment.
export function reviewMediaKey(review: any, which: string): string | null {
  if (which === "video") return review?.video_key ? String(review.video_key) : null;
  const idx = Number(which);
  if (!Number.isInteger(idx) || idx < 0) return null;
  return reviewMediaKeys(review)[idx] || null;
}

export const REVIEW_STATUS_LABELS: Record<string, string> = {
  pending: "Pending review",
  approved: "Live",
  rejected: "Not approved",
};
