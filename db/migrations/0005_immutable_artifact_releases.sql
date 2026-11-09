-- No backfill: an old publish journal is not evidence of frozen bytes.
CREATE TABLE artifact_releases (
  id TEXT PRIMARY KEY NOT NULL REFERENCES publish_releases(id),
  book_slug TEXT NOT NULL,
  revision TEXT NOT NULL,
  manifest_key TEXT NOT NULL UNIQUE,
  manifest_sha256 TEXT NOT NULL,
  manifest_etag TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX artifact_releases_book ON artifact_releases(book_slug, created_at);
CREATE TABLE artifact_release_heads (
  book_slug TEXT PRIMARY KEY NOT NULL,
  release_id TEXT NOT NULL REFERENCES artifact_releases(id)
);
-- Intentional mutable per-order derivatives retain their immutable master lineage.
CREATE TABLE print_release_items (
  item_id TEXT PRIMARY KEY NOT NULL,
  book_slug TEXT NOT NULL,
  release_id TEXT NOT NULL REFERENCES artifact_releases(id),
  kind TEXT NOT NULL,
  interior_key TEXT NOT NULL,
  cover_key TEXT NOT NULL,
  personalized_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER artifact_releases_no_update BEFORE UPDATE ON artifact_releases BEGIN SELECT RAISE(ABORT, 'Artifact releases are append-only'); END;
CREATE TRIGGER artifact_releases_no_delete BEFORE DELETE ON artifact_releases BEGIN SELECT RAISE(ABORT, 'Artifact releases are append-only'); END;
CREATE TRIGGER print_release_items_no_update BEFORE UPDATE ON print_release_items BEGIN SELECT RAISE(ABORT, 'Print release lineage is append-only'); END;
CREATE TRIGGER print_release_items_no_delete BEFORE DELETE ON print_release_items BEGIN SELECT RAISE(ABORT, 'Print release lineage is append-only'); END;
