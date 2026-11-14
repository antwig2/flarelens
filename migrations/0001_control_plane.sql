-- FlareLens Control Plane D1 Schema (Zero-Cost Indexed SQLite)
CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Healthy',
  version TEXT NOT NULL DEFAULT '',
  last_heartbeat INTEGER NOT NULL DEFAULT 0,
  enrolled_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mesh_peers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  overlay_ip TEXT NOT NULL,
  public_key TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'node',
  online INTEGER NOT NULL DEFAULT 1,
  last_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesh_peers_overlay_ip ON mesh_peers(overlay_ip);

CREATE TABLE IF NOT EXISTS node_commands (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_node_commands_pending ON node_commands(node_id, created_at ASC);

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
