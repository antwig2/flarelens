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
