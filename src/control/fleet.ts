import type { NodeRecord } from '../types';
import type { FleetPlacementRecord } from './db';

export type FleetPlacementStrategy = 'spread' | 'binpack' | 'pinned';

export interface FleetWorkerSpec {
  name: string;
  command?: string[];
  entrypoint?: string[];
  volumes?: string[];
  networks?: string[];
  memory_mb?: number;
  cpu_cores?: number;
}

export interface FleetHealthcheckSpec {
  test: string[] | string;
  interval?: string;
  timeout?: string;
  retries?: number;
  start_period?: string;
}

export interface FleetServiceManifest {
  $schema?: string;
  service: string;
  env: 'uat' | 'prod' | 'infra' | 'staging' | 'dev' | string;
  mode?: 'blue_green' | 'singleton';
  image: string;
  enabled?: boolean;
  adopt_only?: boolean;
  node_id?: string;
  replicas?: number;
  memory_mb?: number;
  cpu_cores?: number;
  placement_strategy?: FleetPlacementStrategy;
  required_tags?: string[];
  container_name?: string;
  restart?: 'always' | 'unless-stopped' | 'on-failure' | 'no';
  runtime?: 'runc' | 'runsc';
  domain?: string;
  domains?: string[];
  container_port?: number;
  host_port_blue?: number;
  host_port_green?: number;
  health_path?: string;
  timeout_seconds?: number;
  drain_seconds?: number;
  pre_deploy_snapshot?: boolean;
  run_migrations?: boolean;
  migration_cmd?: string;
  canary_weight?: number;
  canary_duration?: number;
  networks?: string[];
  aliases?: string[];
  volumes?: string[];
  ports?: string[];
  command?: string[] | string;
  entrypoint?: string[] | string;
  healthcheck?: FleetHealthcheckSpec;
  workers?: FleetWorkerSpec[];
  env_vars?: Record<string, string>;
  secrets?: Record<string, string>;
}

export interface FleetServiceStatus {
  service: string;
  env: string;
  mode: 'blue_green' | 'singleton';
  enabled: boolean;
  adopt_only?: boolean;
  target_node: string;
  placed_nodes?: string[];
  desired_replicas?: number;
  ready_replicas?: number;
  placement_strategy?: FleetPlacementStrategy;
  fenced?: boolean;
  desired_image: string;
  live_image?: string;
  active_containers: string[];
  sync_status: 'Synced' | 'OutOfSync' | 'Suspended' | 'Unknown';
  health_status: 'Healthy' | 'Progressing' | 'Degraded' | 'Missing' | 'Suspended';
  drift_reasons: string[];
  revision?: string;
  synced_commit?: string;
  updated_at?: string;
}

export const FLEET_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://flarelens.dev/schemas/fleet.schema.json',
  title: 'FlareLens Fleet Resource Manifest',
  description:
    'Declarative schema for FlareLens fleet service workloads, supporting Blue/Green rolling deployments, host infrastructure adoption, and stateful foundation services.',
  type: 'object',
  required: ['service', 'env', 'image'],
  properties: {
    $schema: { type: 'string' },
    service: { type: 'string', pattern: '^[a-z0-9-]+$' },
    env: { type: 'string', enum: ['infra', 'uat', 'prod', 'staging', 'dev'] },
    mode: { type: 'string', enum: ['blue_green', 'singleton'] },
    image: { type: 'string' },
    enabled: { type: 'boolean', default: true },
    adopt_only: { type: 'boolean', default: false },
    node_id: { type: 'string' },
    replicas: { type: 'integer', minimum: 1, maximum: 32, default: 1 },
    memory_mb: { type: 'integer', minimum: 32, maximum: 262144, default: 256 },
    cpu_cores: { type: 'number', minimum: 0.05, maximum: 256 },
    placement_strategy: { type: 'string', enum: ['spread', 'binpack', 'pinned'], default: 'spread' },
    required_tags: { type: 'array', items: { type: 'string' } },
    container_name: { type: 'string' },
    restart: { type: 'string', enum: ['always', 'unless-stopped', 'on-failure', 'no'], default: 'unless-stopped' },
    runtime: { type: 'string', enum: ['runc', 'runsc'], default: 'runc' },
    domain: { type: 'string', format: 'hostname' },
    domains: { type: 'array', items: { type: 'string', format: 'hostname' } },
    container_port: { type: 'integer', minimum: 1, maximum: 65535 },
    host_port_blue: { type: 'integer', minimum: 1, maximum: 65535 },
    host_port_green: { type: 'integer', minimum: 1, maximum: 65535 },
    health_path: { type: 'string', default: '/health' },
    timeout_seconds: { type: 'integer', minimum: 1, default: 90 },
    drain_seconds: { type: 'integer', minimum: 0, default: 15 },
    pre_deploy_snapshot: { type: 'boolean', default: false },
    run_migrations: { type: 'boolean', default: false },
    migration_cmd: { type: 'string' },
    canary_weight: { type: 'integer', minimum: 0, maximum: 100, default: 0 },
    canary_duration: { type: 'integer', minimum: 0, default: 0 },
    networks: { type: 'array', items: { type: 'string' } },
    aliases: { type: 'array', items: { type: 'string' } },
    volumes: { type: 'array', items: { type: 'string' } },
    ports: { type: 'array', items: { type: 'string' } },
    command: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
    entrypoint: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
    healthcheck: {
      type: 'object',
      required: ['test'],
      properties: {
        test: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
        interval: { type: 'string' },
        timeout: { type: 'string' },
        retries: { type: 'integer', minimum: 1 },
        start_period: { type: 'string' },
      },
    },
    workers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          command: { type: 'array', items: { type: 'string' } },
          entrypoint: { type: 'array', items: { type: 'string' } },
          volumes: { type: 'array', items: { type: 'string' } },
          networks: { type: 'array', items: { type: 'string' } },
          memory_mb: { type: 'integer', minimum: 32, maximum: 262144 },
          cpu_cores: { type: 'number', minimum: 0.05, maximum: 256 },
        },
      },
    },
    env_vars: { type: 'object', additionalProperties: { type: 'string' } },
    secrets: { type: 'object', additionalProperties: { type: 'string' } },
  },
  additionalProperties: false,
};

export function stripManifestInternalMeta(m: any): FleetServiceManifest {
  if (!m || typeof m !== 'object') return m;
  const clean: Record<string, any> = {};
  for (const key of Object.keys(m).sort()) {
    if (key.startsWith('_') || key === 'secrets') continue;
    if (m[key] === undefined) continue;
    clean[key] = m[key];
  }
  if (clean.env) clean.env = normalizeFleetEnv(clean.env);
  return clean as FleetServiceManifest;
}

function canonicalizeJson(value: any): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(value[k])}`).join(',') + '}';
}

export async function computeManifestSha256(m: any): Promise<string> {
  const clean = m ? stripManifestInternalMeta(m) : null;
  const bytes = new TextEncoder().encode(canonicalizeJson(clean));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function maskIfSensitive(key: string, val: string): string {
  if (/secret|token|password|key|dsn|private/i.test(key)) {
    return '***';
  }
  return val.length > 48 ? val.slice(0, 45) + '...' : val;
}

export function computeManifestDiffSummary(prevRaw: any | null, currRaw: any | null): string[] {
  if (!prevRaw && currRaw) {
    const c = stripManifestInternalMeta(currRaw);
    return [`Created ${c.env}/${c.service} (${c.image})`];
  }
  if (prevRaw && !currRaw) {
    const p = stripManifestInternalMeta(prevRaw);
    return [`Deleted ${p.env}/${p.service}`];
  }
  if (!prevRaw && !currRaw) return [];

  const prev = stripManifestInternalMeta(prevRaw) as Record<string, any>;
  const curr = stripManifestInternalMeta(currRaw) as Record<string, any>;
  const allKeys = Array.from(new Set([...Object.keys(prev), ...Object.keys(curr)])).sort();
  const diffs: string[] = [];

  for (const k of allKeys) {
    if (k === '$schema') continue;
    const pVal = prev[k];
    const cVal = curr[k];
    if (canonicalizeJson(pVal) === canonicalizeJson(cVal)) continue;

    if (k === 'env_vars') {
      const pEnv = (pVal || {}) as Record<string, string>;
      const cEnv = (cVal || {}) as Record<string, string>;
      const envKeys = Array.from(new Set([...Object.keys(pEnv), ...Object.keys(cEnv)])).sort();
      const changedEnv = envKeys.filter((ek) => pEnv[ek] !== cEnv[ek]);
      if (changedEnv.length > 0) {
        const preview = changedEnv
          .slice(0, 3)
          .map((ek) =>
            cEnv[ek] === undefined
              ? `-${ek}`
              : `${ek}=${maskIfSensitive(ek, String(cEnv[ek]))}`
          )
          .join(', ');
        diffs.push(`env_vars (${changedEnv.length}): ${preview}${changedEnv.length > 3 ? '…' : ''}`);
      }
      continue;
    }

    const fmt = (v: any) => (v === undefined ? 'unset' : typeof v === 'string' ? v : JSON.stringify(v));
    diffs.push(`${k}: ${fmt(pVal)} → ${fmt(cVal)}`);
  }

  return diffs.length > 0 ? diffs : ['No structural manifest fields changed'];
}

export function buildPromotedManifest(
  sourceRaw: FleetServiceManifest,
  existingTargetRaw: FleetServiceManifest | null,
  toEnvRaw: string,
  effectiveSourceImage?: string,
  enableTarget?: boolean
): FleetServiceManifest {
  const fromEnv = normalizeFleetEnv(sourceRaw.env);
  const toEnv = normalizeFleetEnv(toEnvRaw);
  const src = stripManifestInternalMeta(sourceRaw);
  const rawImg = effectiveSourceImage || src.image;

  const promotedImage = rawImg.endsWith(`:${fromEnv}`)
    ? `${rawImg.slice(0, -(fromEnv.length + 1))}:${toEnv}`
    : rawImg;

  if (existingTargetRaw) {
    const tgt = stripManifestInternalMeta(existingTargetRaw);
    return {
      ...tgt,
      service: src.service,
      env: toEnv,
      image: promotedImage,
      enabled: enableTarget !== undefined ? enableTarget : tgt.enabled,
      container_port: src.container_port ?? tgt.container_port,
      health_path: src.health_path ?? tgt.health_path,
      timeout_seconds: src.timeout_seconds ?? tgt.timeout_seconds,
      drain_seconds: src.drain_seconds ?? tgt.drain_seconds,
      migration_cmd: src.migration_cmd ?? tgt.migration_cmd,
      command: src.command ?? tgt.command,
      entrypoint: src.entrypoint ?? tgt.entrypoint,
      workers: tgt.workers ?? src.workers,
      replicas: tgt.replicas ?? src.replicas,
      memory_mb: tgt.memory_mb ?? src.memory_mb,
      cpu_cores: tgt.cpu_cores ?? src.cpu_cores,
      placement_strategy: tgt.placement_strategy ?? src.placement_strategy,
      required_tags: tgt.required_tags ?? src.required_tags,
    };
  }

  const swapEnvToken = (val: string) =>
    val
      .replace(new RegExp(`-${fromEnv}\\b`, 'g'), `-${toEnv}`)
      .replace(new RegExp(`\\b${fromEnv}-`, 'g'), `${toEnv}-`)
      .replace(new RegExp(`/${fromEnv}/`, 'g'), `/${toEnv}/`);

  const portOffset = toEnv === 'prod' && fromEnv !== 'prod' ? 1000 : 0;

  return {
    ...src,
    env: toEnv,
    image: promotedImage,
    enabled: enableTarget !== undefined ? enableTarget : false,
    ...(src.container_name ? { container_name: swapEnvToken(src.container_name) } : {}),
    ...(src.host_port_blue ? { host_port_blue: src.host_port_blue + portOffset } : {}),
    ...(src.host_port_green ? { host_port_green: src.host_port_green + portOffset } : {}),
    ...(src.networks ? { networks: src.networks.map(swapEnvToken) } : {}),
    ...(src.aliases ? { aliases: src.aliases.map(swapEnvToken) } : {}),
    ...(src.volumes ? { volumes: src.volumes.map(swapEnvToken) } : {}),
    ...(src.workers
      ? {
        workers: src.workers.map((w) => ({
          ...w,
          ...(w.networks ? { networks: w.networks.map(swapEnvToken) } : {}),
          ...(w.volumes ? { volumes: w.volumes.map(swapEnvToken) } : {}),
        })),
      }
      : {}),
  };
}

export function normalizeFleetEnv(envName: string | undefined): string {
  const raw = (envName || 'uat').trim().toLowerCase();
  if (raw === 'production') return 'prod';
  if (raw === 'infrastructure') return 'infra';
  return raw || 'uat';
}

export function normalizeCommandArray(cmd: string[] | string | undefined): string[] | undefined {
  if (!cmd) return undefined;
  if (Array.isArray(cmd)) return cmd.map(String);
  const trimmed = String(cmd).trim();
  return trimmed ? trimmed.split(/\s+/) : undefined;
}

export function isSingletonManifest(m: FleetServiceManifest): boolean {
  if (m.mode === 'singleton') return true;
  if (m.mode === 'blue_green') return false;
  return Boolean(m.container_name) && !m.host_port_blue && !m.host_port_green;
}

export function validateFleetManifest(m: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!m || typeof m !== 'object') {
    return { valid: false, errors: ['Manifest must be a JSON/YAML object'] };
  }
  if (!m.service || typeof m.service !== 'string' || !/^[a-z0-9-]+$/.test(m.service)) {
    errors.push(`Invalid or missing 'service' (${String(m.service)}): must match ^[a-z0-9-]+$`);
  }
  const allowedEnvs = ['uat', 'prod', 'production', 'infra', 'infrastructure', 'staging', 'dev'];
  if (!m.env || typeof m.env !== 'string' || !allowedEnvs.includes(m.env.toLowerCase())) {
    errors.push(`Invalid or missing 'env' (${String(m.env)}): must be one of infra, uat, prod, staging, dev`);
  }
  if (m.enabled !== undefined && typeof m.enabled !== 'boolean') {
    errors.push(`Invalid 'enabled' (${String(m.enabled)}): must be boolean`);
  }
  if (m.adopt_only !== undefined && typeof m.adopt_only !== 'boolean') {
    errors.push(`Invalid 'adopt_only' (${String(m.adopt_only)}): must be boolean`);
  }
  if (m.replicas !== undefined) {
    const rep = Number(m.replicas);
    if (!Number.isInteger(rep) || rep < 1 || rep > 32) {
      errors.push(`Invalid 'replicas' (${String(m.replicas)}): must be integer 1..32`);
    }
  }
  if (m.memory_mb !== undefined) {
    const mem = Number(m.memory_mb);
    if (!Number.isInteger(mem) || mem < 32 || mem > 262144) {
      errors.push(`Invalid 'memory_mb' (${String(m.memory_mb)}): must be integer 32..262144`);
    }
  }
  if (m.cpu_cores !== undefined) {
    const cpu = Number(m.cpu_cores);
    if (!Number.isFinite(cpu) || cpu < 0.05 || cpu > 256) {
      errors.push(`Invalid 'cpu_cores' (${String(m.cpu_cores)}): must be number 0.05..256`);
    }
  }
  if (m.placement_strategy !== undefined) {
    const allowedStrategies = ['spread', 'binpack', 'pinned'];
    if (typeof m.placement_strategy !== 'string' || !allowedStrategies.includes(m.placement_strategy)) {
      errors.push(`Invalid 'placement_strategy' (${String(m.placement_strategy)}): must be spread, binpack, or pinned`);
    }
  }
  if (m.required_tags !== undefined) {
    if (!Array.isArray(m.required_tags) || m.required_tags.some((t: any) => typeof t !== 'string' || !t.trim())) {
      errors.push(`Invalid 'required_tags': must be an array of non-empty tag strings`);
    }
  }
  if (m.domains !== undefined) {
    if (!Array.isArray(m.domains) || m.domains.some((d: any) => typeof d !== 'string' || !d.trim())) {
      errors.push(`Invalid 'domains': must be an array of non-empty hostname strings`);
    }
  }
  if (!m.image || typeof m.image !== 'string' || m.image.trim() === '') {
    errors.push(`Invalid or missing 'image' for service '${m.service || 'unknown'}'`);
  }
  for (const portField of ['container_port', 'host_port_blue', 'host_port_green'] as const) {
    if (m[portField] !== undefined) {
      const val = Number(m[portField]);
      if (!Number.isInteger(val) || val < 1 || val > 65535) {
        errors.push(`Invalid '${portField}' (${String(m[portField])}): must be integer 1..65535`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export async function saveFleetManifests(
  kv: any,
  manifests: FleetServiceManifest[],
  meta?: { commit_sha?: string; actor?: string; synced_at?: string; revision?: string }
): Promise<void> {
  if (!kv) return;
  const byEnv = new Map<string, string[]>();
  const syncedAt = meta?.synced_at || new Date().toISOString();

  for (const m of manifests) {
    const env = normalizeFleetEnv(m.env);
    const key = `fleet:manifest:${env}:${m.service}`;
    const stored = {
      ...stripManifestInternalMeta(m),
      env,
      ...(meta?.revision || (m as any)._revision ? { _revision: meta?.revision || (m as any)._revision } : {}),
      ...(meta?.commit_sha !== undefined ? { _synced_commit: meta.commit_sha } : {}),
      ...(meta?.actor ? { _synced_by: meta.actor } : {}),
      _synced_at: syncedAt,
    };
    await kv.put(key, JSON.stringify(stored));

    const existingList = byEnv.get(env) || [];
    if (!existingList.includes(m.service)) {
      existingList.push(m.service);
    }
    byEnv.set(env, existingList);
  }

  for (const [env, services] of byEnv.entries()) {
    const indexKey = `fleet:manifests:${env}`;
    let merged = [...services];
    try {
      const raw = await kv.get(indexKey);
      if (raw) {
        const prev = JSON.parse(raw);
        if (Array.isArray(prev)) {
          for (const s of prev) {
            if (typeof s === 'string' && !merged.includes(s)) merged.push(s);
          }
        }
      }
    } catch { }
    merged.sort();
    await kv.put(indexKey, JSON.stringify(merged));
  }
}

export async function deleteFleetManifest(kv: any, envName: string, service: string): Promise<boolean> {
  if (!kv || !service) return false;
  const env = normalizeFleetEnv(envName);
  const cleanSvc = service.trim().toLowerCase();
  const key = `fleet:manifest:${env}:${cleanSvc}`;
  const existing = await kv.get(key);
  if (!existing) return false;

  await kv.delete(key);
  try {
    await kv.delete(`fleet:live_image:${env}:${cleanSvc}`);
  } catch { }

  try {
    const indexKey = `fleet:manifests:${env}`;
    const rawIdx = await kv.get(indexKey);
    if (rawIdx) {
      const parsed = JSON.parse(rawIdx);
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter((s: string) => s.toLowerCase() !== cleanSvc);
        await kv.put(indexKey, JSON.stringify(filtered));
      }
    }
  } catch { }

  return true;
}

export async function getFleetManifest(
  kv: any,
  envName: string,
  service: string
): Promise<(FleetServiceManifest & { _revision?: string; _synced_commit?: string; _synced_at?: string }) | null> {
  if (!kv || !service) return null;
  const env = normalizeFleetEnv(envName);
  try {
    const raw = await kv.get(`fleet:manifest:${env}:${service.toLowerCase()}`);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch { }
  return null;
}

export async function listFleetManifests(
  kv: any,
  envFilter?: string
): Promise<Array<FleetServiceManifest & { _revision?: string; _synced_commit?: string; _synced_at?: string }>> {
  if (!kv) return [];
  const envs = envFilter ? [normalizeFleetEnv(envFilter)] : ['infra', 'uat', 'prod', 'staging', 'dev'];
  const out: Array<FleetServiceManifest & { _revision?: string; _synced_commit?: string; _synced_at?: string }> = [];

  for (const env of envs) {
    try {
      const rawIdx = await kv.get(`fleet:manifests:${env}`);
      if (!rawIdx) continue;
      const services: string[] = JSON.parse(rawIdx);
      if (!Array.isArray(services)) continue;
      for (const svc of services) {
        const m = await getFleetManifest(kv, env, svc);
        if (m) out.push(m);
      }
    } catch { }
  }
  return out;
}

export async function recordLiveServiceImage(
  kv: any,
  envName: string,
  service: string,
  image: string
): Promise<void> {
  if (!kv || !service || !image) return;
  const env = normalizeFleetEnv(envName);
  await kv.put(
    `fleet:live_image:${env}:${service.toLowerCase()}`,
    JSON.stringify({
      image,
      updated_at: new Date().toISOString(),
    })
  );
}

export async function getLiveServiceImage(
  kv: any,
  envName: string,
  service: string
): Promise<string | null> {
  if (!kv || !service) return null;
  const env = normalizeFleetEnv(envName);
  try {
    const raw = await kv.get(`fleet:live_image:${env}:${service.toLowerCase()}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.image === 'string' && parsed.image.trim() !== '' ? parsed.image : null;
  } catch {
    return null;
  }
}

export function isContainerRunningOnNode(node: NodeRecord | undefined, containerName: string): boolean {
  if (!node || !containerName) return false;
  const target = containerName.trim().toLowerCase();
  const ctrs = node.latest_telemetry?.containers || [];
  for (const c of ctrs) {
    if ((c.state || '').toLowerCase() !== 'running') continue;
    const names = (c.names || []).map((n) => n.replace(/^\//, '').toLowerCase());
    if (names.includes(target)) return true;
  }
  return false;
}

export function isAgentVersionAtLeast(actual: string | undefined, minimum: string): boolean {
  if (!actual || !minimum) return false;
  const cleanActual = actual.trim().replace(/^v/i, '').split('-')[0];
  const cleanMin = minimum.trim().replace(/^v/i, '').split('-')[0];
  const aParts = cleanActual.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const mParts = cleanMin.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(aParts.length, mParts.length);
  for (let i = 0; i < len; i++) {
    const a = aParts[i] || 0;
    const m = mParts[i] || 0;
    if (a > m) return true;
    if (a < m) return false;
  }
  return true;
}

export function computeFleetDriftStatus(
  manifests: Array<FleetServiceManifest & { _revision?: string; _synced_commit?: string; _synced_at?: string }>,
  nodes: NodeRecord[],
  liveImagesByServiceKey: Record<string, string> = {},
  placements: FleetPlacementRecord[] = []
): FleetServiceStatus[] {
  return manifests.map((m) => {
    const env = normalizeFleetEnv(m.env);
    const mode = isSingletonManifest(m) ? 'singleton' : 'blue_green';
    const isEnabled = m.enabled !== false;
    const serviceKey = `${env}:${m.service.toLowerCase()}`;
    const desiredImage = liveImagesByServiceKey[serviceKey] || m.image;
    const desiredReplicas = mode === 'singleton' ? 1 : Math.max(1, Number(m.replicas || 1));
    const strategy: FleetPlacementStrategy =
      m.placement_strategy || (m.node_id && !['auto', 'smart', 'all', 'all-prod'].includes(m.node_id) ? 'pinned' : 'spread');

    const svcPlacements = placements.filter(
      (p) => p.env.toLowerCase() === env && p.service.toLowerCase() === m.service.toLowerCase()
    );
    const placedNodes = svcPlacements
      .filter((p) => p.node_id && p.status === 'placed')
      .map((p) => p.node_id);
    const isFenced = svcPlacements.some((p) => p.status === 'fenced');

    const candidateNodes =
      placedNodes.length > 0
        ? nodes.filter((n) => placedNodes.includes(n.node_id) || (n.hostname && placedNodes.includes(n.hostname)))
        : m.node_id
          ? nodes.filter((n) => n.node_id === m.node_id || n.hostname === m.node_id)
          : nodes;
    const searchNodes = candidateNodes.length > 0 ? candidateNodes : nodes;

    const matchingContainers: Array<{ nodeId: string; name: string; image: string; state: string }> = [];

    for (const node of searchNodes) {
      const ctrs = node.latest_telemetry?.containers || [];
      for (const c of ctrs) {
        const names = (c.names || []).map((n) => n.replace(/^\//, ''));
        const matched = names.some((n) => {
          const lower = n.toLowerCase();
          const svcLower = m.service.toLowerCase();
          if (m.container_name && lower === m.container_name.toLowerCase()) return true;
          if (mode === 'blue_green') {
            return (
              lower === `${svcLower}-blue` ||
              lower === `${svcLower}-green` ||
              lower === `${svcLower}-${env}-blue` ||
              lower === `${svcLower}-${env}-green` ||
              lower.endsWith(`-${env}-${svcLower}-blue`) ||
              lower.endsWith(`-${env}-${svcLower}-green`)
            );
          }
          return lower === svcLower || lower.endsWith(`-${svcLower}`);
        });
        if (matched) {
          matchingContainers.push({
            nodeId: node.node_id,
            name: names[0] || c.id,
            image: c.image,
            state: (c.state || '').toLowerCase(),
          });
        }
      }
    }

    const driftReasons: string[] = [];
    const running = matchingContainers.filter((c) => c.state === 'running');
    const runningNodeIds = Array.from(new Set(running.map((c) => c.nodeId)));
    const effectiveNodes = placedNodes.length > 0 ? placedNodes : runningNodeIds;
    const targetNode =
      effectiveNodes.length > 1
        ? effectiveNodes.join(', ')
        : effectiveNodes[0] || m.node_id || matchingContainers[0]?.nodeId || searchNodes[0]?.node_id || 'unassigned';
    const readyReplicas = mode === 'singleton' ? (running.length > 0 ? 1 : 0) : runningNodeIds.length;

    if (isFenced) {
      const fenceReason = svcPlacements.find((p) => p.status === 'fenced')?.reason || 'Stateful volume fenced on offline/cordoned node';
      driftReasons.push(fenceReason);
    }

    if (!isEnabled && matchingContainers.length === 0) {
      return {
        service: m.service,
        env,
        mode,
        enabled: false,
        adopt_only: m.adopt_only,
        target_node: targetNode,
        placed_nodes: effectiveNodes,
        desired_replicas: desiredReplicas,
        ready_replicas: 0,
        placement_strategy: strategy,
        fenced: isFenced,
        desired_image: desiredImage,
        active_containers: [],
        sync_status: 'Suspended',
        health_status: 'Suspended',
        drift_reasons: ['Manifest disabled (enabled: false) — awaiting environment activation'],
        revision: m._revision,
        synced_commit: m._synced_commit,
        updated_at: m._synced_at,
      };
    }

    if (isFenced) {
      return {
        service: m.service,
        env,
        mode,
        enabled: isEnabled,
        adopt_only: m.adopt_only,
        target_node: targetNode,
        placed_nodes: effectiveNodes,
        desired_replicas: desiredReplicas,
        ready_replicas: 0,
        placement_strategy: strategy,
        fenced: true,
        desired_image: desiredImage,
        active_containers: [],
        sync_status: 'OutOfSync',
        health_status: 'Degraded',
        drift_reasons: driftReasons,
        revision: m._revision,
        synced_commit: m._synced_commit,
        updated_at: m._synced_at,
      };
    }

    if (matchingContainers.length === 0) {
      driftReasons.push('No matching container reported in node telemetry');
      return {
        service: m.service,
        env,
        mode,
        enabled: isEnabled,
        adopt_only: m.adopt_only,
        target_node: targetNode,
        placed_nodes: effectiveNodes,
        desired_replicas: desiredReplicas,
        ready_replicas: 0,
        placement_strategy: strategy,
        fenced: false,
        desired_image: desiredImage,
        active_containers: [],
        sync_status: searchNodes.length === 0 ? 'Unknown' : 'OutOfSync',
        health_status: 'Missing',
        drift_reasons: driftReasons,
        revision: m._revision,
        synced_commit: m._synced_commit,
        updated_at: m._synced_at,
      };
    }

    if (running.length === 0) {
      driftReasons.push(`Container exists (${matchingContainers.map((c) => `${c.name}:${c.state}`).join(', ')}) but none running`);
      return {
        service: m.service,
        env,
        mode,
        enabled: isEnabled,
        adopt_only: m.adopt_only,
        target_node: targetNode,
        placed_nodes: effectiveNodes,
        desired_replicas: desiredReplicas,
        ready_replicas: 0,
        placement_strategy: strategy,
        fenced: false,
        desired_image: desiredImage,
        live_image: matchingContainers[0]?.image,
        active_containers: matchingContainers.map((c) => c.name),
        sync_status: 'OutOfSync',
        health_status: 'Degraded',
        drift_reasons: driftReasons,
        revision: m._revision,
        synced_commit: m._synced_commit,
        updated_at: m._synced_at,
      };
    }

    const liveImg = running[0].image;
    const imageMatches = running.every((c) => c.image === desiredImage);
    if (!imageMatches) {
      driftReasons.push(`Running image '${liveImg}' differs from desired '${desiredImage}'`);
    }
    if (desiredReplicas > 1 && readyReplicas < desiredReplicas) {
      driftReasons.push(`Replica count ${readyReplicas}/${desiredReplicas} running across placed nodes`);
    }

    return {
      service: m.service,
      env,
      mode,
      enabled: isEnabled,
      adopt_only: m.adopt_only,
      target_node: targetNode,
      placed_nodes: effectiveNodes,
      desired_replicas: desiredReplicas,
      ready_replicas: readyReplicas,
      placement_strategy: strategy,
      fenced: false,
      desired_image: desiredImage,
      live_image: liveImg,
      active_containers: running.map((c) => `${c.nodeId}:${c.name}`),
      sync_status: driftReasons.length === 0 ? 'Synced' : 'OutOfSync',
      health_status: readyReplicas < desiredReplicas ? 'Progressing' : 'Healthy',
      drift_reasons: driftReasons,
      revision: m._revision,
      synced_commit: m._synced_commit,
      updated_at: m._synced_at,
    };
  });
}
