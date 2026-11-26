-- Migration 0004: Declarative CronJobs & One-Off Container Job Runs
CREATE TABLE IF NOT EXISTS job_runs (
  run_id TEXT PRIMARY KEY,
  env TEXT NOT NULL,
  service TEXT NOT NULL,
  job_name TEXT NOT NULL,
  image TEXT NOT NULL DEFAULT '',
  command_json TEXT NOT NULL DEFAULT '[]',
  trigger TEXT NOT NULL DEFAULT 'manual',
  cron_slot TEXT NOT NULL DEFAULT '',
  node_id TEXT NOT NULL DEFAULT '',
  container_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  exit_code INTEGER,
  output TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_runs_recent ON job_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_lookup ON job_runs(env, service, job_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_cron_slot ON job_runs(cron_slot);
