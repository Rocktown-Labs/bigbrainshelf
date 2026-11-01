import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';

// PATCH /api/reviews (JSON {id, rating, title, body}): the author
// edits their own review while it is still pending. Once a person
// has approved or rejected it, the text is locked. Matched by
// user_id only, never by email.
export const PATCH: APIRoute = async ({ request }) => {
  const e = env as any;
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "Sign in to edit a review." }, { status: 401 });
  }
  await ensureReviewsTable(e.DB);
  const data = await request.json().catch(() => null) as any;
  if (!data) return Response.json({ error: "Could not read the edit." }, { status: 400 });
  const id = String(data.id || "").trim();
  const rating = Number(data.rating);
  const title = String(data.title || "").trim().slice(0, 120);
  const body = String(data.body || "").trim().slice(0, 4000);
  if (!id) return Response.json({ error: "Which review?" }, { status: 400 });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return Response.json({ error: "Please give the book a star rating." }, { status: 400 });
  }
  if (!title) return Response.json({ error: "Please add a headline for your review." }, { status: 400 });
  if (!body) return Response.json({ error: "Please write a few words about the book." }, { status: 400 });

  const row = await e.DB.prepare("SELECT id, status FROM reviews WHERE id = ? AND user_id = ?")
    .bind(id, session.user.id)
    .first();
  if (!row) return Response.json({ error: "That review is not yours to edit." }, { status: 404 });
  if (String((row as any).status) !== "pending") {
    return Response.json({ error: "This review has already been checked, so it is locked." }, { status: 409 });
  }
  await e.DB.prepare("UPDATE reviews SET rating = ?, title = ?, body = ? WHERE id = ?")
    .bind(rating, title, body, id)
    .run();
  return Response.json({ ok: true });
};
import { getAuth } from "../../lib/auth";
import {
  ensureReviewsTable,
  REVIEW_PHOTO_MAX_BYTES,
  REVIEW_VIDEO_MAX_BYTES,
  REVIEW_MAX_PHOTOS,
  PHOTO_TYPES,
  VIDEO_TYPES,
} from "../../lib/reviews";

// POST /api/reviews (multipart form): a signed-in customer reviews a
// book. Fields: slug, rating (1-5), title, body, display_name, photos
// (up to 4 images, 10MB each), video (one file, mp4/webm/mov, 50MB).
// The review is stored as 'pending': it appears nowhere public until an
// admin approves it in /admin/reviews. Media goes to R2 under reviews/
// and is only ever served through the status-checked media routes.
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "Sign in to write a review." }, { status: 401 });
  }
  await ensureReviewsTable(e.DB);

  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: "Could not read the review form." }, { status: 400 });

  const slug = String(form.get("slug") || "").trim().toLowerCase();
  const rating = Number(form.get("rating"));
  const title = String(form.get("title") || "").trim().slice(0, 120);
  const body = String(form.get("body") || "").trim().slice(0, 4000);
  const displayName = String(form.get("display_name") || "").trim().slice(0, 60) || session.user.name || "Reader";

  const book = await e.DB.prepare("SELECT slug, title FROM books WHERE slug = ? AND picture_book_key IS NOT NULL")
    .bind(slug).first();
  if (!book) return Response.json({ error: "That book cannot be reviewed." }, { status: 400 });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return Response.json({ error: "Please give the book a star rating." }, { status: 400 });
  }
  if (!title) return Response.json({ error: "Please add a headline for your review." }, { status: 400 });
  if (!body) return Response.json({ error: "Please write a few words about the book." }, { status: 400 });

  const existing = await e.DB.prepare(
    "SELECT id, status FROM reviews WHERE user_id = ? AND book_slug = ?"
  ).bind(session.user.id, slug).first();
  if (existing) {
    return Response.json(
      { error: existing.status === "rejected" ? "That review was not approved, so it cannot be resubmitted." : "You have already reviewed this book." },
      { status: 409 }
    );
  }

  // Reviews are for readers (CG, 2026-10-31): the reviewer must
  // have bought the book or be able to listen/read it through a
  // club, checked against the same entitlement map the library
  // uses. Runs before any media upload so a refused review never
  // leaves orphan files behind.
  const { reviewEligibility } = await import("../../lib/reviews");
  const eligibility = await reviewEligibility(e.DB, { id: session.user.id, email: session.user.email }, slug);
  if (!eligibility.allowed && eligibility.reason === "not_entitled") {
    return Response.json(
      { error: "Reviews are for readers of this book. Buy it or join a club and listen first, then come back and tell us what you thought." },
      { status: 403 }
    );
  }

  const photos = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  if (photos.length > REVIEW_MAX_PHOTOS) {
    return Response.json({ error: `Up to ${REVIEW_MAX_PHOTOS} photos per review.` }, { status: 400 });
  }
  for (const p of photos) {
    if (!PHOTO_TYPES.includes(p.type)) return Response.json({ error: "Photos must be JPG, PNG, WebP, or GIF images." }, { status: 400 });
    if (p.size > REVIEW_PHOTO_MAX_BYTES) return Response.json({ error: "Each photo must be 10MB or smaller." }, { status: 400 });
  }
  const videoRaw = form.get("video");
  const video = videoRaw instanceof File && videoRaw.size > 0 ? videoRaw : null;
  if (video) {
    if (!VIDEO_TYPES.includes(video.type)) return Response.json({ error: "Video must be an MP4, WebM, or MOV file." }, { status: 400 });
    if (video.size > REVIEW_VIDEO_MAX_BYTES) return Response.json({ error: "Video must be 50MB or smaller." }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const extOf = (f: File, fallback: string) => {
    const ext = (f.name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return ext || fallback;
  };
  const mediaKeys: string[] = [];
  for (let i = 0; i < photos.length; i++) {
    const key = `reviews/${id}/photo-${i}.${extOf(photos[i], "jpg")}`;
    await e.BOOKS.put(key, await photos[i].arrayBuffer(), {
      httpMetadata: { contentType: photos[i].type },
    });
    mediaKeys.push(key);
  }
  let videoKey: string | null = null;
  if (video) {
    videoKey = `reviews/${id}/video.${extOf(video, "mp4")}`;
    await e.BOOKS.put(videoKey, await video.arrayBuffer(), {
      httpMetadata: { contentType: video.type },
    });
  }

  const verified = eligibility.verified;
  await e.DB.prepare(
    `INSERT INTO reviews (id, book_slug, user_id, user_email, display_name, rating, title, body, media_keys, video_key, verified_purchase, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(
    id, slug, session.user.id, session.user.email, displayName,
    rating, title, body, JSON.stringify(mediaKeys), videoKey,
    verified ? 1 : 0, Math.floor(Date.now() / 1000)
  ).run();

  // The owner hears about every new review (CG, 2026-10-31: reviews
  // were silent; he only found them by opening the admin). Deduped
  // per review, branded shell, and flushed immediately. Mail trouble
  // never fails the review itself.
  try {
    const { enqueueEmail, OWNER_NOTIFY_EMAIL } = await import("../../lib/orders");
    const { flushOutbox } = await import("../../lib/email");
    const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
    const excerpt = body.length > 280 ? body.slice(0, 280) + "…" : body;
    await enqueueEmail(e.DB, {
      orderId: null,
      kind: "owner_new_review",
      to: OWNER_NOTIFY_EMAIL,
      subject: `New review: ${stars} for ${book.title}`,
      text: `${displayName} reviewed ${book.title}${verified ? " (verified purchase)" : ""}.\n\n${stars}\n\n"${title}"\n${excerpt}\n\nIt is pending in the review queue until you approve it.`,
      dedupeKey: `owner-review:${id}`,
    });
    await flushOutbox(e.DB, e, 5).catch(() => {});
  } catch { /* the review stands; the notice is best effort */ }

  return Response.json({ ok: true, pending: true });
};
