// Story Review notes (/admin/books/[slug]/review).
//
// While CG listens to a book's audiobook and scrolls its pages, he
// leaves a note on any page that looks wrong. A note is pinned to one
// page of one book in one rendering (line art or its color twin); the
// (chapterNum, pageIndex) pair inside page_key matches the identity
// the change-request / redo machinery already uses, so the future
// redo queue can consume these rows without translation.
//
// Notes are capture only: nothing here regenerates anything. resolved
// flips when the underlying defect is dealt with (by hand, by a redo,
// or because CG decided it is fine after all).

import type { DBLike } from "./orders";

export type ReviewKind = "line" | "color";

/** The defect quick-tags offered in the review UI, in display order. */
export const REVIEW_TAGS = [
  "clone",
  "extra character",
  "wrong character",
  "anatomy",
  "text",
  "other",
] as const;
export type ReviewTag = (typeof REVIEW_TAGS)[number];

export interface ReviewNote {
  id: string;
  slug: string;
  page_key: string; // "{chapterNum}:{pageIndex}", both 1-based chapter, 0-based page
  kind: ReviewKind;
  note: string;
  tags: string[]; // parsed from the stored JSON
  created_at: number; // unix seconds
  resolved: number; // 0 | 1
}

/** Page identity shared with change requests: chapter 1-based, page 0-based. */
export function makePageKey(chapterNum: number, pageIndex: number): string {
  return `${chapterNum}:${pageIndex}`;
}

export function isValidPageKey(raw: unknown): boolean {
  return typeof raw === "string" && /^[1-9]\d*:(0|[1-9]\d*)$/.test(raw);
}

export function isReviewKind(raw: unknown): raw is ReviewKind {
  return raw === "line" || raw === "color";
}

/** Keep only known tags, de-duplicated, in canonical order. */
export function normalizeTags(input: unknown): ReviewTag[] {
  if (!Array.isArray(input)) return [];
  const wanted = new Set(input.map((t) => String(t)));
  return REVIEW_TAGS.filter((t) => wanted.has(t));
}

export async function ensureReviewNotesTable(db: DBLike): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS review_notes (
         id TEXT PRIMARY KEY,
         slug TEXT NOT NULL,
         page_key TEXT NOT NULL,
         kind TEXT NOT NULL DEFAULT 'line',
         note TEXT NOT NULL DEFAULT '',
         tags TEXT NOT NULL DEFAULT '[]',
         created_at INTEGER NOT NULL,
         resolved INTEGER NOT NULL DEFAULT 0
       )`
    )
    .bind()
    .run();
  await db
    .prepare("CREATE INDEX IF NOT EXISTS review_notes_slug_idx ON review_notes(slug, page_key)")
    .bind()
    .run();
}

function rowToNote(row: any): ReviewNote {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags || "[]");
    if (Array.isArray(parsed)) tags = normalizeTags(parsed);
  } catch {
    tags = [];
  }
  return {
    id: String(row.id),
    slug: String(row.slug),
    page_key: String(row.page_key),
    kind: row.kind === "color" ? "color" : "line",
    note: String(row.note || ""),
    tags,
    created_at: Number(row.created_at || 0),
    resolved: Number(row.resolved || 0) ? 1 : 0,
  };
}

export async function listReviewNotes(db: DBLike, slug: string): Promise<ReviewNote[]> {
  const res = await db
    .prepare(
      "SELECT * FROM review_notes WHERE slug = ? ORDER BY resolved ASC, created_at ASC"
    )
    .bind(slug)
    .all();
  return (res.results || []).map(rowToNote);
}

export interface AddReviewNoteArgs {
  slug: string;
  pageKey: string;
  kind: ReviewKind;
  note: string;
  tags: unknown;
  now?: number; // unix seconds, injectable for tests
  id?: string; // injectable for tests
}

export async function addReviewNote(
  db: DBLike,
  args: AddReviewNoteArgs
): Promise<{ ok: true; note: ReviewNote } | { ok: false; error: string }> {
  const slug = String(args.slug || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) return { ok: false, error: "bad slug" };
  if (!isValidPageKey(args.pageKey)) return { ok: false, error: "bad page_key" };
  if (!isReviewKind(args.kind)) return { ok: false, error: "bad kind" };
  const text = String(args.note || "").trim();
  const tags = normalizeTags(args.tags);
  if (!text && tags.length === 0) {
    return { ok: false, error: "a note or at least one tag is required" };
  }
  const note: ReviewNote = {
    id: args.id || crypto.randomUUID(),
    slug,
    page_key: args.pageKey,
    kind: args.kind,
    note: text,
    tags,
    created_at: args.now ?? Math.floor(Date.now() / 1000),
    resolved: 0,
  };
  await db
    .prepare(
      `INSERT INTO review_notes (id, slug, page_key, kind, note, tags, created_at, resolved)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .bind(note.id, note.slug, note.page_key, note.kind, note.note, JSON.stringify(note.tags), note.created_at)
    .run();
  return { ok: true, note };
}

export async function setReviewNoteResolved(
  db: DBLike,
  id: string,
  resolved: boolean
): Promise<{ ok: boolean; error?: string }> {
  const noteId = String(id || "").trim();
  if (!noteId) return { ok: false, error: "missing id" };
  const res: any = await db
    .prepare("UPDATE review_notes SET resolved = ? WHERE id = ?")
    .bind(resolved ? 1 : 0, noteId)
    .run();
  const changes = Number(res?.meta?.changes ?? 0);
  if (changes === 0) return { ok: false, error: "note not found" };
  return { ok: true };
}

/** Distinct pages carrying at least one unresolved note. */
export function countFlaggedPages(notes: ReviewNote[]): number {
  const pages = new Set<string>();
  for (const n of notes) {
    if (!n.resolved) pages.add(n.page_key);
  }
  return pages.size;
}
