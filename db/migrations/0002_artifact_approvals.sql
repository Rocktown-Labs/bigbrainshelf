-- Historical coordinate-only approvals remain evidence, but cannot approve a revision.
CREATE TABLE IF NOT EXISTS artifact_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_slug TEXT NOT NULL,
  chapter_num INTEGER NOT NULL,
  page_index INTEGER NOT NULL,
  revision TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  actor TEXT,
  approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
  approved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifact_approvals_revision ON artifact_approvals(book_slug, revision, chapter_num, page_index, id);
-- Revocation is another event. Preserve the exact original verdict and provenance.
CREATE TRIGGER IF NOT EXISTS artifact_approvals_no_update BEFORE UPDATE ON artifact_approvals
BEGIN SELECT RAISE(ABORT, 'artifact approvals are append-only'); END;
CREATE TRIGGER IF NOT EXISTS artifact_approvals_no_delete BEFORE DELETE ON artifact_approvals
BEGIN SELECT RAISE(ABORT, 'artifact approvals are append-only'); END;
