-- QC sign-offs (CG, 2026-11-03): two per-book human attestations on
-- top of the per-page approvals. story = the full story read and
-- approved; color = the full color edition read and approved. Each
-- row binds to the exact book revision the reviewer loaded, like
-- artifact_approvals; a revision change orphans earlier sign-offs.
-- Append-only: a later row for the same (book, kind, revision) is a
-- new attestation, never an edit of the old one.
CREATE TABLE IF NOT EXISTS book_qc_signoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('story', 'color')),
  revision TEXT NOT NULL,
  actor TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS book_qc_signoffs_revision ON book_qc_signoffs(book_slug, revision, kind, id);
CREATE TRIGGER IF NOT EXISTS book_qc_signoffs_no_update BEFORE UPDATE ON book_qc_signoffs
BEGIN SELECT RAISE(ABORT, 'qc signoffs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS book_qc_signoffs_no_delete BEFORE DELETE ON book_qc_signoffs
BEGIN SELECT RAISE(ABORT, 'qc signoffs are append-only'); END;
