import type { Env, NodeRecord, MeshPeerRecord, FeatureFlag } from '../types';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS nodes (
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
  )`,
  `CREATE TABLE IF NOT EXISTS mesh_peers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    overlay_ip TEXT NOT NULL,
    public_key TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'node',
    online INTEGER NOT NULL DEFAULT 1,
    last_seen TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mesh_peers_overlay_ip ON mesh_peers(overlay_ip)`,
  `CREATE TABLE IF NOT EXISTS node_commands (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_node_commands_pending ON node_commands(node_id, created_at ASC)`,
  `CREATE TABLE IF NOT EXISTS feature_flags (
    key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS control_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fleet_revisions (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fleet_revisions_seq ON fleet_revisions(seq DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_fleet_revisions_service ON fleet_revisions(env, service, seq DESC)`,
  `CREATE TABLE IF NOT EXISTS fleet_placements (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fleet_placements_node ON fleet_placements(node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fleet_placements_service ON fleet_placements(env, service, replica_index ASC)`,
  `CREATE TABLE IF NOT EXISTS job_runs (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_job_runs_recent ON job_runs(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_job_runs_lookup ON job_runs(env, service, job_name, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_job_runs_cron_slot ON job_runs(cron_slot)`,
  `CREATE TABLE IF NOT EXISTS mesh_tunnels (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mesh_tunnels_expires ON mesh_tunnels(expires_at ASC)`,
];

const initializedDbs = new WeakSet<object>();
const fallbackCacheKey = {};
const nodeDbWriteCache = new WeakMap<object, Map<string, number>>();
const flagsVersionCache = new WeakMap<object, { version: string; at: number }>();
const FLAGS_VERSION_CACHE_MS = 5000;
const NODE_HEARTBEAT_WRITE_THROTTLE_MS = 60000;

function getCacheTarget(env: Env): object {
  return (env.CONTROL_DB as unknown as object) || (env.FLEET_KV as unknown as object) || fallbackCacheKey;
}

function getNodeWriteMap(env: Env): Map<string, number> {
  const target = getCacheTarget(env);
  let map = nodeDbWriteCache.get(target);
  if (!map) {
    map = new Map<string, number>();
    nodeDbWriteCache.set(target, map);
  }
  return map;
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlag[] = [
  {
    key: 'pre_deploy_snapshots',
    description: 'Automated Cloudflare R2 backup guardrail before container slot flip',
    enabled: true,
    rollout_pct: 100,
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    key: 'canary_auto_rollback',
    description: 'Automatically roll back blue/green deployments when health probes degrade',
    enabled: true,
    rollout_pct: 100,
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

/**
 * Ensures D1 tables exist and performs a one-time, non-destructive hydration from FLEET_KV
 * so existing nodes, mesh peers, and feature flags carry over automatically.
 */
export async function ensureControlDbReady(env: Env): Promise<D1Database | null> {
  const db = env.CONTROL_DB;
  if (!db) return null;
  if (initializedDbs.has(db)) return db;

  try {
    await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
    await hydrateFromKvOnce(db, env);
    initializedDbs.add(db);
  } catch {
    // Allow retry on transient cold-start issues while keeping callers resilient
  }
  return db;
}

async function hydrateFromKvOnce(db: D1Database, env: Env): Promise<void> {
  if (!env.FLEET_KV) return;

  const marker = await db
    .prepare(`SELECT value FROM control_meta WHERE key = 'kv_hydrated_v1'`)
    .first<{ value: string }>();
  if (marker?.value === '1') return;

  const nowIso = new Date().toISOString();

  // 1. Hydrate nodes from FLEET_KV
  try {
    const rawNodes = await env.FLEET_KV.get('fleet:nodes');
    const ids: string[] = rawNodes ? JSON.parse(rawNodes) : [];
    for (const id of Array.from(new Set(ids))) {
      const rawNode = await env.FLEET_KV.get(`node:${id}`);
      if (rawNode) {
        const node = JSON.parse(rawNode) as NodeRecord;
        await writeNodeRow(db, node);
      }
    }
  } catch {}

  // 2. Hydrate mesh peers from FLEET_KV (deduplicated by peer.id)
  try {
    const rawPeers = await env.FLEET_KV.get('mesh:peers');
    const peerIds: string[] = rawPeers ? JSON.parse(rawPeers) : [];
    for (const id of Array.from(new Set(peerIds))) {
      const rawPeer = await env.FLEET_KV.get(`mesh:peer:${id}`);
      if (rawPeer) {
        const peer = JSON.parse(rawPeer) as MeshPeerRecord;
        await writeMeshPeerRow(db, peer);
      }
    }
  } catch {}

  // 3. Hydrate feature flags from FLEET_KV
  try {
    const rawFlags = await env.FLEET_KV.get('fleet:flags');
    const flagKeys: string[] = rawFlags ? JSON.parse(rawFlags) : [];
    for (const key of Array.from(new Set(flagKeys))) {
      const rawFlag = await env.FLEET_KV.get(`flag:${key}`);
      if (rawFlag) {
        const flag = JSON.parse(rawFlag) as FeatureFlag;
        await writeFeatureFlagRow(db, flag);
      }
    }
  } catch {}

  const initialFlagsVersion = `fv_${Date.now()}`;
  await db
    .prepare(
      `INSERT INTO control_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`
    )
    .bind('flags_version', initialFlagsVersion, nowIso)
    .run();

  await db
    .prepare(
      `INSERT INTO control_meta (key, value, updated_at) VALUES ('kv_hydrated_v1', '1', ?)
       ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`
    )
    .bind(nowIso)
    .run();
}

async function writeNodeRow(db: D1Database, record: NodeRecord): Promise<void> {
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO nodes (node_id, hostname, provider, region, status, version, last_heartbeat, enrolled_at, updated_at, record_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         hostname = excluded.hostname,
         provider = excluded.provider,
         region = excluded.region,
         status = excluded.status,
         version = excluded.version,
         last_heartbeat = excluded.last_heartbeat,
         updated_at = excluded.updated_at,
         record_json = excluded.record_json`
    )
    .bind(
      record.node_id,
      record.hostname || record.node_id,
      record.provider || '',
      record.region || '',
      record.status || 'Healthy',
      record.version || '',
      Number(record.last_heartbeat || Date.now()),
      record.enrolled_at || nowIso,
      record.updated_at || nowIso,
      JSON.stringify(record)
    )
    .run();
}

async function writeMeshPeerRow(db: D1Database, peer: MeshPeerRecord): Promise<void> {
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO mesh_peers (id, name, overlay_ip, public_key, type, online, last_seen, updated_at, record_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         overlay_ip = excluded.overlay_ip,
         public_key = excluded.public_key,
         type = excluded.type,
         online = excluded.online,
         last_seen = excluded.last_seen,
         updated_at = excluded.updated_at,
         record_json = excluded.record_json`
    )
    .bind(
      peer.id,
      peer.name || peer.id,
      peer.overlay_ip || peer.tailscale_ip || '',
      peer.public_key || '',
      peer.type || 'node',
      peer.online === false ? 0 : 1,
      peer.last_seen || nowIso,
      peer.updated_at || nowIso,
      JSON.stringify(peer)
    )
    .run();
}

async function writeFeatureFlagRow(db: D1Database, flag: FeatureFlag): Promise<void> {
  const nowIso = flag.updated_at || new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO feature_flags (key, enabled, updated_at, record_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at,
         record_json = excluded.record_json`
    )
    .bind(flag.key, flag.enabled ? 1 : 0, nowIso, JSON.stringify(flag))
    .run();
}

// ============================================================================
// Nodes Registry (D1 primary, KV fallback when CONTROL_DB is absent)
// ============================================================================

export async function upsertNodeRecord(
  env: Env,
  record: NodeRecord,
  opts?: { forceWrite?: boolean }
): Promise<void> {
  const db = await ensureControlDbReady(env);
  if (db) {
    const now = Date.now();
    const writeMap = getNodeWriteMap(env);
    const lastWrite = writeMap.get(record.node_id) || 0;
    if (opts?.forceWrite || now - lastWrite >= NODE_HEARTBEAT_WRITE_THROTTLE_MS) {
      writeMap.set(record.node_id, now);
      await writeNodeRow(db, record);
    }
    return;
  }

  if (env.FLEET_KV && opts?.forceWrite) {
    await env.FLEET_KV.put(`node:${record.node_id}`, JSON.stringify(record));
    try {
      const existingRaw = await env.FLEET_KV.get('fleet:nodes');
      const ids: string[] = existingRaw ? JSON.parse(existingRaw) : [];
      if (!ids.includes(record.node_id)) {
        ids.push(record.node_id);
        await env.FLEET_KV.put('fleet:nodes', JSON.stringify(ids));
      }
    } catch {}
  }
}

export async function getNodeRecordD1(env: Env, nodeId: string): Promise<NodeRecord | null> {
  const db = await ensureControlDbReady(env);
  if (db) {
    const row = await db
      .prepare(`SELECT record_json FROM nodes WHERE node_id = ?`)
      .bind(nodeId)
      .first<{ record_json: string }>();
    if (row?.record_json) {
      try {
        return JSON.parse(row.record_json) as NodeRecord;
      } catch {}
    }
    return null;
  }

  if (env.FLEET_KV) {
    const raw = await env.FLEET_KV.get(`node:${nodeId}`);
    if (raw) {
      try {
        return JSON.parse(raw) as NodeRecord;
      } catch {}
    }
  }
  return null;
}

export async function deleteNodeRecordD1(env: Env, nodeId: string): Promise<void> {
  getNodeWriteMap(env).delete(nodeId);
  const db = await ensureControlDbReady(env);
  if (db) {
    await db.batch([
      db.prepare(`DELETE FROM nodes WHERE node_id = ?`).bind(nodeId),
      db.prepare(`DELETE FROM node_commands WHERE node_id = ?`).bind(nodeId),
      db.prepare(`DELETE FROM fleet_placements WHERE node_id = ? AND status != 'fenced'`).bind(nodeId),
    ]);
  }

  if (env.FLEET_KV) {
    try {
      await env.FLEET_KV.delete(`node:${nodeId}`);
      await env.FLEET_KV.delete(`fleet:commands:${nodeId}`);
      const existingRaw = await env.FLEET_KV.get('fleet:nodes');
      if (existingRaw) {
        const ids: string[] = JSON.parse(existingRaw);
        const filtered = ids.filter((id) => id !== nodeId);
        await env.FLEET_KV.put('fleet:nodes', JSON.stringify(filtered));
      }
    } catch {}
  }
}

export async function listNodeRecordsD1(env: Env): Promise<NodeRecord[]> {
  const db = await ensureControlDbReady(env);
  if (db) {
    const res = await db
      .prepare(`SELECT record_json FROM nodes ORDER BY enrolled_at ASC`)
      .all<{ record_json: string }>();
    const out: NodeRecord[] = [];
    for (const row of res.results || []) {
      try {
        out.push(JSON.parse(row.record_json) as NodeRecord);
      } catch {}
    }
    return out;
  }

  const nodes: NodeRecord[] = [];
  if (env.FLEET_KV) {
    try {
      const existingRaw = await env.FLEET_KV.get('fleet:nodes');
      if (existingRaw) {
        const ids: string[] = JSON.parse(existingRaw);
        for (const id of ids) {
          const raw = await env.FLEET_KV.get(`node:${id}`);
          if (raw) nodes.push(JSON.parse(raw));
        }
      }
    } catch {}
  }
  return nodes;
}

// ============================================================================
// Mesh Peers Registry (D1 primary with deduplicated PK upsert)
// ============================================================================

export async function upsertMeshPeerD1(env: Env, peer: MeshPeerRecord): Promise<void> {
  const db = await ensureControlDbReady(env);
  if (db) {
    await writeMeshPeerRow(db, peer);
    return;
  }

  if (env.FLEET_KV) {
    await env.FLEET_KV.put(`mesh:peer:${peer.id}`, JSON.stringify(peer));
    try {
      const rawList = await env.FLEET_KV.get('mesh:peers');
      const ids: string[] = rawList ? JSON.parse(rawList) : [];
      if (!ids.includes(peer.id)) {
        ids.push(peer.id);
        await env.FLEET_KV.put('mesh:peers', JSON.stringify(ids));
      }
    } catch {}
  }
}

export async function deleteMeshPeerD1(env: Env, peerId: string): Promise<void> {
  const db = await ensureControlDbReady(env);
  if (db) {
    await db.prepare(`DELETE FROM mesh_peers WHERE id = ?`).bind(peerId).run();
  }
  if (env.FLEET_KV) {
    try {
      await env.FLEET_KV.delete(`mesh:peer:${peerId}`);
      await env.FLEET_KV.delete(`mesh:client_priv:${peerId}`);
    } catch {}
  }
}

export async function listMeshPeersD1(env: Env): Promise<MeshPeerRecord[]> {
  const db = await ensureControlDbReady(env);
  if (db) {
    const res = await db
      .prepare(`SELECT record_json FROM mesh_peers ORDER BY id ASC`)
      .all<{ record_json: string }>();
    const out: MeshPeerRecord[] = [];
    for (const row of res.results || []) {
      try {
        out.push(JSON.parse(row.record_json) as MeshPeerRecord);
      } catch {}
    }
    return out;
  }

  const peers: MeshPeerRecord[] = [];
  if (env.FLEET_KV) {
    try {
      const rawList = await env.FLEET_KV.get('mesh:peers');
      if (rawList) {
        const ids: string[] = JSON.parse(rawList);
        for (const id of Array.from(new Set(ids))) {
          const raw = await env.FLEET_KV.get(`mesh:peer:${id}`);
          if (raw) peers.push(JSON.parse(raw));
        }
      }
    } catch {}
  }
  return peers;
}

// ============================================================================
// Node Command Queue (Zero R2.list() Class A calls; 0 rows scanned when idle)
// ============================================================================

export async function enqueueCommandD1(env: Env, nodeId: string, cmd: any): Promise<void> {
  const db = await ensureControlDbReady(env);
  const nowIso = cmd.timestamp || new Date().toISOString();
  if (db) {
    await db
      .prepare(
        `INSERT INTO node_commands (id, node_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload_json = excluded.payload_json,
           created_at = excluded.created_at`
      )
      .bind(String(cmd.id), nodeId, String(cmd.type || 'unknown'), JSON.stringify(cmd), nowIso)
      .run();
    return;
  }

  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get(`fleet:commands:${nodeId}`);
      const list: any[] = raw ? JSON.parse(raw) : [];
      if (!list.some((x) => x.id === cmd.id)) {
        list.push(cmd);
        await env.FLEET_KV.put(`fleet:commands:${nodeId}`, JSON.stringify(list));
      }
    } catch {}
  }
}

export async function listPendingCommandsD1(env: Env, nodeId: string): Promise<any[]> {
  const db = await ensureControlDbReady(env);
  if (db) {
    const res = await db
      .prepare(
        `SELECT payload_json FROM node_commands
         WHERE node_id = ?
         ORDER BY created_at ASC
         LIMIT 20`
      )
      .bind(nodeId)
      .all<{ payload_json: string }>();
    const out: any[] = [];
    for (const row of res.results || []) {
      try {
        out.push(JSON.parse(row.payload_json));
      } catch {}
    }
    return out;
  }

  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get(`fleet:commands:${nodeId}`);
      if (raw) return JSON.parse(raw) as any[];
    } catch {}
  }
  return [];
}

export async function ackCommandD1(env: Env, nodeId: string, cmdId: string): Promise<void> {
  const db = await ensureControlDbReady(env);
  if (db) {
    await db
      .prepare(`DELETE FROM node_commands WHERE id = ? AND node_id = ?`)
      .bind(cmdId, nodeId)
      .run();
  }

  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get(`fleet:commands:${nodeId}`);
      if (raw) {
        const cmds: any[] = JSON.parse(raw);
        const filtered = cmds.filter((c: any) => c.id !== cmdId);
        if (filtered.length === 0) {
          await env.FLEET_KV.delete(`fleet:commands:${nodeId}`);
        } else {
          await env.FLEET_KV.put(`fleet:commands:${nodeId}`, JSON.stringify(filtered));
        }
      }
    } catch {}
  }
}

// ============================================================================
// Feature Flags & Version Hash (Eliminates 5s blind KV polling)
// ============================================================================

export async function listFeatureFlagsD1(env: Env): Promise<FeatureFlag[]> {
  const db = await ensureControlDbReady(env);
  if (db) {
    const res = await db
      .prepare(`SELECT record_json FROM feature_flags ORDER BY key ASC`)
      .all<{ record_json: string }>();
    const flags: FeatureFlag[] = [];
    for (const row of res.results || []) {
      try {
        flags.push(JSON.parse(row.record_json) as FeatureFlag);
      } catch {}
    }
    return flags.length > 0 ? flags : DEFAULT_FEATURE_FLAGS;
  }

  const flags: FeatureFlag[] = [];
  if (env.FLEET_KV) {
    try {
      const rawList = await env.FLEET_KV.get('fleet:flags');
      if (rawList) {
        const keys: string[] = JSON.parse(rawList);
        for (const k of keys) {
          const rawFlag = await env.FLEET_KV.get(`flag:${k}`);
          if (rawFlag) flags.push(JSON.parse(rawFlag));
        }
      }
    } catch {}
  }
  return flags.length > 0 ? flags : DEFAULT_FEATURE_FLAGS;
}

export async function getFeatureFlagD1(env: Env, key: string): Promise<FeatureFlag | null> {
  const db = await ensureControlDbReady(env);
  if (db) {
    const row = await db
      .prepare(`SELECT record_json FROM feature_flags WHERE key = ?`)
      .bind(key)
      .first<{ record_json: string }>();
    if (row?.record_json) {
      try {
        return JSON.parse(row.record_json) as FeatureFlag;
      } catch {}
    }
    return null;
  }

  if (env.FLEET_KV) {
    const raw = await env.FLEET_KV.get(`flag:${key}`);
    if (raw) {
      try {
        return JSON.parse(raw) as FeatureFlag;
      } catch {}
    }
  }
  return null;
}

export async function saveFeatureFlagD1(env: Env, flag: FeatureFlag): Promise<string> {
  const nowIso = flag.updated_at || new Date().toISOString();
  flag.updated_at = nowIso;
  const newVersion = `fv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const db = await ensureControlDbReady(env);
  if (db) {
    await writeFeatureFlagRow(db, flag);
    await db
      .prepare(
        `INSERT INTO control_meta (key, value, updated_at) VALUES ('flags_version', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .bind(newVersion, nowIso)
      .run();
    flagsVersionCache.set(getCacheTarget(env), { version: newVersion, at: Date.now() });
    return newVersion;
  }

  if (env.FLEET_KV) {
    await env.FLEET_KV.put(`flag:${flag.key}`, JSON.stringify(flag));
    try {
      const rawList = await env.FLEET_KV.get('fleet:flags');
      const list: string[] = rawList ? JSON.parse(rawList) : [];
      if (!list.includes(flag.key)) {
        list.push(flag.key);
        await env.FLEET_KV.put('fleet:flags', JSON.stringify(list));
      }
      await env.FLEET_KV.put('fleet:flags_version', newVersion);
    } catch {}
  }
  flagsVersionCache.set(getCacheTarget(env), { version: newVersion, at: Date.now() });
  return newVersion;
}

export async function deleteFeatureFlagD1(env: Env, key: string): Promise<string> {
  const nowIso = new Date().toISOString();
  const newVersion = `fv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const db = await ensureControlDbReady(env);
  if (db) {
    await db.prepare(`DELETE FROM feature_flags WHERE key = ?`).bind(key).run();
    await db
      .prepare(
        `INSERT INTO control_meta (key, value, updated_at) VALUES ('flags_version', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .bind(newVersion, nowIso)
      .run();
  }

  if (env.FLEET_KV) {
    try {
      await env.FLEET_KV.delete(`flag:${key}`);
      const rawList = await env.FLEET_KV.get('fleet:flags');
      if (rawList) {
        const list: string[] = JSON.parse(rawList).filter((k: string) => k !== key);
        await env.FLEET_KV.put('fleet:flags', JSON.stringify(list));
      }
      await env.FLEET_KV.put('fleet:flags_version', newVersion);
    } catch {}
  }

  flagsVersionCache.set(getCacheTarget(env), { version: newVersion, at: Date.now() });
  return newVersion;
}

export async function getFlagsVersion(env: Env): Promise<string> {
  const now = Date.now();
  const target = getCacheTarget(env);
  const cached = flagsVersionCache.get(target);
  if (cached && now - cached.at < FLAGS_VERSION_CACHE_MS) {
    return cached.version;
  }

  const db = await ensureControlDbReady(env);
  if (db) {
    const row = await db
      .prepare(`SELECT value FROM control_meta WHERE key = 'flags_version'`)
      .first<{ value: string }>();
    const ver = row?.value || 'fv_default';
    flagsVersionCache.set(target, { version: ver, at: now });
    return ver;
  }

  if (env.FLEET_KV) {
    try {
      const ver = (await env.FLEET_KV.get('fleet:flags_version')) || 'fv_default';
      flagsVersionCache.set(target, { version: ver, at: now });
      return ver;
    } catch {}
  }

  return cached?.version || 'fv_default';
}

export interface FleetRevisionRecord {
  rev_id: string;
  seq: number;
  service: string;
  env: string;
  action: string;
  actor: string;
  reason: string;
  manifest_sha256: string;
  manifest: any | null;
  prev_manifest: any | null;
  diff_summary: string[];
  created_at: string;
}

interface RawFleetRevisionRow {
  rev_id: string;
  seq: number;
  service: string;
  env: string;
  action: string;
  actor: string;
  reason: string;
  manifest_sha256: string;
  manifest_json: string;
  prev_manifest_json: string | null;
  diff_summary_json: string;
  created_at: string;
}

function hydrateRevisionRow(row: RawFleetRevisionRow): FleetRevisionRecord {
  let manifest: any = null;
  let prevManifest: any = null;
  let diffSummary: string[] = [];
  try {
    manifest = row.manifest_json ? JSON.parse(row.manifest_json) : null;
  } catch {}
  try {
    prevManifest = row.prev_manifest_json ? JSON.parse(row.prev_manifest_json) : null;
  } catch {}
  try {
    const parsedDiff = row.diff_summary_json ? JSON.parse(row.diff_summary_json) : [];
    if (Array.isArray(parsedDiff)) diffSummary = parsedDiff.map(String);
  } catch {}

  return {
    rev_id: row.rev_id,
    seq: Number(row.seq || 0),
    service: row.service,
    env: row.env,
    action: row.action,
    actor: row.actor,
    reason: row.reason,
    manifest_sha256: row.manifest_sha256,
    manifest,
    prev_manifest: prevManifest,
    diff_summary: diffSummary,
    created_at: row.created_at,
  };
}

export async function recordFleetRevision(
  env: Env,
  params: {
    service: string;
    env: string;
    action: string;
    actor?: string;
    reason?: string;
    manifest_sha256: string;
    manifest: any | null;
    prev_manifest?: any | null;
    diff_summary?: string[];
  },
  ctx?: ExecutionContext
): Promise<FleetRevisionRecord> {
  const nowIso = new Date().toISOString();
  const actor = (params.actor || 'dashboard').trim() || 'dashboard';
  const reason = (params.reason || '').trim();
  const diffSummary = Array.isArray(params.diff_summary) ? params.diff_summary : [];
  const manifestJson = JSON.stringify(params.manifest ?? null);
  const prevManifestJson = params.prev_manifest !== undefined && params.prev_manifest !== null
    ? JSON.stringify(params.prev_manifest)
    : null;
  const diffSummaryJson = JSON.stringify(diffSummary);

  const db = await ensureControlDbReady(env);
  let seq = 1;

  if (db) {
    const maxRow = await db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM fleet_revisions`)
      .first<{ max_seq: number }>();
    seq = Number(maxRow?.max_seq || 0) + 1;
    const revId = `rev-${seq}`;

    await db
      .prepare(
        `INSERT INTO fleet_revisions (
          rev_id, seq, service, env, action, actor, reason,
          manifest_sha256, manifest_json, prev_manifest_json, diff_summary_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        revId,
        seq,
        params.service,
        params.env,
        params.action,
        actor,
        reason,
        params.manifest_sha256,
        manifestJson,
        prevManifestJson,
        diffSummaryJson,
        nowIso
      )
      .run();

    const record: FleetRevisionRecord = {
      rev_id: revId,
      seq,
      service: params.service,
      env: params.env,
      action: params.action,
      actor,
      reason,
      manifest_sha256: params.manifest_sha256,
      manifest: params.manifest ?? null,
      prev_manifest: params.prev_manifest ?? null,
      diff_summary: diffSummary,
      created_at: nowIso,
    };
    persistRevisionToR2(env, record, ctx);
    return record;
  }

  if (env.FLEET_KV) {
    let list: FleetRevisionRecord[] = [];
    try {
      const raw = await env.FLEET_KV.get('fleet:revisions:all');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      }
    } catch {}
    const maxSeq = list.reduce((acc, r) => Math.max(acc, Number(r.seq || 0)), 0);
    seq = maxSeq + 1;
    const revId = `rev-${seq}`;
    const record: FleetRevisionRecord = {
      rev_id: revId,
      seq,
      service: params.service,
      env: params.env,
      action: params.action,
      actor,
      reason,
      manifest_sha256: params.manifest_sha256,
      manifest: params.manifest ?? null,
      prev_manifest: params.prev_manifest ?? null,
      diff_summary: diffSummary,
      created_at: nowIso,
    };
    list.unshift(record);
    if (list.length > 100) list = list.slice(0, 100);
    await env.FLEET_KV.put('fleet:revisions:all', JSON.stringify(list));
    persistRevisionToR2(env, record, ctx);
    return record;
  }

  return {
    rev_id: 'rev-1',
    seq: 1,
    service: params.service,
    env: params.env,
    action: params.action,
    actor,
    reason,
    manifest_sha256: params.manifest_sha256,
    manifest: params.manifest ?? null,
    prev_manifest: params.prev_manifest ?? null,
    diff_summary: diffSummary,
    created_at: nowIso,
  };
}

function persistRevisionToR2(env: Env, record: FleetRevisionRecord, ctx?: ExecutionContext): void {
  const bucket = (env as any).BACKUP_BUCKET || (env as any).LOGS_BUCKET;
  if (!bucket || typeof bucket.put !== 'function') return;
  const writePromise = Promise.resolve(
    bucket.put(`state/revisions/${record.rev_id}.json`, JSON.stringify(record, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    })
  ).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(writePromise);
  }
}

export async function listFleetRevisions(
  env: Env,
  opts?: { env?: string; service?: string; limit?: number }
): Promise<FleetRevisionRecord[]> {
  const limit = Math.min(Math.max(Number(opts?.limit || 40), 1), 200);
  const envFilter = opts?.env ? opts.env.trim().toLowerCase() : '';
  const svcFilter = opts?.service ? opts.service.trim().toLowerCase() : '';

  const db = await ensureControlDbReady(env);
  if (db) {
    let sql = `SELECT * FROM fleet_revisions`;
    const clauses: string[] = [];
    const binds: any[] = [];
    if (envFilter) {
      clauses.push(`LOWER(env) = ?`);
      binds.push(envFilter);
    }
    if (svcFilter) {
      clauses.push(`LOWER(service) = ?`);
      binds.push(svcFilter);
    }
    if (clauses.length > 0) {
      sql += ` WHERE ` + clauses.join(' AND ');
    }
    sql += ` ORDER BY seq DESC LIMIT ?`;
    binds.push(limit);

    const res = await db.prepare(sql).bind(...binds).all<RawFleetRevisionRow>();
    return (res.results || []).map(hydrateRevisionRow);
  }

  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('fleet:revisions:all');
      const list: FleetRevisionRecord[] = raw ? JSON.parse(raw) : [];
      return list
        .filter((r) => (!envFilter || r.env.toLowerCase() === envFilter) && (!svcFilter || r.service.toLowerCase() === svcFilter))
        .slice(0, limit);
    } catch {}
  }
  return [];
}

export async function getFleetRevision(env: Env, revId: string): Promise<FleetRevisionRecord | null> {
  const cleanId = (revId || '').trim();
  if (!cleanId) return null;

  const db = await ensureControlDbReady(env);
  if (db) {
    const row = await db
      .prepare(`SELECT * FROM fleet_revisions WHERE rev_id = ?`)
      .bind(cleanId)
      .first<RawFleetRevisionRow>();
    if (row) return hydrateRevisionRow(row);
  }

  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('fleet:revisions:all');
      const list: FleetRevisionRecord[] = raw ? JSON.parse(raw) : [];
      const found = list.find((r) => r.rev_id === cleanId);
      if (found) return found;
    } catch {}
  }

  const bucket = (env as any).BACKUP_BUCKET || (env as any).LOGS_BUCKET;
  if (bucket && typeof bucket.get === 'function') {
    try {
      const obj = await bucket.get(`state/revisions/${cleanId}.json`);
      if (obj) {
        const text = typeof obj.text === 'function' ? await obj.text() : '';
        if (text) return JSON.parse(text) as FleetRevisionRecord;
      }
    } catch {}
  }

  return null;
}

// ============================================================================
// Multi-Node Fleet Placements Registry (D1 primary, KV fallback)
// ============================================================================

export interface FleetPlacementRecord {
  placement_id: string;
  env: string;
  service: string;
  replica_index: number;
  node_id: string;
  mode: 'blue_green' | 'singleton';
  strategy: 'spread' | 'binpack' | 'pinned';
  memory_mb: number;
  mesh_ip: string;
  mesh_port: number;
  active_port: number;
  desired_image: string;
  status: 'placed' | 'fenced' | 'unscheduled' | 'evicting';
  reason: string;
  updated_at: string;
}

function hydratePlacementRow(row: any): FleetPlacementRecord {
  return {
    placement_id: String(row.placement_id || `${row.env}:${row.service}:${row.replica_index || 0}`),
    env: String(row.env || 'uat'),
    service: String(row.service || ''),
    replica_index: Number(row.replica_index || 0),
    node_id: String(row.node_id || ''),
    mode: row.mode === 'singleton' ? 'singleton' : 'blue_green',
    strategy:
      row.strategy === 'binpack' || row.strategy === 'pinned' ? row.strategy : 'spread',
    memory_mb: Number(row.memory_mb || 256),
    mesh_ip: String(row.mesh_ip || ''),
    mesh_port: Number(row.mesh_port || 0),
    active_port: Number(row.active_port || 0),
    desired_image: String(row.desired_image || ''),
    status:
      row.status === 'fenced' || row.status === 'unscheduled' || row.status === 'evicting'
        ? row.status
        : 'placed',
    reason: String(row.reason || ''),
    updated_at: String(row.updated_at || new Date().toISOString()),
  };
}

export async function listFleetPlacements(
  env: Env,
  filters?: { env?: string; service?: string; node_id?: string }
): Promise<FleetPlacementRecord[]> {
  const envFilter = filters?.env ? filters.env.trim().toLowerCase() : '';
  const svcFilter = filters?.service ? filters.service.trim().toLowerCase() : '';
  const nodeFilter = filters?.node_id ? filters.node_id.trim() : '';

  const db = await ensureControlDbReady(env);
  if (db) {
    let sql = `SELECT * FROM fleet_placements`;
    const clauses: string[] = [];
    const binds: any[] = [];
    if (envFilter) {
      clauses.push(`LOWER(env) = ?`);
      binds.push(envFilter);
    }
    if (svcFilter) {
      clauses.push(`LOWER(service) = ?`);
      binds.push(svcFilter);
    }
    if (nodeFilter) {
      clauses.push(`node_id = ?`);
      binds.push(nodeFilter);
    }
    if (clauses.length > 0) {
      sql += ` WHERE ` + clauses.join(' AND ');
    }
    sql += ` ORDER BY env ASC, service ASC, replica_index ASC`;
    const res = await db.prepare(sql).bind(...binds).all<any>();
    return (res.results || []).map(hydratePlacementRow);
  }

  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('fleet:placements:all');
      const list: FleetPlacementRecord[] = raw ? JSON.parse(raw) : [];
      return list
        .map(hydratePlacementRow)
        .filter(
          (p) =>
            (!envFilter || p.env.toLowerCase() === envFilter) &&
            (!svcFilter || p.service.toLowerCase() === svcFilter) &&
            (!nodeFilter || p.node_id === nodeFilter)
        )
        .sort((a, b) =>
          a.env.localeCompare(b.env) ||
          a.service.localeCompare(b.service) ||
          a.replica_index - b.replica_index
        );
    } catch {}
  }
  return [];
}

export async function saveServicePlacements(
  env: Env,
  envName: string,
  service: string,
  placements: FleetPlacementRecord[]
): Promise<void> {
  const cleanEnv = envName.trim().toLowerCase();
  const cleanSvc = service.trim().toLowerCase();
  const nowIso = new Date().toISOString();

  const db = await ensureControlDbReady(env);
  if (db) {
    const stmts = [
      db
        .prepare(`DELETE FROM fleet_placements WHERE LOWER(env) = ? AND LOWER(service) = ?`)
        .bind(cleanEnv, cleanSvc),
    ];
    for (const p of placements) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO fleet_placements (
              placement_id, env, service, replica_index, node_id, mode, strategy,
              memory_mb, mesh_ip, mesh_port, active_port, desired_image, status, reason, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            p.placement_id || `${cleanEnv}:${cleanSvc}:${p.replica_index}`,
            cleanEnv,
            cleanSvc,
            Number(p.replica_index || 0),
            p.node_id,
            p.mode || 'blue_green',
            p.strategy || 'spread',
            Number(p.memory_mb || 256),
            p.mesh_ip || '',
            Number(p.mesh_port || 0),
            Number(p.active_port || 0),
            p.desired_image || '',
            p.status || 'placed',
            p.reason || '',
            p.updated_at || nowIso
          )
      );
    }
    await db.batch(stmts);
    return;
  }

  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('fleet:placements:all');
      const prev: FleetPlacementRecord[] = raw ? JSON.parse(raw) : [];
      const kept = prev.filter(
        (x) => !(x.env.toLowerCase() === cleanEnv && x.service.toLowerCase() === cleanSvc)
      );
      const next = [
        ...kept,
        ...placements.map((p) => ({
          ...p,
          placement_id: p.placement_id || `${cleanEnv}:${cleanSvc}:${p.replica_index}`,
          env: cleanEnv,
          service: cleanSvc,
          updated_at: p.updated_at || nowIso,
        })),
      ];
      await env.FLEET_KV.put('fleet:placements:all', JSON.stringify(next));
    } catch {}
  }
}

export async function deleteServicePlacements(
  env: Env,
  envName: string,
  service: string
): Promise<void> {
  await saveServicePlacements(env, envName, service, []);
}

export async function updatePlacementRuntimePort(
  env: Env,
  nodeId: string,
  envName: string,
  service: string,
  activePort: number,
  status?: 'placed' | 'fenced' | 'unscheduled' | 'evicting'
): Promise<void> {
  if (!nodeId || !service) return;
  const cleanEnv = (envName || 'uat').trim().toLowerCase();
  const cleanSvc = service.trim().toLowerCase();
  const nowIso = new Date().toISOString();

  const db = await ensureControlDbReady(env);
  if (db) {
    if (status) {
      await db
        .prepare(
          `UPDATE fleet_placements
           SET active_port = ?, status = ?, updated_at = ?
           WHERE node_id = ? AND LOWER(env) = ? AND LOWER(service) = ?`
        )
        .bind(Number(activePort || 0), status, nowIso, nodeId, cleanEnv, cleanSvc)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE fleet_placements
           SET active_port = ?, updated_at = ?
           WHERE node_id = ? AND LOWER(env) = ? AND LOWER(service) = ?`
        )
        .bind(Number(activePort || 0), nowIso, nodeId, cleanEnv, cleanSvc)
        .run();
    }
    return;
  }

  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('fleet:placements:all');
      if (!raw) return;
      const list: FleetPlacementRecord[] = JSON.parse(raw);
      let mutated = false;
      for (const p of list) {
        if (
          p.node_id === nodeId &&
          p.env.toLowerCase() === cleanEnv &&
          p.service.toLowerCase() === cleanSvc
        ) {
          p.active_port = Number(activePort || 0);
          if (status) p.status = status;
          p.updated_at = nowIso;
          mutated = true;
        }
      }
      if (mutated) {
        await env.FLEET_KV.put('fleet:placements:all', JSON.stringify(list));
      }
    } catch {}
  }
}

// ============================================================================
// Declarative CronJobs & One-Off Container Job Runs
// ============================================================================

export type JobRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out';

export interface JobRunRecord {
  run_id: string;
  env: string;
  service: string;
  job_name: string;
  image: string;
  command: string[];
  trigger: 'cron' | 'manual' | 'api' | string;
  cron_slot?: string;
  node_id: string;
  container_id?: string;
  status: JobRunStatus;
  exit_code?: number | null;
  output?: string;
  error?: string;
  duration_ms?: number;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  updated_at: string;
}

interface RawJobRunRow {
  run_id: string;
  env: string;
  service: string;
  job_name: string;
  image: string;
  command_json: string;
  trigger: string;
  cron_slot: string;
  node_id: string;
  container_id: string;
  status: string;
  exit_code: number | null;
  output: string;
  error: string;
  duration_ms: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

function hydrateJobRunRow(row: RawJobRunRow): JobRunRecord {
  let command: string[] = [];
  try {
    const parsed = row.command_json ? JSON.parse(row.command_json) : [];
    if (Array.isArray(parsed)) command = parsed.map(String);
  } catch {}
  return {
    run_id: row.run_id,
    env: row.env,
    service: row.service,
    job_name: row.job_name,
    image: row.image || '',
    command,
    trigger: row.trigger || 'manual',
    cron_slot: row.cron_slot || undefined,
    node_id: row.node_id || '',
    container_id: row.container_id || undefined,
    status: (row.status as JobRunStatus) || 'queued',
    exit_code: row.exit_code !== null && row.exit_code !== undefined ? Number(row.exit_code) : null,
    output: row.output || '',
    error: row.error || '',
    duration_ms: Number(row.duration_ms || 0),
    created_at: row.created_at,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    updated_at: row.updated_at,
  };
}

export async function upsertJobRunD1(env: Env, run: JobRunRecord): Promise<void> {
  const nowIso = new Date().toISOString();
  const cmdJson = JSON.stringify(Array.isArray(run.command) ? run.command : []);
  const cappedOutput = String(run.output || '').slice(-32768);
  const cappedError = String(run.error || '').slice(0, 4096);

  const db = await ensureControlDbReady(env);
  if (db) {
    await db
      .prepare(
        `INSERT INTO job_runs (
          run_id, env, service, job_name, image, command_json, trigger, cron_slot,
          node_id, container_id, status, exit_code, output, error, duration_ms,
          created_at, started_at, finished_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          node_id = CASE WHEN excluded.node_id != '' THEN excluded.node_id ELSE job_runs.node_id END,
          container_id = CASE WHEN excluded.container_id != '' THEN excluded.container_id ELSE job_runs.container_id END,
          status = excluded.status,
          exit_code = COALESCE(excluded.exit_code, job_runs.exit_code),
          output = CASE WHEN excluded.output != '' THEN excluded.output ELSE job_runs.output END,
          error = CASE WHEN excluded.error != '' THEN excluded.error ELSE job_runs.error END,
          duration_ms = CASE WHEN excluded.duration_ms > 0 THEN excluded.duration_ms ELSE job_runs.duration_ms END,
          started_at = COALESCE(excluded.started_at, job_runs.started_at),
          finished_at = COALESCE(excluded.finished_at, job_runs.finished_at),
          updated_at = excluded.updated_at`
      )
      .bind(
        run.run_id,
        run.env.toLowerCase(),
        run.service.toLowerCase(),
        run.job_name,
        run.image || '',
        cmdJson,
        run.trigger || 'manual',
        run.cron_slot || '',
        run.node_id || '',
        run.container_id || '',
        run.status || 'queued',
        run.exit_code !== undefined && run.exit_code !== null ? Number(run.exit_code) : null,
        cappedOutput,
        cappedError,
        Number(run.duration_ms || 0),
        run.created_at || nowIso,
        run.started_at ?? null,
        run.finished_at ?? null,
        run.updated_at || nowIso
      )
      .run();
    return;
  }

  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('fleet:job_runs:recent');
      const list: JobRunRecord[] = raw ? JSON.parse(raw) : [];
      const idx = list.findIndex((r) => r.run_id === run.run_id);
      const merged: JobRunRecord =
        idx >= 0
          ? {
              ...list[idx],
              ...run,
              output: cappedOutput || list[idx].output,
              error: cappedError || list[idx].error,
              updated_at: run.updated_at || nowIso,
            }
          : { ...run, output: cappedOutput, error: cappedError, updated_at: run.updated_at || nowIso };
      if (idx >= 0) list[idx] = merged;
      else list.unshift(merged);
      if (list.length > 100) list.length = 100;
      await env.FLEET_KV.put('fleet:job_runs:recent', JSON.stringify(list));
    } catch {}
  }
}

export async function getJobRunD1(env: Env, runId: string): Promise<JobRunRecord | null> {
  if (!runId) return null;
  const db = await ensureControlDbReady(env);
  if (db) {
    const row = await db
      .prepare(`SELECT * FROM job_runs WHERE run_id = ?`)
      .bind(runId)
      .first<RawJobRunRow>();
    return row ? hydrateJobRunRow(row) : null;
  }
  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('fleet:job_runs:recent');
      const list: JobRunRecord[] = raw ? JSON.parse(raw) : [];
      return list.find((r) => r.run_id === runId) || null;
    } catch {}
  }
  return null;
}

export async function listJobRunsD1(
  env: Env,
  opts?: { env?: string; service?: string; job_name?: string; limit?: number }
): Promise<JobRunRecord[]> {
  const limit = Math.max(1, Math.min(200, Number(opts?.limit || 50)));
  const cleanEnv = opts?.env ? opts.env.trim().toLowerCase() : '';
  const cleanSvc = opts?.service ? opts.service.trim().toLowerCase() : '';
  const cleanJob = opts?.job_name ? opts.job_name.trim() : '';

  const db = await ensureControlDbReady(env);
  if (db) {
    const clauses: string[] = [];
    const binds: any[] = [];
    if (cleanEnv) {
      clauses.push('LOWER(env) = ?');
      binds.push(cleanEnv);
    }
    if (cleanSvc) {
      clauses.push('LOWER(service) = ?');
      binds.push(cleanSvc);
    }
    if (cleanJob) {
      clauses.push('LOWER(job_name) = ?');
      binds.push(cleanJob.toLowerCase());
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const res = await db
      .prepare(`SELECT * FROM job_runs ${whereSql} ORDER BY created_at DESC LIMIT ?`)
      .bind(...binds, limit)
      .all<RawJobRunRow>();
    return (res.results || []).map(hydrateJobRunRow);
  }

  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('fleet:job_runs:recent');
      let list: JobRunRecord[] = raw ? JSON.parse(raw) : [];
      if (cleanEnv) list = list.filter((r) => r.env.toLowerCase() === cleanEnv);
      if (cleanSvc) list = list.filter((r) => r.service.toLowerCase() === cleanSvc);
      if (cleanJob) list = list.filter((r) => r.job_name.toLowerCase() === cleanJob.toLowerCase());
      return list.slice(0, limit);
    } catch {}
  }
  return [];
}

export async function hasCronSlotFiredD1(env: Env, cronSlot: string): Promise<boolean> {
  if (!cronSlot) return false;
  const db = await ensureControlDbReady(env);
  if (db) {
    const row = await db
      .prepare(`SELECT run_id FROM job_runs WHERE cron_slot = ? LIMIT 1`)
      .bind(cronSlot)
      .first<{ run_id: string }>();
    return Boolean(row?.run_id);
  }
  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('fleet:job_runs:recent');
      const list: JobRunRecord[] = raw ? JSON.parse(raw) : [];
      return list.some((r) => r.cron_slot === cronSlot);
    } catch {}
  }
  return false;
}

export async function listActiveJobRunsForSpecD1(
  env: Env,
  envName: string,
  service: string,
  jobName: string
): Promise<JobRunRecord[]> {
  const runs = await listJobRunsD1(env, { env: envName, service, job_name: jobName, limit: 10 });
  return runs.filter((r) => r.status === 'queued' || r.status === 'running');
}

// ============================================================================
// Ephemeral WireGuard + Traefik Public HTTPS Funnel Tunnels (`mesh_tunnels`)
// ============================================================================

export interface MeshTunnelRecord {
  tunnel_id: string;
  peer_id: string;
  public_key: string;
  domain: string;
  node_id: string;
  target_ip: string;
  target_port: number;
  local_port: number;
  has_auth: boolean;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

interface RawMeshTunnelRow {
  tunnel_id: string;
  peer_id: string;
  public_key: string;
  domain: string;
  node_id: string;
  target_ip: string;
  target_port: number;
  local_port: number;
  has_auth: number;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

function hydrateMeshTunnelRow(row: RawMeshTunnelRow): MeshTunnelRecord {
  return {
    tunnel_id: row.tunnel_id,
    peer_id: row.peer_id || '',
    public_key: row.public_key || '',
    domain: row.domain,
    node_id: row.node_id,
    target_ip: row.target_ip,
    target_port: Number(row.target_port || 0),
    local_port: Number(row.local_port || 0),
    has_auth: Boolean(row.has_auth),
    created_at: row.created_at,
    expires_at: row.expires_at,
    updated_at: row.updated_at,
  };
}

export async function upsertMeshTunnelD1(env: Env, tunnel: MeshTunnelRecord): Promise<void> {
  const nowIso = new Date().toISOString();
  const db = await ensureControlDbReady(env);
  if (db) {
    await db
      .prepare(
        `INSERT INTO mesh_tunnels (
           tunnel_id, peer_id, public_key, domain, node_id, target_ip, target_port, local_port, has_auth, created_at, expires_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tunnel_id) DO UPDATE SET
           peer_id = excluded.peer_id,
           public_key = excluded.public_key,
           domain = excluded.domain,
           node_id = excluded.node_id,
           target_ip = excluded.target_ip,
           target_port = excluded.target_port,
           local_port = excluded.local_port,
           has_auth = excluded.has_auth,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`
      )
      .bind(
        tunnel.tunnel_id,
        tunnel.peer_id || '',
        tunnel.public_key || '',
        tunnel.domain.toLowerCase(),
        tunnel.node_id,
        tunnel.target_ip,
        Number(tunnel.target_port),
        Number(tunnel.local_port || 0),
        tunnel.has_auth ? 1 : 0,
        tunnel.created_at || nowIso,
        tunnel.expires_at,
        tunnel.updated_at || nowIso
      )
      .run();
    return;
  }

  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('mesh:tunnels:active');
      const list: MeshTunnelRecord[] = raw ? JSON.parse(raw) : [];
      const filtered = list.filter(
        (t) => t.tunnel_id !== tunnel.tunnel_id && t.domain.toLowerCase() !== tunnel.domain.toLowerCase()
      );
      filtered.unshift({ ...tunnel, domain: tunnel.domain.toLowerCase() });
      await env.FLEET_KV.put('mesh:tunnels:active', JSON.stringify(filtered));
    } catch {}
  }
}

export async function getMeshTunnelD1(env: Env, tunnelId: string): Promise<MeshTunnelRecord | null> {
  if (!tunnelId) return null;
  const db = await ensureControlDbReady(env);
  if (db) {
    const row = await db
      .prepare(`SELECT * FROM mesh_tunnels WHERE tunnel_id = ?`)
      .bind(tunnelId)
      .first<RawMeshTunnelRow>();
    return row ? hydrateMeshTunnelRow(row) : null;
  }
  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('mesh:tunnels:active');
      const list: MeshTunnelRecord[] = raw ? JSON.parse(raw) : [];
      return list.find((t) => t.tunnel_id === tunnelId) || null;
    } catch {}
  }
  return null;
}

export async function getMeshTunnelByDomainD1(env: Env, domain: string): Promise<MeshTunnelRecord | null> {
  const clean = String(domain || '').trim().toLowerCase();
  if (!clean) return null;
  const db = await ensureControlDbReady(env);
  if (db) {
    const row = await db
      .prepare(`SELECT * FROM mesh_tunnels WHERE LOWER(domain) = ? LIMIT 1`)
      .bind(clean)
      .first<RawMeshTunnelRow>();
    return row ? hydrateMeshTunnelRow(row) : null;
  }
  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('mesh:tunnels:active');
      const list: MeshTunnelRecord[] = raw ? JSON.parse(raw) : [];
      return list.find((t) => t.domain.toLowerCase() === clean) || null;
    } catch {}
  }
  return null;
}

export async function listMeshTunnelsD1(env: Env): Promise<MeshTunnelRecord[]> {
  const db = await ensureControlDbReady(env);
  if (db) {
    const res = await db
      .prepare(`SELECT * FROM mesh_tunnels ORDER BY created_at DESC LIMIT 200`)
      .all<RawMeshTunnelRow>();
    return (res.results || []).map(hydrateMeshTunnelRow);
  }
  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('mesh:tunnels:active');
      return raw ? (JSON.parse(raw) as MeshTunnelRecord[]) : [];
    } catch {}
  }
  return [];
}

export async function listExpiredMeshTunnelsD1(
  env: Env,
  nowIso = new Date().toISOString()
): Promise<MeshTunnelRecord[]> {
  const db = await ensureControlDbReady(env);
  if (db) {
    const res = await db
      .prepare(`SELECT * FROM mesh_tunnels WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT 200`)
      .bind(nowIso)
      .all<RawMeshTunnelRow>();
    return (res.results || []).map(hydrateMeshTunnelRow);
  }
  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('mesh:tunnels:active');
      const list: MeshTunnelRecord[] = raw ? JSON.parse(raw) : [];
      return list.filter((t) => t.expires_at <= nowIso);
    } catch {}
  }
  return [];
}

export async function deleteMeshTunnelD1(env: Env, tunnelId: string): Promise<void> {
  if (!tunnelId) return;
  const db = await ensureControlDbReady(env);
  if (db) {
    await db.prepare(`DELETE FROM mesh_tunnels WHERE tunnel_id = ?`).bind(tunnelId).run();
    return;
  }
  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('mesh:tunnels:active');
      const list: MeshTunnelRecord[] = raw ? JSON.parse(raw) : [];
      const filtered = list.filter((t) => t.tunnel_id !== tunnelId);
      await env.FLEET_KV.put('mesh:tunnels:active', JSON.stringify(filtered));
    } catch {}
  }
}
