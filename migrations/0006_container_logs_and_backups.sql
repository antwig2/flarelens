-- Migration 0006: Zero-SSH Live Container Log Streaming Sessions & Scheduled R2 Backup Slot Deduplication
CREATE TABLE IF NOT EXISTS container_log_sessions (
  session_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT '',
  service TEXT NOT NULL DEFAULT '',
  container_name TEXT NOT NULL DEFAULT '',
  follow INTEGER NOT NULL DEFAULT 1,
  tail_lines INTEGER NOT NULL DEFAULT 200,
  status TEXT NOT NULL DEFAULT 'queued',
  next_seq INTEGER NOT NULL DEFAULT 1,
  chunks_json TEXT NOT NULL DEFAULT '[]',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_container_log_sessions_expires ON container_log_sessions(expires_at ASC);

CREATE TABLE IF NOT EXISTS backup_cron_slots (
  slot_key TEXT PRIMARY KEY,
  env TEXT NOT NULL,
  service TEXT NOT NULL,
  backup_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
