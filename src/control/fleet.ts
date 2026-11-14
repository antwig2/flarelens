import type { NodeRecord } from '../types';

export interface FleetWorkerSpec {
  name: string;
  command?: string[];
  entrypoint?: string[];
  volumes?: string[];
  networks?: string[];
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
  image: string;
  enabled?: boolean;
  adopt_only?: boolean;
  node_id?: string;
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
  desired_image: string;
  live_image?: string;
  active_containers: string[];
  sync_status: 'Synced' | 'OutOfSync' | 'Suspended' | 'Unknown';
  health_status: 'Healthy' | 'Progressing' | 'Degraded' | 'Missing' | 'Suspended';
  drift_reasons: string[];
  synced_commit?: string;
  updated_at?: string;
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
  meta?: { commit_sha?: string; actor?: string; synced_at?: string }
): Promise<void> {
  if (!kv) return;
  const byEnv = new Map<string, string[]>();
  const syncedAt = meta?.synced_at || new Date().toISOString();

  for (const m of manifests) {
    const env = normalizeFleetEnv(m.env);
    const key = `fleet:manifest:${env}:${m.service}`;
    const stored = {
      ...m,
      env,
      _synced_commit: meta?.commit_sha,
      _synced_by: meta?.actor,
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
    } catch {}
    merged.sort();
    await kv.put(indexKey, JSON.stringify(merged));
  }
}

export async function getFleetManifest(
  kv: any,
  envName: string,
  service: string
): Promise<(FleetServiceManifest & { _synced_commit?: string; _synced_at?: string }) | null> {
  if (!kv || !service) return null;
  const env = normalizeFleetEnv(envName);
  try {
    const raw = await kv.get(`fleet:manifest:${env}:${service.toLowerCase()}`);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {}
  return null;
}

export async function listFleetManifests(
  kv: any,
  envFilter?: string
): Promise<Array<FleetServiceManifest & { _synced_commit?: string; _synced_at?: string }>> {
  if (!kv) return [];
  const envs = envFilter ? [normalizeFleetEnv(envFilter)] : ['infra', 'uat', 'prod', 'staging', 'dev'];
  const out: Array<FleetServiceManifest & { _synced_commit?: string; _synced_at?: string }> = [];

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
    } catch {}
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

export function computeFleetDriftStatus(
  manifests: Array<FleetServiceManifest & { _synced_commit?: string; _synced_at?: string }>,
  nodes: NodeRecord[],
  liveImagesByServiceKey: Record<string, string> = {}
): FleetServiceStatus[] {
  return manifests.map((m) => {
    const env = normalizeFleetEnv(m.env);
    const mode = isSingletonManifest(m) ? 'singleton' : 'blue_green';
    const isEnabled = m.enabled !== false;
    const serviceKey = `${env}:${m.service.toLowerCase()}`;
    const desiredImage = liveImagesByServiceKey[serviceKey] || m.image;

    const candidateNodes = m.node_id
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
    const targetNode = m.node_id || matchingContainers[0]?.nodeId || searchNodes[0]?.node_id || 'unassigned';

    if (!isEnabled && matchingContainers.length === 0) {
      return {
        service: m.service,
        env,
        mode,
        enabled: false,
        adopt_only: m.adopt_only,
        target_node: targetNode,
        desired_image: desiredImage,
        active_containers: [],
        sync_status: 'Suspended',
        health_status: 'Suspended',
        drift_reasons: ['Manifest disabled (enabled: false) — awaiting environment activation'],
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
        desired_image: desiredImage,
        active_containers: [],
        sync_status: searchNodes.length === 0 ? 'Unknown' : 'OutOfSync',
        health_status: 'Missing',
        drift_reasons: driftReasons,
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
        desired_image: desiredImage,
        live_image: matchingContainers[0]?.image,
        active_containers: matchingContainers.map((c) => c.name),
        sync_status: 'OutOfSync',
        health_status: 'Degraded',
        drift_reasons: driftReasons,
        synced_commit: m._synced_commit,
        updated_at: m._synced_at,
      };
    }

    const liveImg = running[0].image;
    const imageMatches = running.some((c) => c.image === desiredImage);
    if (!imageMatches) {
      driftReasons.push(`Running image '${liveImg}' differs from desired '${desiredImage}'`);
    }

    return {
      service: m.service,
      env,
      mode,
      enabled: isEnabled,
      adopt_only: m.adopt_only,
      target_node: targetNode,
      desired_image: desiredImage,
      live_image: liveImg,
      active_containers: running.map((c) => c.name),
      sync_status: driftReasons.length === 0 ? 'Synced' : 'OutOfSync',
      health_status: 'Healthy',
      drift_reasons: driftReasons,
      synced_commit: m._synced_commit,
      updated_at: m._synced_at,
    };
  });
}
