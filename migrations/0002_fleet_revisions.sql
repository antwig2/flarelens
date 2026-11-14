-- FlareLens Control-Plane D1 Schema Migration 0002: Zero-Git Immutable Fleet Revisions
-- Persists numbered revisions (rev-1, rev-2, ...) for every declarative service create,
-- update, promotion, rollback, import, delete, or CI sync without requiring a Git repository.

CREATE TABLE IF NOT EXISTS fleet_revisions (
  rev_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  service TEXT NOT NULL,
  env TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'dashboard',
  reason TEXT NOT NULL DEFAULT '',
  manifest_sha256 TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL,
  prev_manifest_json TEXT,
  diff_summary_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fleet_revisions_seq
  ON fleet_revisions(seq DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_revisions_service
  ON fleet_revisions(env, service, seq DESC);
