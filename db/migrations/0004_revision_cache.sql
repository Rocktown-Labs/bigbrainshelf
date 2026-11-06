-- Revision cache for the QC approval identity (2026-11-06).
--
-- captureApprovalRevision byte-hashes every artifact in a book to
-- derive the revision an approval binds to. That is the right check
-- when the book changes, but the QC viewer calls it on every page
-- load and every Good/Problem click, and re-reading + re-hashing
-- 100+ MB per click made most clicks die before they saved.
--
-- This table caches the byte-verified manifest under a version
-- fingerprint (the R2 etag of every artifact the capture covers).
-- A request whose fingerprint matches reuses the cached manifest;
-- any artifact change moves an etag, misses the cache, and runs
-- the full byte capture again. The cache is an optimization only:
-- readers must fall back to the deep capture when no row matches,
-- and the row is only written when the deep capture observed the
-- exact versions the fingerprint was built from.
CREATE TABLE IF NOT EXISTS revision_cache (
  book_slug TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
