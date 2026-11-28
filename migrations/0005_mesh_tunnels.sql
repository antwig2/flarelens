-- Migration 0005: Ephemeral WireGuard + Traefik Public HTTPS Funnel Tunnels (`flarelensd http <port>`)
CREATE TABLE IF NOT EXISTS mesh_tunnels (
  tunnel_id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL DEFAULT '',
  public_key TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL UNIQUE,
  node_id TEXT NOT NULL,
  target_ip TEXT NOT NULL,
  target_port INTEGER NOT NULL,
  local_port INTEGER NOT NULL DEFAULT 0,
  has_auth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mesh_tunnels_expires ON mesh_tunnels(expires_at ASC);
