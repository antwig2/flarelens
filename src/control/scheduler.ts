import type { MeshPeerRecord, NodeRecord } from '../types';
import type { FleetPlacementRecord } from './db';
import {
  type FleetPlacementStrategy,
  type FleetServiceManifest,
  isSingletonManifest,
  normalizeFleetEnv,
} from './fleet';

export interface ClusterEndpoint {
  env: string;
  service: string;
  mode: 'blue_green' | 'singleton';
  node_id: string;
  mesh_ip: string;
  mesh_port: number;
  container_port?: number;
  active_port?: number;
  container_name?: string;
  aliases?: string[];
  domains?: string[];
  health_path?: string;
  healthy: boolean;
}

export interface ScheduleResult {
  placements: FleetPlacementRecord[];
  activeNodeIds: string[];
  evictedNodeIds: string[];
  fenced: boolean;
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Identifies stateful database/storage singletons whose local disk volumes must NEVER
 * be silently wiped or re-provisioned onto an empty node during node crash or drain.
 */
export function isStatefulVolumeManifest(m: FleetServiceManifest): boolean {
  if (!isSingletonManifest(m)) return false;
  const svc = (m.service || '').toLowerCase();
  if (/^(traefik|caddy|nginx|cloudflared|haproxy)(-|$)/.test(svc)) {
    return false;
  }
  if (/postgres|redis|dragonfly|mysql|mariadb|mongo|clickhouse|minio|nats/i.test(svc)) {
    return true;
  }
  if (Array.isArray(m.volumes) && m.volumes.length > 0) {
    const nonSocketVolumes = m.volumes.filter(
      (v) => !v.includes('docker.sock') && !v.includes('/etc/traefik') && !v.endsWith(':ro')
    );
    return nonSocketVolumes.length > 0;
  }
  return false;
}

/**
 * Computes a deterministic WireGuard overlay TCP port for cross-node traffic.
 * - Stateful singletons (e.g. postgres, dragonfly) expose their native container port (5432, 6379, etc.)
 *   on 100.64.0.x:<port> so standard connection strings (`postgres:5432`, `redis:6379`) work unchanged.
 * - Blue/Green stateless services allocate a deterministic mesh port in 20000..39999 so the local
 *   WireGuard forwarder seamlessly tracks active Blue/Green slot flips without reconfiguring remote Traefik peers.
 */
export function computeDeterministicMeshPort(
  envName: string,
  service: string,
  m?: FleetServiceManifest
): number {
  const normEnv = normalizeFleetEnv(envName);
  const svc = (service || '').trim().toLowerCase();

  if (m && isSingletonManifest(m)) {
    if (m.container_port && m.container_port >= 1 && m.container_port <= 65535) {
      return Number(m.container_port);
    }
    if (Array.isArray(m.ports) && m.ports.length > 0) {
      for (const spec of m.ports) {
        const cleaned = String(spec).split('/')[0].trim();
        const parts = cleaned.split(':');
        const candidate = Number(parts[parts.length - 1]);
        if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) {
          return candidate;
        }
      }
    }
    if (svc.includes('postgres')) return 5432;
    if (svc.includes('dragonfly') || svc.includes('redis')) return 6379;
    if (svc.includes('mysql') || svc.includes('mariadb')) return 3306;
    if (svc.includes('mongo')) return 27017;
    if (svc.includes('clickhouse')) return 8123;
    if (svc.includes('nats')) return 4222;
  }

  return 20000 + (fnv1a32(`${normEnv}:${svc}`) % 20000);
}

export function resolveNodeMeshIP(
  nodeId: string,
  nodes: NodeRecord[],
  meshPeers: MeshPeerRecord[]
): string {
  if (!nodeId) return '';
  const peer = meshPeers.find(
    (p) => p.id === nodeId || p.name === nodeId || p.hostname === nodeId
  );
  if (peer) {
    return (peer.overlay_ip || peer.tailscale_ip || '').trim();
  }
  const node = nodes.find((n) => n.node_id === nodeId || n.hostname === nodeId);
  if (node?.mesh?.tailscale_ip) {
    // Avoid returning synthetic single-node placeholder '100.64.0.1' across distinct nodes in multi-node clusters
    if (nodes.length <= 1 || node.mesh.tailscale_ip !== '100.64.0.1') {
      return node.mesh.tailscale_ip.trim();
    }
  }
  return '';
}

export function isNodeSchedulable(
  node: NodeRecord,
  nowMs: number = Date.now(),
  totalNodeCount: number = 1
): boolean {
  if (!node || !node.node_id) return false;
  if (node.status === 'dead' || node.status === 'Unhealthy' || node.status === 'Draining') {
    return false;
  }
  if (node.schedulable === false) {
    return false;
  }

  const lastHbRaw = Number(node.last_heartbeat || 0);
  const lastHbMs =
    lastHbRaw > 0 ? (lastHbRaw < 10_000_000_000 ? lastHbRaw * 1000 : lastHbRaw) : 0;
  const enrolledMs = node.enrolled_at ? Date.parse(node.enrolled_at) : 0;
  const effectiveLastSeen =
    lastHbMs > 0 ? lastHbMs : Number.isFinite(enrolledMs) ? enrolledMs : 0;

  // In multi-node pools, require a fresh heartbeat within 120s; in single-node setups allow fallback
  if (totalNodeCount > 1 && effectiveLastSeen > 0 && nowMs - effectiveLastSeen > 120_000) {
    return false;
  }
  return true;
}

function nodeMatchesRequiredTags(node: NodeRecord, requiredTags?: string[]): boolean {
  if (!Array.isArray(requiredTags) || requiredTags.length === 0) return true;
  const nodeTags = new Set((node.tags || []).map((t) => String(t).trim().toLowerCase()));
  return requiredTags.every((req) => nodeTags.has(String(req).trim().toLowerCase()));
}

/**
 * Deterministically schedules desired replicas of a FleetServiceManifest across enrolled nodes:
 * - Enforces stateful volume fencing when a persistent DB's host node is dead or cordoned/draining
 * - Preserves existing healthy replica placements first (zero-churn stickiness)
 * - Accounts for cluster-wide RAM reservations (`memory_mb`)
 * - Supports `spread` (anti-affinity + most free RAM), `binpack` (Best-Fit smallest sufficient RAM), and `pinned`
 */
export function scheduleManifestPlacements(params: {
  manifest: FleetServiceManifest;
  desiredImage: string;
  nodes: NodeRecord[];
  meshPeers: MeshPeerRecord[];
  existingServicePlacements: FleetPlacementRecord[];
  otherClusterPlacements: FleetPlacementRecord[];
  forceRelocateStateful?: boolean;
  nowMs?: number;
}): ScheduleResult {
  const {
    manifest: m,
    desiredImage,
    nodes,
    meshPeers,
    existingServicePlacements,
    otherClusterPlacements,
    forceRelocateStateful = false,
    nowMs = Date.now(),
  } = params;

  const normEnv = normalizeFleetEnv(m.env);
  const mode: 'blue_green' | 'singleton' = isSingletonManifest(m) ? 'singleton' : 'blue_green';
  const stateful = isStatefulVolumeManifest(m);
  const defaultMem = stateful ? 512 : 256;
  const memoryMb = Math.max(32, Number(m.memory_mb || defaultMem));
  const meshPort = computeDeterministicMeshPort(normEnv, m.service, m);
  const nowIso = new Date(nowMs).toISOString();

  const explicitTarget =
    m.node_id && !['auto', 'smart', 'all', 'all-prod'].includes(m.node_id)
      ? m.node_id.trim()
      : '';

  const strategy: FleetPlacementStrategy =
    m.placement_strategy || (explicitTarget ? 'pinned' : 'spread');

  const prevPlacedNodes = existingServicePlacements
    .filter((p) => p.node_id && p.status !== 'unscheduled')
    .map((p) => p.node_id);

  // 1. Daemonset-style broadcast ('all' or 'all-prod')
  if (m.node_id === 'all' || m.node_id === 'all-prod') {
    const eligible = nodes
      .filter((n) => isNodeSchedulable(n, nowMs, nodes.length))
      .filter((n) =>
        m.node_id === 'all-prod'
          ? !n.node_id.toLowerCase().includes('wsl') && !n.node_id.toLowerCase().includes('test')
          : true
      )
      .filter((n) => nodeMatchesRequiredTags(n, m.required_tags));

    const targetList = eligible.length > 0 ? eligible.map((n) => n.node_id) : nodes[0] ? [nodes[0].node_id] : [];
    const placements: FleetPlacementRecord[] = targetList.map((nodeId, idx) => {
      const prev = existingServicePlacements.find((p) => p.node_id === nodeId);
      return {
        placement_id: `${normEnv}:${m.service.toLowerCase()}:${idx}`,
        env: normEnv,
        service: m.service,
        replica_index: idx,
        node_id: nodeId,
        mode,
        strategy: 'spread',
        memory_mb: memoryMb,
        mesh_ip: resolveNodeMeshIP(nodeId, nodes, meshPeers),
        mesh_port: meshPort,
        active_port: prev?.active_port || 0,
        desired_image: desiredImage,
        status: 'placed',
        reason: `Broadcast placement (${m.node_id})`,
        updated_at: nowIso,
      };
    });
    const evictedNodeIds = prevPlacedNodes.filter((nid) => !targetList.includes(nid));
    return { placements, activeNodeIds: targetList, evictedNodeIds, fenced: false };
  }

  // 2. Stateful Volume Fencing Guard:
  // Never auto-relocate a stateful DB with persistent local volumes onto an empty node's disk!
  const statefulAnchorNode = explicitTarget || prevPlacedNodes[0] || '';
  if (stateful && statefulAnchorNode && !forceRelocateStateful) {
    const anchorRecord = nodes.find(
      (n) => n.node_id === statefulAnchorNode || n.hostname === statefulAnchorNode
    );
    const anchorHealthy = anchorRecord
      ? isNodeSchedulable(anchorRecord, nowMs, nodes.length)
      : false;

    if (!anchorHealthy) {
      const prev = existingServicePlacements.find((p) => p.node_id === statefulAnchorNode);
      const stateLabel =
        anchorRecord?.schedulable === false || anchorRecord?.status === 'Draining'
          ? 'cordoned/draining'
          : anchorRecord?.status || 'offline';
      const fencedPlacement: FleetPlacementRecord = {
        placement_id: `${normEnv}:${m.service.toLowerCase()}:0`,
        env: normEnv,
        service: m.service,
        replica_index: 0,
        node_id: statefulAnchorNode,
        mode,
        strategy: 'pinned',
        memory_mb: memoryMb,
        mesh_ip: prev?.mesh_ip || resolveNodeMeshIP(statefulAnchorNode, nodes, meshPeers),
        mesh_port: meshPort,
        active_port: prev?.active_port || 0,
        desired_image: desiredImage,
        status: 'fenced',
        reason: `Stateful volume fenced on ${statefulAnchorNode} (${stateLabel}) — automatic migration blocked to prevent empty-volume data loss`,
        updated_at: nowIso,
      };
      return {
        placements: [fencedPlacement],
        activeNodeIds: [],
        evictedNodeIds: [],
        fenced: true,
      };
    }
  }

  const desiredReplicas = mode === 'singleton' ? 1 : Math.max(1, Number(m.replicas || 1));

  // 3. Explicit node pin (when node is healthy & schedulable, or stateless fallback when pinned)
  if (explicitTarget && (strategy === 'pinned' || mode === 'singleton' || desiredReplicas === 1)) {
    const pinnedNode = nodes.find(
      (n) => n.node_id === explicitTarget || n.hostname === explicitTarget
    );
    if (!pinnedNode || isNodeSchedulable(pinnedNode, nowMs, nodes.length)) {
      const resolvedId = pinnedNode?.node_id || explicitTarget;
      const prev = existingServicePlacements.find((p) => p.node_id === resolvedId);
      const placement: FleetPlacementRecord = {
        placement_id: `${normEnv}:${m.service.toLowerCase()}:0`,
        env: normEnv,
        service: m.service,
        replica_index: 0,
        node_id: resolvedId,
        mode,
        strategy: 'pinned',
        memory_mb: memoryMb,
        mesh_ip: resolveNodeMeshIP(resolvedId, nodes, meshPeers),
        mesh_port: meshPort,
        active_port: prev?.active_port || 0,
        desired_image: desiredImage,
        status: 'placed',
        reason: `Pinned to node ${resolvedId}`,
        updated_at: nowIso,
      };
      const evictedNodeIds = prevPlacedNodes.filter((nid) => nid !== resolvedId);
      return {
        placements: [placement],
        activeNodeIds: [resolvedId],
        evictedNodeIds,
        fenced: false,
      };
    }
    // If explicitly pinned stateless workload's node is dead/draining AND strategy === 'pinned' strictly:
    if (m.placement_strategy === 'pinned') {
      const placement: FleetPlacementRecord = {
        placement_id: `${normEnv}:${m.service.toLowerCase()}:0`,
        env: normEnv,
        service: m.service,
        replica_index: 0,
        node_id: '',
        mode,
        strategy: 'pinned',
        memory_mb: memoryMb,
        mesh_ip: '',
        mesh_port: meshPort,
        active_port: 0,
        desired_image: desiredImage,
        status: 'unscheduled',
        reason: `Pinned target node ${explicitTarget} is ${pinnedNode.status || 'unavailable'}`,
        updated_at: nowIso,
      };
      return {
        placements: [placement],
        activeNodeIds: [],
        evictedNodeIds: prevPlacedNodes,
        fenced: false,
      };
    }
    // Otherwise (stateless service had soft node_id without strict strategy:'pinned'), allow automatic failover to healthy nodes!
  }

  // 4. Filter eligible candidate pool
  const schedulableNodes = nodes
    .filter((n) => isNodeSchedulable(n, nowMs, nodes.length))
    .filter((n) => nodeMatchesRequiredTags(n, m.required_tags));

  const nonTestCandidates = schedulableNodes.filter(
    (n) => !n.node_id.toLowerCase().includes('wsl') && !n.node_id.toLowerCase().includes('test')
  );
  const candidatePool =
    nonTestCandidates.length >= desiredReplicas
      ? nonTestCandidates
      : schedulableNodes;

  // Build RAM reservation ledger across all OTHER services in the cluster
  const reservedMbByNode = new Map<string, number>();
  for (const p of otherClusterPlacements) {
    if (p.node_id && p.status === 'placed') {
      reservedMbByNode.set(
        p.node_id,
        (reservedMbByNode.get(p.node_id) || 0) + Math.max(0, Number(p.memory_mb || 256))
      );
    }
  }

  const chosenNodeIds: string[] = [];

  // 5. Sticky Retention: keep already-placed replicas on healthy, eligible nodes first (zero unnecessary churn)
  for (const prev of existingServicePlacements) {
    if (chosenNodeIds.length >= desiredReplicas) break;
    if (!prev.node_id || prev.status !== 'placed') continue;
    if (chosenNodeIds.includes(prev.node_id)) continue;
    if (candidatePool.some((c) => c.node_id === prev.node_id)) {
      chosenNodeIds.push(prev.node_id);
      reservedMbByNode.set(
        prev.node_id,
        (reservedMbByNode.get(prev.node_id) || 0) + memoryMb
      );
    }
  }

  // 6. Score remaining eligible nodes for additional replicas
  const requiredBytes = memoryMb * 1024 * 1024;
  while (chosenNodeIds.length < desiredReplicas) {
    const remainingNodes = candidatePool.filter((n) => !chosenNodeIds.includes(n.node_id));
    if (remainingNodes.length === 0) {
      break;
    }

    const scored = remainingNodes.map((node) => {
      const totalBytes =
        node.latest_telemetry?.metrics?.ram_total_bytes ||
        node.specs?.ram_total_bytes ||
        4 * 1024 * 1024 * 1024;
      const telemetryUsedBytes = node.latest_telemetry?.metrics?.ram_used_bytes || 0;
      const reservedBytes = (reservedMbByNode.get(node.node_id) || 0) * 1024 * 1024;
      const effectiveUsedBytes = Math.max(telemetryUsedBytes, reservedBytes);
      const freeBytes = Math.max(0, totalBytes - effectiveUsedBytes);
      const capable = freeBytes >= requiredBytes;
      const cpuUsage = node.latest_telemetry?.metrics?.cpu_usage_pct || 0;

      return {
        node_id: node.node_id,
        freeBytes,
        capable,
        cpuUsage,
      };
    });

    scored.sort((a, b) => {
      // Capable nodes (enough free RAM) always beat overcommitted nodes
      if (a.capable !== b.capable) {
        return a.capable ? -1 : 1;
      }
      if (strategy === 'binpack' && a.capable && b.capable) {
        // Best-Fit Bin-Packing: pack onto the node with the SMALLEST sufficient free RAM
        const diff = a.freeBytes - b.freeBytes;
        if (Math.abs(diff) > 64 * 1024 * 1024) return diff;
        return a.cpuUsage - b.cpuUsage || a.node_id.localeCompare(b.node_id);
      }
      // Default 'spread' (or overcommitted fallback): choose node with MOST free RAM, then lowest CPU
      const diff = b.freeBytes - a.freeBytes;
      if (Math.abs(diff) > 64 * 1024 * 1024) return diff;
      return a.cpuUsage - b.cpuUsage || a.node_id.localeCompare(b.node_id);
    });

    const winner = scored[0].node_id;
    chosenNodeIds.push(winner);
    reservedMbByNode.set(winner, (reservedMbByNode.get(winner) || 0) + memoryMb);
  }

  // Fallback when zero nodes are enrolled yet (e.g. fresh bootstrap before first agent enrolls)
  if (chosenNodeIds.length === 0 && nodes.length === 0 && explicitTarget) {
    chosenNodeIds.push(explicitTarget);
  }

  const placements: FleetPlacementRecord[] = [];
  for (let idx = 0; idx < desiredReplicas; idx++) {
    const assignedNode = chosenNodeIds[idx] || '';
    if (assignedNode) {
      const prev = existingServicePlacements.find((p) => p.node_id === assignedNode);
      const wasRetained = prevPlacedNodes.includes(assignedNode);
      placements.push({
        placement_id: `${normEnv}:${m.service.toLowerCase()}:${idx}`,
        env: normEnv,
        service: m.service,
        replica_index: idx,
        node_id: assignedNode,
        mode,
        strategy,
        memory_mb: memoryMb,
        mesh_ip: resolveNodeMeshIP(assignedNode, nodes, meshPeers),
        mesh_port: meshPort,
        active_port: prev?.active_port || 0,
        desired_image: desiredImage,
        status: 'placed',
        reason: wasRetained
          ? `Retained healthy replica on ${assignedNode} (${strategy})`
          : `Scheduled via ${strategy} (${memoryMb} MB reserved)`,
        updated_at: nowIso,
      });
    } else {
      placements.push({
        placement_id: `${normEnv}:${m.service.toLowerCase()}:${idx}`,
        env: normEnv,
        service: m.service,
        replica_index: idx,
        node_id: '',
        mode,
        strategy,
        memory_mb: memoryMb,
        mesh_ip: '',
        mesh_port: meshPort,
        active_port: 0,
        desired_image: desiredImage,
        status: 'unscheduled',
        reason:
          candidatePool.length === 0
            ? 'No healthy schedulable nodes match placement constraints'
            : `Insufficient distinct eligible nodes (${candidatePool.length} available for ${desiredReplicas} replicas)`,
        updated_at: nowIso,
      });
    }
  }

  const evictedNodeIds = prevPlacedNodes.filter((nid) => !chosenNodeIds.includes(nid));
  return {
    placements,
    activeNodeIds: chosenNodeIds,
    evictedNodeIds,
    fenced: false,
  };
}

/**
 * Builds the WireGuard mesh ClusterEndpoint list distributed to every node on its 15s heartbeat.
 */
export function buildClusterEndpoints(params: {
  manifests: FleetServiceManifest[];
  placements: FleetPlacementRecord[];
  nodes: NodeRecord[];
  meshPeers: MeshPeerRecord[];
}): ClusterEndpoint[] {
  const { manifests, placements, nodes, meshPeers } = params;
  const manifestMap = new Map<string, FleetServiceManifest>();
  for (const m of manifests) {
    const key = `${normalizeFleetEnv(m.env)}:${m.service.toLowerCase()}`;
    manifestMap.set(key, m);
  }
  const nodeMap = new Map<string, NodeRecord>(nodes.map((n) => [n.node_id, n]));

  const endpoints: ClusterEndpoint[] = [];
  for (const p of placements) {
    if (!p.node_id || p.status !== 'placed') continue;
    const normEnv = normalizeFleetEnv(p.env);
    const key = `${normEnv}:${p.service.toLowerCase()}`;
    const m = manifestMap.get(key);
    if (m && m.enabled === false) continue;

    const node = nodeMap.get(p.node_id);
    if (node && node.status === 'dead') continue;

    const meshIp = p.mesh_ip || resolveNodeMeshIP(p.node_id, nodes, meshPeers);
    const meshPort = p.mesh_port || computeDeterministicMeshPort(normEnv, p.service, m);
    if (!meshIp || meshPort <= 0) continue;

    const domains: string[] = [];
    if (m?.domain && m.domain.trim()) domains.push(m.domain.trim());
    if (Array.isArray(m?.domains)) {
      for (const d of m!.domains) {
        if (d && d.trim() && !domains.includes(d.trim())) domains.push(d.trim());
      }
    }

    endpoints.push({
      env: normEnv,
      service: p.service.toLowerCase(),
      mode: p.mode,
      node_id: p.node_id,
      mesh_ip: meshIp,
      mesh_port: meshPort,
      ...(m?.container_port ? { container_port: m.container_port } : {}),
      ...(p.active_port ? { active_port: p.active_port } : {}),
      ...(m?.container_name ? { container_name: m.container_name } : {}),
      ...(Array.isArray(m?.aliases) && m!.aliases.length > 0 ? { aliases: m!.aliases } : {}),
      ...(domains.length > 0 ? { domains } : {}),
      ...(m?.health_path ? { health_path: m.health_path } : {}),
      healthy: !node || (node.status !== 'dead' && node.status !== 'Unhealthy'),
    });
  }
  return endpoints;
}

/**
 * Computes Docker ExtraHosts (`host:100.64.0.x`) for remote services in `envName` + `infra`
 * so newly deployed containers immediately resolve cross-node databases/caches even before the next heartbeat.
 */
export function computeExtraHostsForNode(
  nodeId: string,
  envName: string,
  endpoints: ClusterEndpoint[]
): string[] {
  const normEnv = normalizeFleetEnv(envName);
  const localServices = new Set<string>();
  for (const ep of endpoints) {
    if (ep.node_id === nodeId && (ep.env === normEnv || ep.env === 'infra')) {
      localServices.add(ep.service.toLowerCase());
    }
  }

  const hostToIp = new Map<string, string>();
  const validHostRe = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

  for (const ep of endpoints) {
    if (!ep.healthy) continue;
    if (ep.env !== normEnv && ep.env !== 'infra') continue;
    if (ep.node_id === nodeId || localServices.has(ep.service.toLowerCase())) continue;
    if (!ep.mesh_ip) continue;

    const candidates: string[] = [ep.service, `${ep.service}-${ep.env}`];
    if (ep.service === 'dragonfly') {
      candidates.push('redis', `redis-${ep.env}`);
    }
    if (ep.container_name) candidates.push(ep.container_name);
    if (Array.isArray(ep.aliases)) candidates.push(...ep.aliases);

    for (const raw of candidates) {
      const h = String(raw || '').trim().toLowerCase();
      if (!h || h === 'localhost' || !validHostRe.test(h)) continue;
      if (!hostToIp.has(h)) {
        hostToIp.set(h, ep.mesh_ip);
      }
    }
  }

  return Array.from(hostToIp.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([h, ip]) => `${h}:${ip}`);
}

/**
 * Computes remote WireGuard HTTP upstream URLs (`http://100.64.0.x:<mesh_port>`) for multi-replica Traefik load balancing.
 */
export function computeRemoteUpstreamsForNode(
  nodeId: string,
  envName: string,
  service: string,
  endpoints: ClusterEndpoint[]
): string[] {
  const normEnv = normalizeFleetEnv(envName);
  const cleanSvc = service.trim().toLowerCase();
  const urls = new Set<string>();

  for (const ep of endpoints) {
    if (!ep.healthy) continue;
    if (ep.env !== normEnv || ep.service !== cleanSvc) continue;
    if (ep.node_id === nodeId) continue;
    const port = ep.mesh_port || ep.active_port || 0;
    if (!ep.mesh_ip || port <= 0) continue;
    urls.add(`http://${ep.mesh_ip}:${port}`);
  }

  return Array.from(urls).sort();
}
