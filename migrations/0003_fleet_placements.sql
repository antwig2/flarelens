-- FlareLens Multi-Server Placement Engine, WireGuard Mesh Service Endpoints & Stateful Fencing
CREATE TABLE IF NOT EXISTS fleet_placements (
  placement_id TEXT PRIMARY KEY,
  env TEXT NOT NULL,
  service TEXT NOT NULL,
  replica_index INTEGER NOT NULL DEFAULT 0,
  node_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'blue_green',
  strategy TEXT NOT NULL DEFAULT 'spread',
  memory_mb INTEGER NOT NULL DEFAULT 256,
  mesh_ip TEXT NOT NULL DEFAULT '',
  mesh_port INTEGER NOT NULL DEFAULT 0,
  active_port INTEGER NOT NULL DEFAULT 0,
  desired_image TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'placed',
  reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fleet_placements_node ON fleet_placements(node_id);
CREATE INDEX IF NOT EXISTS idx_fleet_placements_service ON fleet_placements(env, service, replica_index ASC);
