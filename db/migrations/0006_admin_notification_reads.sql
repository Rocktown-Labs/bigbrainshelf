-- Admin notifications read state (orders admin redo, 2026-11-10).
-- A notification's identity is the stable key the notification
-- builder computes from the row of record (for example
-- "print_job_failed:<job id>"); marking it read stores one row
-- here. The notification itself is never stored: it is derived
-- from live rows on every read, so a resolved problem disappears
-- on its own and a read mark on a still-open problem just quiets
-- the badge until the underlying row changes identity.
CREATE TABLE IF NOT EXISTS admin_notification_reads (
  notification_id TEXT PRIMARY KEY NOT NULL,
  read_at INTEGER NOT NULL,
  read_by TEXT
);
