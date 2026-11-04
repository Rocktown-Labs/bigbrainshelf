-- Apply to a local/test DB first; RGM applies to production before rollout.
-- Preserve existing Phase 1 release rows. No backfill invents historical provenance.
CREATE TABLE IF NOT EXISTS publish_releases (
  id TEXT PRIMARY KEY NOT NULL,
  book_slug TEXT NOT NULL,
  revision TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  override_json TEXT,
  actor TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS publish_releases_book_created ON publish_releases(book_slug, created_at);

CREATE TABLE IF NOT EXISTS worker_runs (
  id TEXT PRIMARY KEY NOT NULL,
  worker TEXT NOT NULL,
  run_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  book_slug TEXT,
  deployment_id TEXT,
  source_sha TEXT,
  build_digest TEXT,
  provenance_status TEXT NOT NULL CHECK (provenance_status IN ('known', 'unknown')),
  started_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS worker_runs_book_started ON worker_runs(book_slug, started_at);
