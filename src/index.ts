import {
  LogRecord,
  Env,
  NodeRegistrationPayload,
  NodeTelemetryHeartbeat,
  NodeRecord,
  DeployRequestPayload,
  DeploymentRecord,
  PreviewTeardownPayload,
  BackupRecord,
  BackupRequestPayload,
  RestoreRequestPayload,
  EncryptedVaultPayload,
  VaultMetadata,
  MeshPeerRecord,
  MeshRegisterPayload,
  MeshCreateClientPayload,
  PreAuthKeyRecord,
} from './types';
import { processAlerts } from './alerts';
import { encryptSecrets, decryptSecrets, parseEnvContent, getVaultLookupKeys, resolveVaultSecrets } from './control/vault';
import { verifyGitHubSignature, parseDeployWebhook, reportGitHubStatus, resolveWebhookDeployPayload, getServiceDeclarativeDefaults } from './control/webhook';
import { isGitHubOidcToken, verifyGitHubOidcToken } from './control/github_oidc';
import {
  MESH_SUBNET,
  COORDINATOR_URL,
  MAGIC_DNS_SUFFIX,
  DERP_REGIONS,
  allocateMeshIP,
  generatePreAuthKey,
  buildAgentConnectCommand,
  buildTailscaleConnectCommand,
  buildMikroTikConfig,
  generateWireGuardKeypair,
  buildWireGuardClientConfig,
} from './control/mesh';
import {
  handleDeviceCode,
  handleDeviceToken,
  handleDeviceApprovePage,
  handleDeviceApproveAction,
  handleGetAccessPolicy,
  handleSaveAccessPolicy,
} from './control/device_auth';
import {
  handleGetIngressRoutes,
  handleProbeIngressRoute,
} from './control/ingress';
import { parquetWriteBuffer } from 'hyparquet-writer';

// In-memory ring buffer (up to 1,500 logs) for instant live tail loading
const RING_BUFFER_MAX = 1500;
const ringBuffer: LogRecord[] = [];

// In-memory buffer for 1-minute Parquet compaction
let parquetLogCompactorBuffer: LogRecord[] = [];
let lastParquetFlushTime = Date.now();
const PARQUET_BATCH_MAX_RECORDS = 2000;
const PARQUET_FLUSH_INTERVAL_MS = 60 * 1000; // 1 minute

// Active SSE client writers for real-time live streaming
const sseClients = new Set<WritableStreamDefaultWriter<Uint8Array>>();

// In-memory cache for registered fleet nodes, deployments, backups, mesh peers & active WebSocket subscribers
const fleetNodes = new Map<string, NodeRecord>();
const fleetDeployments = new Map<string, DeploymentRecord>();
const fleetBackups = new Map<string, BackupRecord>();
const fleetMeshPeers = new Map<string, MeshPeerRecord>();
const telemetryWsClients = new Set<WebSocket>();
const inMemoryCommands = new Map<string, any[]>();

/**
 * Resilient KV Put wrapper: Prevents daily KV write exhaustion (Cloudflare 1,000 writes/day free limit)
 * from crashing endpoints or blocking deployments, backups, and live commands.
 */
async function safeKvPut(kv: KVNamespace | undefined, key: string, value: string, options?: any): Promise<boolean> {
  if (!kv) return false;
  try {
    if (options) {
      await kv.put(key, value, options);
    } else {
      await kv.put(key, value);
    }
    return true;
  } catch (err: any) {
    console.warn(`[FlareLens KV] Ignored KV write limit / failure for "${key}": ${err?.message || err}`);
    return false;
  }
}

const textEncoder = new TextEncoder();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Content-Type, Range, Authorization, x-tenant-id, x-environment-id, x-entity-id, x-correlation-id, x-request-id, x-trace-id, X-API-Key, Idempotency-Key',
          'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, x-request-id, x-correlation-id, x-trace-id, x-tenant-id, x-environment-id',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 0a. Linux 30s Bootstrap Installer (GET/HEAD /install.sh)
    if (url.pathname === '/install.sh' && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleInstallScript(request, env, 'sh');
    }

    // 0b. Windows 1-Line PowerShell Installer (GET/HEAD /install.ps1)
    if (url.pathname === '/install.ps1' && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleInstallScript(request, env, 'ps1');
    }

    // 0c. Binary Distribution Endpoint (GET/HEAD /api/v1/agent/binary/:target or /bin/:target)
    if ((url.pathname.startsWith('/api/v1/agent/binary/') || url.pathname.startsWith('/bin/')) && (request.method === 'GET' || request.method === 'HEAD')) {
      const target = url.pathname
        .replace('/api/v1/agent/binary/', '')
        .replace('/bin/flarelens-agent-', '')
        .replace('/bin/', '')
        .trim();
      return handleAgentBinary(target, env);
    }

    // 1. Ingestion: POST /api/v1/ingest (Protected by INGEST_SECRET), GET/HEAD for healthcheck
    if (url.pathname === '/api/v1/ingest') {
      if (request.method === 'GET' || request.method === 'HEAD') {
        return new Response(JSON.stringify({ status: 'ok', service: 'flarelens-ingest' }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      if (request.method === 'POST') {
        const authErr = validateIngestAuth(request, env, url);
        if (authErr) return authErr;
        return handleIngest(request, env, ctx);
      }
    }

    // 2. Control Plane: Node Enrollment (POST /api/v1/control/enroll)
    if (url.pathname === '/api/v1/control/enroll' && request.method === 'POST') {
      const authErr = validateEnrollAuth(request, env, url);
      if (authErr) return authErr;
      return handleEnroll(request, env, ctx);
    }

    // 3. Control Plane: Real-Time Telemetry WebSocket (GET /api/v1/control/ws or /api/v1/ws/telemetry)
    if ((url.pathname === '/api/v1/control/ws' || url.pathname === '/api/v1/ws/telemetry') && request.method === 'GET') {
      return handleControlWebSocket(request, env);
    }

    // 3b. GitOps Deployments: Automated CI/CD & GitHub Webhook (POST /api/v1/control/deploy/webhook)
    if (url.pathname === '/api/v1/control/deploy/webhook' && request.method === 'POST') {
      return handleDeployWebhook(request, env, ctx);
    }

    // 3c. OAuth2 Device Flow Initiation & Polling (Public for flarelens-agent)
    if (url.pathname === '/api/v1/auth/device/code' && request.method === 'POST') {
      return handleDeviceCode(request, env, ctx);
    }
    if (url.pathname === '/api/v1/auth/device/token' && request.method === 'POST') {
      return handleDeviceToken(request, env);
    }

    // 4. Dashboard & Query APIs (Protected by Cloudflare Access or DASHBOARD_PASSWORD)
    const dashAuthErr = validateDashboardAuth(request, env);
    if (dashAuthErr) return dashAuthErr;

    // 4a. OAuth2 Device Flow Approval (Protected by Cloudflare Access)
    if (url.pathname === '/auth/device' && request.method === 'GET') {
      return handleDeviceApprovePage(request, env);
    }
    if (url.pathname === '/api/v1/auth/device/approve' && request.method === 'POST') {
      return handleDeviceApproveAction(request, env, ctx, loadAllMeshPeers);
    }

    // 4b. Authenticated Identity Information (Cloudflare Access / Session info)
    if (url.pathname === '/api/v1/auth/me' && request.method === 'GET') {
      const cfEmail = request.headers.get('cf-access-authenticated-user-email');
      const cfJwt = request.headers.get('cf-access-jwt-assertion');
      const cfClientId = request.headers.get('cf-access-client-id');

      return new Response(JSON.stringify({
        authenticated: true,
        email: cfEmail || (env.DASHBOARD_USERNAME || 'admin'),
        provider: cfEmail ? 'cloudflare_access' : (env.DASHBOARD_PASSWORD ? 'basic_auth' : 'open'),
        is_cloudflare_access: !!cfEmail,
        has_jwt: !!cfJwt,
        service_token_id: cfClientId || null,
        timestamp: new Date().toISOString(),
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // 5. Fleet Nodes Query APIs: GET /api/v1/control/nodes, GET /api/v1/control/nodes/:id
    if (url.pathname === '/api/v1/control/nodes' && request.method === 'GET') {
      return handleListNodes(env);
    }
    if (url.pathname.startsWith('/api/v1/control/nodes/') && request.method === 'GET') {
      const nodeId = url.pathname.replace('/api/v1/control/nodes/', '').trim();
      if (nodeId) {
        return handleGetNode(nodeId, env);
      }
    }

    // 6. GitOps Deployments: Trigger Blue/Green Deployment (POST /api/v1/control/deploy)
    if (url.pathname === '/api/v1/control/deploy' && request.method === 'POST') {
      return handleTriggerDeploy(request, env, ctx);
    }

    // 6c. Ephemeral PR Preview: Teardown preview environment (POST /api/v1/control/preview/teardown)
    if (url.pathname === '/api/v1/control/preview/teardown' && request.method === 'POST') {
      return handleTriggerPreviewTeardown(request, env, ctx);
    }

    // 6d. Ephemeral PR Preview: List active previews (GET /api/v1/control/previews)
    if (url.pathname === '/api/v1/control/previews' && request.method === 'GET') {
      return handleListPreviews(env);
    }

    // 7. GitOps Deployments: List historical deployments (GET /api/v1/control/deployments)
    if (url.pathname === '/api/v1/control/deployments' && request.method === 'GET') {
      return handleListDeployments(env);
    }

    // 7b. Active Fleet Services: List all services, active slots, containers & health (GET /api/v1/control/services)
    if (url.pathname === '/api/v1/control/services' && request.method === 'GET') {
      return handleListServices(env);
    }

    // 8. GitOps Deployments: Update deployment status callback (POST /api/v1/control/deploy/status)
    if (url.pathname === '/api/v1/control/deploy/status' && request.method === 'POST') {
      return handleUpdateDeployStatus(request, env, ctx);
    }

    // 9. Database Backups: List Cloudflare R2 snapshots (GET /api/v1/control/backups)
    if (url.pathname === '/api/v1/control/backups' && request.method === 'GET') {
      return handleListBackups(request, env);
    }

    // 10. Database Backups: Trigger on-demand backup (POST /api/v1/control/backup)
    if (url.pathname === '/api/v1/control/backup' && request.method === 'POST') {
      return handleTriggerBackup(request, env, ctx);
    }

    // 11. Database Backups: Trigger restore (POST /api/v1/control/backup/restore)
    if (url.pathname === '/api/v1/control/backup/restore' && request.method === 'POST') {
      return handleTriggerRestore(request, env, ctx);
    }

    // 12. Database Backups: Update backup status callback (POST /api/v1/control/backup/status)
    if (url.pathname === '/api/v1/control/backup/status' && request.method === 'POST') {
      return handleUpdateBackupStatus(request, env, ctx);
    }

    // 12b. Node Command Queue: Poll pending commands (GET /api/v1/control/commands)
    if (url.pathname === '/api/v1/control/commands' && request.method === 'GET') {
      return handleGetNodeCommands(request, env);
    }

    // 12c. Node Command Queue: Acknowledge completed command (POST /api/v1/control/commands/ack)
    if (url.pathname === '/api/v1/control/commands/ack' && request.method === 'POST') {
      return handleAckNodeCommand(request, env);
    }

    // 13. Secrets Vault: List registered services (GET /api/v1/control/secrets)
    if (url.pathname === '/api/v1/control/secrets' && request.method === 'GET') {
      return handleListVaultSecrets(env);
    }

    // 14. Secrets Vault: Fetch decrypted secrets for service (GET /api/v1/control/secrets/:service)
    if (url.pathname.startsWith('/api/v1/control/secrets/') && !url.pathname.includes('/import-env') && request.method === 'GET') {
      const service = url.pathname.replace('/api/v1/control/secrets/', '').trim();
      const envQuery = url.searchParams.get('env') || undefined;
      if (service) return handleGetVaultSecrets(service, env, envQuery);
    }

    // 15. Secrets Vault: Store encrypted secrets (POST /api/v1/control/secrets)
    if (url.pathname === '/api/v1/control/secrets' && request.method === 'POST') {
      return handleSaveVaultSecrets(request, env, ctx);
    }

    // 16. Secrets Vault: Import raw .env file (POST /api/v1/control/secrets/import-env)
    if (url.pathname === '/api/v1/control/secrets/import-env' && request.method === 'POST') {
      return handleImportEnvSecrets(request, env, ctx);
    }

    // 17. Secrets Vault: Delete secrets for service (DELETE /api/v1/control/secrets/:service)
    if (url.pathname.startsWith('/api/v1/control/secrets/') && request.method === 'DELETE') {
      const service = url.pathname.replace('/api/v1/control/secrets/', '').trim();
      if (service) return handleDeleteVaultSecrets(service, env, ctx);
    }

    // 22. Zero-Trust Sovereign Mesh: Get Mesh & Coordinator Status (GET /api/v1/control/mesh/status)
    if (url.pathname === '/api/v1/control/mesh/status' && request.method === 'GET') {
      return handleMeshGetStatus(env);
    }

    // 22b. Zero-Trust Sovereign Mesh: Register node peer (POST /api/v1/control/mesh/register)
    if (url.pathname === '/api/v1/control/mesh/register' && request.method === 'POST') {
      return handleMeshRegister(request, env, ctx);
    }

    // 23. Zero-Trust Sovereign Mesh: List all mesh peers (GET /api/v1/control/mesh/peers)
    if (url.pathname === '/api/v1/control/mesh/peers' && request.method === 'GET') {
      return handleMeshListPeers(env);
    }

    // 23b. Zero-Trust Sovereign Mesh: Generate Tailscale Pre-Auth Key (POST /api/v1/control/mesh/preauth-key)
    if (url.pathname === '/api/v1/control/mesh/preauth-key' && request.method === 'POST') {
      return handleMeshCreatePreAuthKey(request, env, ctx);
    }

    // 24. Zero-Trust Sovereign Mesh: Enroll client device (POST /api/v1/control/mesh/client)
    if (url.pathname === '/api/v1/control/mesh/client' && request.method === 'POST') {
      return handleMeshCreateClient(request, env, ctx);
    }

    // 25. Zero-Trust Sovereign Mesh: Download fallback client .conf (GET /api/v1/control/mesh/client/:id/config)
    if (url.pathname.startsWith('/api/v1/control/mesh/client/') && url.pathname.endsWith('/config') && request.method === 'GET') {
      const clientId = url.pathname.replace('/api/v1/control/mesh/client/', '').replace('/config', '').trim();
      return handleMeshGetClientConfig(clientId, env);
    }

    // 26. Zero-Trust Sovereign Mesh: Deregister/delete peer (DELETE /api/v1/control/mesh/peer/:id)
    if (url.pathname.startsWith('/api/v1/control/mesh/peer/') && request.method === 'DELETE') {
      const peerId = url.pathname.replace('/api/v1/control/mesh/peer/', '').trim();
      return handleMeshDeletePeer(peerId, env, ctx);
    }

    // 26b. Zero-Trust Sovereign Mesh: Get/Set Access & OIDC Policy (GET/POST /api/v1/control/mesh/access-policy)
    if (url.pathname === '/api/v1/control/mesh/access-policy') {
      if (request.method === 'GET') {
        return handleGetAccessPolicy(env);
      }
      if (request.method === 'POST') {
        return handleSaveAccessPolicy(request, env, ctx);
      }
    }

    // 32. Ingress Route Mapping: List all public edge & private mesh ingress routes (GET /api/v1/control/ingress/routes)
    if (url.pathname === '/api/v1/control/ingress/routes' && request.method === 'GET') {
      return handleGetIngressRoutes(env);
    }

    // 32b. Ingress Route Mapping: Live probe test route (POST /api/v1/control/ingress/probe)
    if (url.pathname === '/api/v1/control/ingress/probe' && request.method === 'POST') {
      return handleProbeIngressRoute(request, env);
    }

    // 9. Real-time Live Stream: GET /api/v1/live/sse
    if (url.pathname === '/api/v1/live/sse' && request.method === 'GET') {
      return handleLiveSSE();
    }

    // 3. In-memory / Recent logs: GET /api/v1/logs/recent
    if (url.pathname === '/api/v1/logs/recent' && request.method === 'GET') {
      return handleRecentLogs(env);
    }

    // 4. Byte-range proxy to Cloudflare R2: GET/HEAD/OPTIONS /api/v1/parquet/range
    if (url.pathname === '/api/v1/parquet/range' && (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS')) {
      return handleParquetRange(request, env);
    }

    // 5. List historical Parquet/Log files: GET /api/v1/files
    if (url.pathname === '/api/v1/files' && request.method === 'GET') {
      return handleListFiles(request, env);
    }

    // 6. Web Dashboard UI
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (env.ASSETS) {
        const assetResp = await env.ASSETS.fetch(request);
        const headers = new Headers(assetResp.headers);
        headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        headers.set('Pragma', 'no-cache');
        headers.set('Expires', '0');
        return new Response(assetResp.body, {
          status: assetResp.status,
          statusText: assetResp.statusText,
          headers,
        });
      }
    }

    // Fallback to static assets fetcher if configured
    if (env.ASSETS) {
      const assetResp = await env.ASSETS.fetch(request);
      if (assetResp.status !== 404) {
        const headers = new Headers(assetResp.headers);
        headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        return new Response(assetResp.body, {
          status: assetResp.status,
          statusText: assetResp.statusText,
          headers,
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  },

  /**
   * Automated 1-minute Uptime / Synthetic Health Check & 1-minute Parquet Compaction (Runs via Cloudflare Cron Trigger)
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // 1. Flush any pending 1-minute Parquet batch to Cloudflare R2
    if (parquetLogCompactorBuffer.length > 0) {
      const logsToFlush = [...parquetLogCompactorBuffer];
      parquetLogCompactorBuffer = [];
      lastParquetFlushTime = Date.now();
      ctx.waitUntil(flushToR2(logsToFlush, env, new Date()));
    }

    // 2. Automated 1-minute Uptime / Synthetic Health Check
    ctx.waitUntil(handleUptimeChecks(env));

    // 3. Automated Failover & Self-Healing for Dead / Unresponsive Fleet Nodes
    ctx.waitUntil(handleNodeCrashFailover(env, ctx));
  },

  /**
   * Cloudflare Queues Consumer: Processes background deployment jobs & telemetry with retries
   */
  async queue(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleQueueBatch(batch, env, ctx);
  },
};

/**
 * Cloudflare Queues Consumer Batch Handler
 */
async function handleQueueBatch(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext): Promise<void> {
  for (const message of batch.messages) {
    try {
      const item = message.body;
      if (item && item.type === 'deploy' && item.payload) {
        const subReq = new Request('https://internal/api/v1/control/deploy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload),
        });
        await handleTriggerDeploy(subReq, env, ctx);
      }
      message.ack();
    } catch (err: any) {
      console.error('Failed to process message from queue:', err);
      message.retry();
    }
  }
}

/**
 * Pings configured endpoints and sends WhatsApp/Telegram alerts if an endpoint goes down
 */
async function handleUptimeChecks(env: Env): Promise<void> {
  const urlsStr = env.HEALTHCHECK_URLS;
  if (!urlsStr) return;

  const urls = urlsStr.split(',').map((u) => u.trim()).filter(Boolean);

  for (const targetUrl of urls) {
    const startTime = Date.now();
    try {
      const resp = await fetch(targetUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'FlareLens-Uptime/1.0' },
        signal: AbortSignal.timeout(6000),
      });

      const latencyMs = Date.now() - startTime;

      if (!resp.ok) {
        await notifyUptimeFailure(targetUrl, `HTTP ${resp.status} ${resp.statusText}`, latencyMs, env);
      }
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      await notifyUptimeFailure(targetUrl, err.message || 'Connection timeout/failure', latencyMs, env);
    }
  }
}

async function notifyUptimeFailure(url: string, error: string, latencyMs: number, env: Env): Promise<void> {
  const alertText = `🚨 *[FlareLens Uptime Alert] ENDPOINT DOWN*\n\n• Target: ${url}\n• Error: ${error}\n• Latency: ${latencyMs}ms\n• Checked: ${new Date().toISOString()}`;

  // Telegram
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: alertText,
          parse_mode: 'Markdown',
        }),
      });
    } catch (e) {}
  }

  // WhatsApp
  if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_TO) {
    try {
      await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: env.WHATSAPP_TO.replace(/[^\d]/g, ''),
          type: 'text',
          text: { body: alertText },
        }),
      });
    } catch (e) {}
  }
}

/**
 * Automated Failover & Self-Healing: Detects crashed/unresponsive nodes and auto-reschedules workloads
 */
async function handleNodeCrashFailover(env: Env, ctx: ExecutionContext): Promise<void> {
  try {
    const nodeResp = await handleListNodes(env);
    const nodeData = (await nodeResp.json()) as { nodes: NodeRecord[] };
    const nodes = nodeData.nodes || [];
    if (nodes.length <= 1) return; // Need at least 2 nodes to failover workloads

    const now = Date.now();
    const deadNodes: NodeRecord[] = [];
    const healthyNodes: NodeRecord[] = [];

    for (const node of nodes) {
      const lastHbMs = node.last_heartbeat ? (node.last_heartbeat < 10_000_000_000 ? node.last_heartbeat * 1000 : node.last_heartbeat) : 0;
      const isUnresponsive = lastHbMs > 0 && (now - lastHbMs > 90_000);
      if (isUnresponsive && node.status !== 'dead') {
        deadNodes.push(node);
      } else if (!isUnresponsive && node.status !== 'dead') {
        healthyNodes.push(node);
      }
    }

    if (deadNodes.length === 0 || healthyNodes.length === 0) return;

    // Load active services to see what was running on the dead nodes
    const svcResp = await handleListServices(env);
    const svcData = (await svcResp.json()) as { services: any[] };
    const allServices = svcData.services || [];

    for (const deadNode of deadNodes) {
      console.warn(`[FAILOVER ALARM] Node ${deadNode.node_id} is unresponsive (>90s). Initiating failover.`);

      // 1. Mark node as dead
      deadNode.status = 'dead';
      fleetNodes.set(deadNode.node_id, deadNode);
      if (env.FLEET_KV) {
        ctx.waitUntil(safeKvPut(env.FLEET_KV, `node:${deadNode.node_id}`, JSON.stringify(deadNode)));
      }

      // 2. Find services hosted on this dead node
      const servicesToMigrate = allServices.filter((s) => s.node_id === deadNode.node_id && s.image);

      for (const svc of servicesToMigrate) {
        const targetNode = await selectBestNodeForService(svc.name, env);
        if (targetNode === deadNode.node_id) continue;

        console.log(`[FAILOVER ACTION] Migrating ${svc.name} (${svc.image}) from dead node ${deadNode.node_id} to ${targetNode}`);

        const deployReq = new Request('https://internal/api/v1/control/deploy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            service: svc.name,
            image: svc.image,
            node_id: targetNode,
            env: svc.env || 'production',
          }),
        });

        ctx.waitUntil(handleTriggerDeploy(deployReq, env, ctx));

        const failoverLog: LogRecord = {
          id: `log_failover_${Date.now()}_${svc.name}`,
          timestamp: new Date().toISOString(),
          time_iso: new Date().toISOString(),
          level: 'error',
          service: 'flarelens-orchestrator',
          environment: svc.env || 'production',
          message: `🚨 [HIGH AVAILABILITY FAILOVER] Host ${deadNode.node_id} crashed. Service ${svc.name} automatically migrated & deployed to healthy node ${targetNode}.`,
          attributes: {
            from_node: deadNode.node_id,
            to_node: targetNode,
            service: svc.name,
            image: svc.image,
          },
        };
        ringBuffer.push(failoverLog);
        if (ringBuffer.length > RING_BUFFER_MAX) ringBuffer.shift();
        broadcastSSE(failoverLog);
      }
    }
  } catch (err) {
    console.error('Failed to execute handleNodeCrashFailover:', err);
  }
}


/**
 * Validates Ingest API Secret token from Bearer header, x-api-key, or query param
 */
function validateIngestAuth(request: Request, env: Env, url: URL): Response | null {
  if (!env.INGEST_SECRET && !env.ENROLL_TOKEN) return null; // If no secrets configured, open ingest

  const authHeader = request.headers.get('Authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : '';
  const apiKeyHeader = request.headers.get('x-api-key') || '';
  const queryToken = url.searchParams.get('token') || '';

  const providedToken = bearerToken || apiKeyHeader || queryToken;

  if (env.INGEST_SECRET && providedToken === env.INGEST_SECRET) return null;
  if (env.ENROLL_TOKEN && providedToken === env.ENROLL_TOKEN) return null;
  if (!env.INGEST_SECRET) return null;

  return new Response(JSON.stringify({ error: 'Unauthorized: Invalid or missing INGEST_SECRET token' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Validates Node Enrollment API token from Bearer header, x-api-key, or query param
 */
function validateEnrollAuth(request: Request, env: Env, url: URL): Response | null {
  const secret = env.ENROLL_TOKEN;
  if (!secret) return null; // Open enrollment when ENROLL_TOKEN is not configured

  const authHeader = request.headers.get('Authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : '';
  const apiKeyHeader = request.headers.get('x-api-key') || '';
  const queryToken = url.searchParams.get('token') || '';

  const providedToken = bearerToken || apiKeyHeader || queryToken;

  if (providedToken !== secret) {
    return new Response(JSON.stringify({ error: 'Unauthorized: Invalid or missing ENROLL_TOKEN' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  return null;
}

/**
 * Validates dashboard authentication via Cloudflare Access (Zero Trust) or HTTP Basic Auth
 */
function validateDashboardAuth(request: Request, env: Env): Response | null {
  // CORS Preflight: Always allow OPTIONS without auth challenge
  if (request.method === 'OPTIONS') {
    return null;
  }

  // 1. If Cloudflare Access Zero Trust is active, trust the verified identity header
  const cfUser = request.headers.get('cf-access-authenticated-user-email');
  if (cfUser) {
    return null; // Authenticated via Cloudflare Zero Trust!
  }

  // 1b. Support Bearer token / x-api-key authentication (matches INGEST_SECRET or ENROLL_TOKEN)
  const authHeader = request.headers.get('Authorization') || '';
  const apiKeyHeader = request.headers.get('x-api-key') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : '';
  const providedToken = bearerToken || apiKeyHeader;
  if (providedToken) {
    if ((env.INGEST_SECRET && providedToken === env.INGEST_SECRET) ||
        (env.ENROLL_TOKEN && providedToken === env.ENROLL_TOKEN)) {
      return null;
    }
  }

  // 2. If DASHBOARD_PASSWORD is not set, allow open access
  if (!env.DASHBOARD_PASSWORD) {
    return null;
  }

  // 3. HTTP Basic Auth
  if (!authHeader.startsWith('Basic ')) {
    return requestBasicAuth();
  }

  try {
    const base64Credentials = authHeader.substring(6).trim();
    const credentials = atob(base64Credentials);
    const [username, password] = credentials.split(':');

    const expectedUser = env.DASHBOARD_USERNAME || 'admin';
    const expectedPass = env.DASHBOARD_PASSWORD;
    if (username === expectedUser && (password === expectedPass || (env.INGEST_SECRET && password === env.INGEST_SECRET) || (env.ENROLL_TOKEN && password === env.ENROLL_TOKEN))) {
      return null; // Authorized!
    }
  } catch (e) {}

  return requestBasicAuth();
}

function requestBasicAuth(): Response {
  return new Response('Unauthorized: Access to FlareLens requires authentication.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="FlareLens Observability"',
      'Content-Type': 'text/plain',
    },
  });
}

/**
 * Handle log ingestion from Vector, curl, Docker, or App SDKs
 */
async function handleIngest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const rawText = await request.text();
    const trimmed = rawText.trim();
    if (!trimmed) {
      return new Response(JSON.stringify({ error: 'Payload body is empty' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    let items: any[] = [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        items = JSON.parse(trimmed);
      } catch (e) {}
    } else if (trimmed.startsWith('{') && !trimmed.includes('\n')) {
      try {
        items = [JSON.parse(trimmed)];
      } catch (e) {}
    }

    // Support NDJSON (Newline Delimited JSON, default batch format emitted by Vector & Fluentbit)
    if (items.length === 0) {
      const lines = trimmed.split('\n');
      for (const line of lines) {
        const l = line.trim();
        if (l) {
          try {
            items.push(JSON.parse(l));
          } catch (e) {}
        }
      }
    }

    if (items.length === 0) {
      return new Response(JSON.stringify({ error: 'Unable to parse JSON or NDJSON payload' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const now = new Date();
    const normalizedLogs: LogRecord[] = [];

    for (const item of items) {
      // Check if item is a NodeTelemetryHeartbeat from flarelens-agent
      if (item && item.node_id && item.metrics && typeof item.metrics === 'object' && ('cpu_usage_pct' in item.metrics || 'ram_used_bytes' in item.metrics)) {
        const telem = item as NodeTelemetryHeartbeat;
        const nodeId = telem.node_id;

        // 1. Update in-memory & KV
        let node = fleetNodes.get(nodeId);
        if (!node && env.FLEET_KV) {
          const raw = await env.FLEET_KV.get(`node:${nodeId}`);
          if (raw) {
            try { node = JSON.parse(raw); } catch {}
          }
        }

        if (node) {
          const prevStatus = node.status;
          node.status = telem.status || node.status;
          node.last_heartbeat = Date.now();
          node.updated_at = now.toISOString();
          node.latest_telemetry = telem;
          fleetNodes.set(nodeId, node);

          // Only persist to KV on state transition (e.g. Healthy -> Warning) to prevent burning 5,760+ writes/day
          if (env.FLEET_KV && prevStatus !== node.status) {
            ctx.waitUntil(safeKvPut(env.FLEET_KV, `node:${nodeId}`, JSON.stringify(node)));
          }
        }

        const cpuPct = telem.metrics?.cpu_usage_pct ?? 0;
        const ramPct = telem.metrics?.ram_usage_pct ?? 0;
        const diskPct = telem.metrics?.disk_usage_pct ?? 0;
        const statusLevel = telem.status === 'Healthy' ? 'info' : (telem.status === 'Warning' ? 'warn' : 'error');

        const record: LogRecord = {
          id: `telem_${now.getTime()}_${nodeId}`,
          timestamp: telem.timestamp || now.toISOString(),
          time_iso: telem.timestamp || now.toISOString(),
          level: statusLevel,
          service: 'flarelens-agent',
          message: `Heartbeat [${nodeId}]: status=${telem.status}, CPU=${cpuPct.toFixed(1)}%, RAM=${ramPct.toFixed(1)}%, Disk=${diskPct.toFixed(1)}%, containers=${telem.containers?.length || 0}`,
          environment: env.ENVIRONMENT || 'production',
          attributes: {
            node_id: nodeId,
            status: telem.status,
            docker_healthy: telem.docker_healthy,
            cpu_usage_pct: cpuPct,
            ram_usage_pct: ramPct,
            disk_usage_pct: diskPct,
            load_avg_1: telem.metrics?.load_avg_1,
            uptime_seconds: telem.metrics?.uptime_seconds,
            containers_count: telem.containers?.length || 0,
          },
        };

        normalizedLogs.push(record);
        ringBuffer.push(record);
        if (ringBuffer.length > RING_BUFFER_MAX) ringBuffer.shift();
        broadcastSSE(record);
        broadcastTelemetry({ type: 'telemetry_heartbeat', telemetry: telem });
        continue;
      }

      const timestamp = item.timestamp || item['@timestamp'] || now.toISOString();
      const service = item.service || item.app || item.service_name || item.container_name || 'unknown';
      const environment = item.environment || item.deployment_env || item.env || 'production';
      const level = (item.level || item.severity || 'info').toLowerCase();
      const message = typeof item.message === 'string' ? item.message : (item.msg ? String(item.msg) : JSON.stringify(item));

      const attrs: Record<string, any> = item.attributes ? { ...item.attributes } : {};
      if (item.container_name && !attrs.container_name) attrs.container_name = item.container_name;
      if (item.image && !attrs.image) attrs.image = item.image;
      if (item.host && !attrs.host) attrs.host = item.host;
      if (item.stream && !attrs.stream) attrs.stream = item.stream;
      if (item.container_id && !attrs.container_id) attrs.container_id = item.container_id;

      const record: LogRecord = {
        id: item.id || `log_${now.getTime()}_${Math.random().toString(36).substring(2, 8)}`,
        timestamp,
        time_iso: typeof timestamp === 'string' && timestamp.includes('T') ? timestamp : now.toISOString(),
        level,
        service,
        message,
        environment,
        env: environment,
        trace_id: item.trace_id || item.traceId || item.traceID || '',
        span_id: item.span_id || item.spanId || item.spanID || '',
        parent_span_id: item.parent_span_id || item.parentSpanId || '',
        duration_ms: typeof item.duration_ms === 'number' ? item.duration_ms : 0,
        status: typeof item.status === 'number' ? item.status : item.status_code || 0,
        attributes: attrs,
      };

      normalizedLogs.push(record);

      // Append to in-memory buffer
      ringBuffer.push(record);
      if (ringBuffer.length > RING_BUFFER_MAX) {
        ringBuffer.shift();
      }

      // Broadcast immediately to all connected Live Tail SSE tabs (< 5ms)
      broadcastSSE(record);
    }

    const host = request.headers.get('host') || 'logs.flarelens.dev';

    // Process alerts asynchronously (does not block ingest response)
    ctx.waitUntil(processAlerts(normalizedLogs, env, host));

    // Buffer logs for 1-minute Apache Parquet batch compaction
    parquetLogCompactorBuffer.push(...normalizedLogs);

    const nowTime = Date.now();
    if (
      parquetLogCompactorBuffer.length >= PARQUET_BATCH_MAX_RECORDS ||
      (nowTime - lastParquetFlushTime >= PARQUET_FLUSH_INTERVAL_MS && parquetLogCompactorBuffer.length > 0)
    ) {
      const logsToFlush = [...parquetLogCompactorBuffer];
      parquetLogCompactorBuffer = [];
      lastParquetFlushTime = nowTime;
      ctx.waitUntil(flushToR2(logsToFlush, env, now));
    }

    return new Response(JSON.stringify({ status: 'ok', count: normalizedLogs.length }), {
      status: 202,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Invalid JSON payload' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

/**
 * Broadcasts an incoming log record to all open SSE connections
 */
function broadcastSSE(log: LogRecord) {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(log)}\n\n`;
  const encoded = textEncoder.encode(payload);

  for (const writer of sseClients) {
    writer.write(encoded).catch(() => {
      sseClients.delete(writer);
    });
  }
}

/**
 * Server-Sent Events (SSE) live tail stream
 */
function handleLiveSSE(): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  sseClients.add(writer);

  // Send initial connection acknowledgement
  writer.write(textEncoder.encode(`: connected to FlareLens Live Tail\n\n`)).catch(() => {});

  // Keep-alive heartbeat ping every 15 seconds to prevent browser/proxy timeouts
  const keepAliveTimer = setInterval(() => {
    writer.write(textEncoder.encode(`: keepalive\n\n`)).catch(() => {
      clearInterval(keepAliveTimer);
      sseClients.delete(writer);
    });
  }, 15000);

  // Handle client disconnect
  readable.cancel = async () => {
    clearInterval(keepAliveTimer);
    sseClients.delete(writer);
  };

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

let lastR2Sync = 0;

/**
 * Return recent logs from the in-memory ring buffer, hydrating from R2 across serverless isolates
 */
async function handleRecentLogs(env: Env): Promise<Response> {
  const now = Date.now();
  if (env.LOGS_BUCKET && (ringBuffer.length === 0 || now - lastR2Sync > 5000)) {
    lastR2Sync = now;
    try {
      const latestObj = await env.LOGS_BUCKET.get('recent/latest.json');
      if (latestObj) {
        const text = await latestObj.text();
        const lines = text.split('\n').filter(Boolean);
        const seenIds = new Set(ringBuffer.map((r) => r.id || `${r.timestamp}_${r.service}`));
        for (const line of lines) {
          try {
            const parsed: LogRecord = JSON.parse(line);
            const id = parsed.id || `${parsed.timestamp}_${parsed.service}`;
            if (!seenIds.has(id)) {
              seenIds.add(id);
              ringBuffer.push(parsed);
              if (ringBuffer.length > RING_BUFFER_MAX) {
                ringBuffer.shift();
              }
            }
          } catch (e) {}
        }
      } else {
        // Fallback: list newest file if recent/latest.json does not exist yet
        const listed = await env.LOGS_BUCKET.list({ limit: 10 });
        if (listed.objects.length > 0) {
          const sorted = listed.objects
            .filter((o) => o.key.endsWith('.json'))
            .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
          if (sorted.length > 0) {
            const newest = await env.LOGS_BUCKET.get(sorted[0].key);
            if (newest) {
              const text = await newest.text();
              const lines = text.split('\n').filter(Boolean);
              for (const line of lines) {
                try {
                  const parsed = JSON.parse(line);
                  ringBuffer.push(parsed);
                  if (ringBuffer.length > RING_BUFFER_MAX) ringBuffer.shift();
                } catch (e) {}
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('Failed to sync recent logs from R2:', e);
    }
  }

  return new Response(JSON.stringify(ringBuffer), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Flush a batch of logs to Cloudflare R2 using Hive date partitioning as Apache Parquet files
 */
async function flushToR2(logs: LogRecord[], env: Env, date: Date): Promise<void> {
  if (!env.LOGS_BUCKET || logs.length === 0) return;

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const timestamp = date.getTime();

  // Hive partitioned key: year=YYYY/month=MM/day=DD/hour=HH/logs_...parquet
  const key = `year=${year}/month=${month}/day=${day}/hour=${hour}/logs_${timestamp}_${randomSuffix}.parquet`;

  try {
    const parquetBuffer = parquetWriteBuffer({
      columnData: [
        { name: 'id', data: logs.map(l => String(l.id || '')) },
        { name: 'timestamp', data: logs.map(l => String(l.timestamp || l.time_iso || '')) },
        { name: 'level', data: logs.map(l => String(l.level || 'info')) },
        { name: 'service', data: logs.map(l => String(l.service || 'unknown')) },
        { name: 'environment', data: logs.map(l => String(l.environment || l.env || 'production')) },
        { name: 'message', data: logs.map(l => String(l.message || '')) },
        { name: 'status', data: logs.map(l => Number(l.status || 0)) },
        { name: 'duration_ms', data: logs.map(l => Number(l.duration_ms || 0)) },
        { name: 'trace_id', data: logs.map(l => String(l.trace_id || '')) },
        { name: 'span_id', data: logs.map(l => String(l.span_id || '')) },
        { name: 'attributes', data: logs.map(l => JSON.stringify(l.attributes || {})) }
      ]
    });

    await env.LOGS_BUCKET.put(key, parquetBuffer, {
      httpMetadata: {
        contentType: 'application/vnd.apache.parquet',
      },
      customMetadata: {
        format: 'parquet',
        count: String(logs.length),
        source: 'flarelens-worker',
      },
    });

    // Update global sliding window file in R2 for cross-isolate instant visibility
    const body = logs.map((l) => JSON.stringify(l)).join('\n');
    let combined = body;
    try {
      const existing = await env.LOGS_BUCKET.get('recent/latest.json');
      if (existing) {
        const existingText = await existing.text();
        const existingLines = existingText.split('\n').filter(Boolean);
        const newLines = body.split('\n').filter(Boolean);
        combined = [...existingLines, ...newLines].slice(-1000).join('\n');
      }
    } catch (e) {}

    await env.LOGS_BUCKET.put('recent/latest.json', combined, {
      httpMetadata: {
        contentType: 'application/x-ndjson',
      },
    });
  } catch (err) {
    console.error('Failed to flush logs to R2 as Parquet:', err);
  }
}

/**
 * HTTP Range-request proxy to Cloudflare R2 for hyparquet & DuckDB-WASM
 */
async function handleParquetRange(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Authorization, Content-Type',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      },
    });
  }

  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!key) {
    return new Response('Missing key parameter', { status: 400 });
  }

  const rangeHeader = request.headers.get('Range');
  let rangeOption: R2Range | undefined = undefined;

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
    if (match) {
      const offset = parseInt(match[1], 10);
      const length = match[2] ? parseInt(match[2], 10) - offset + 1 : undefined;
      rangeOption = { offset, length };
    }
  }

  try {
    const object = await env.LOGS_BUCKET.get(key, { range: rangeOption });

    if (!object) {
      return new Response('Object not found in R2', { status: 404 });
    }

    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'public, max-age=3600');
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/vnd.apache.parquet');
    headers.set('Content-Length', String(object.size));

    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }

    if (rangeOption) {
      const start = rangeOption.offset ?? 0;
      const end = start + object.size - 1;
      headers.set('Content-Range', `bytes ${start}-${end}/*`);
      return new Response(object.body, { status: 206, headers });
    }

    return new Response(object.body, { status: 200, headers });
  } catch (err: any) {
    return new Response(err.message, { status: 500 });
  }
}

/**
 * List historical files stored in R2
 */
async function handleListFiles(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const prefix = url.searchParams.get('prefix') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);

  try {
    const listed = await env.LOGS_BUCKET.list({
      prefix,
      limit,
    });

    const files = listed.objects.map((obj) => ({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded,
      customMetadata: obj.customMetadata,
    }));

    return new Response(JSON.stringify({ files, truncated: listed.truncated }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

/**
 * Handle agent node enrollment: registers specs, tags, and initial status in Cloudflare KV
 */
async function handleEnroll(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const payload = (await request.json()) as NodeRegistrationPayload;
    if (!payload || !payload.node_id) {
      return new Response(JSON.stringify({ error: 'Missing node_id in enrollment payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const nowIso = new Date().toISOString();
    const record: NodeRecord = {
      ...payload,
      enrolled_at: nowIso,
      updated_at: nowIso,
    };

    // 1. Persist to Cloudflare KV if bound
    if (env.FLEET_KV) {
      await safeKvPut(env.FLEET_KV, `node:${payload.node_id}`, JSON.stringify(record));

      // Update fleet index list
      try {
        const existingListRaw = await env.FLEET_KV.get('fleet:nodes');
        const nodeList: string[] = existingListRaw ? JSON.parse(existingListRaw) : [];
        if (!nodeList.includes(payload.node_id)) {
          nodeList.push(payload.node_id);
          await safeKvPut(env.FLEET_KV, 'fleet:nodes', JSON.stringify(nodeList));
        }
      } catch {}
    }

    // 2. Persist to in-memory map & R2 bucket fallback
    fleetNodes.set(payload.node_id, record);
    if (env.LOGS_BUCKET) {
      ctx.waitUntil(
        env.LOGS_BUCKET.put(
          `control/nodes/${payload.node_id}.json`,
          JSON.stringify(record, null, 2),
          { httpMetadata: { contentType: 'application/json' } }
        )
      );
    }

    // 3. Emit enrollment log record to ring buffer & SSE
    const enrollLog: LogRecord = {
      id: `enroll_${Date.now()}_${payload.node_id}`,
      timestamp: nowIso,
      time_iso: nowIso,
      level: 'info',
      service: 'flarelens-control',
      environment: env.ENVIRONMENT || 'production',
      message: `Node enrolled: ${payload.node_id} (host: ${payload.hostname}, provider: ${payload.provider}, region: ${payload.region}, CPUs: ${payload.specs?.cpus || 'unknown'})`,
      attributes: {
        node_id: payload.node_id,
        hostname: payload.hostname,
        provider: payload.provider,
        region: payload.region,
        tags: payload.tags,
        cpus: payload.specs?.cpus,
        ram_total_bytes: payload.specs?.ram_total_bytes,
        version: payload.version,
      },
    };
    ringBuffer.push(enrollLog);
    if (ringBuffer.length > RING_BUFFER_MAX) ringBuffer.shift();
    broadcastSSE(enrollLog);
    broadcastTelemetry({ type: 'node_enrolled', node: record });

    return new Response(
      JSON.stringify({
        status: 'enrolled',
        node_id: payload.node_id,
        enrolled_at: record.enrolled_at,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Enrollment failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * List all enrolled nodes with their hardware specs and telemetry
 */
async function handleListNodes(env: Env): Promise<Response> {
  try {
    const nodes: NodeRecord[] = [];

    if (env.FLEET_KV) {
      const existingListRaw = await env.FLEET_KV.get('fleet:nodes');
      if (existingListRaw) {
        try {
          const idList: string[] = JSON.parse(existingListRaw);
          for (const id of idList) {
            const rawNode = await env.FLEET_KV.get(`node:${id}`);
            if (rawNode) nodes.push(JSON.parse(rawNode));
          }
        } catch {}
      } else {
        const listResult = await env.FLEET_KV.list({ prefix: 'node:' });
        for (const key of listResult.keys) {
          const raw = await env.FLEET_KV.get(key.name);
          if (raw) nodes.push(JSON.parse(raw));
        }
      }
    }

    // Merge in-memory nodes
    for (const [id, record] of fleetNodes.entries()) {
      if (!nodes.some((n) => n.node_id === id)) {
        nodes.push(record);
      }
    }

    // Enrich nodes with Zero-Trust Sovereign Mesh metadata
    const meshPeers = await loadAllMeshPeers(env);
    for (const node of nodes) {
      const peer = meshPeers.find((p) => p.id === node.node_id || p.name === node.node_id || p.hostname === node.node_id);
      if (peer) {
        node.mesh = {
          tailscale_ip: peer.tailscale_ip || peer.overlay_ip,
          magic_dns: peer.magic_dns || `${node.node_id.toLowerCase()}${MAGIC_DNS_SUFFIX}`,
          connection_type: peer.connection_type || 'direct_p2p',
          status: peer.online ? 'connected' : 'offline',
        };
      } else {
        node.mesh = {
          tailscale_ip: '100.64.0.1',
          magic_dns: `${node.node_id.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}${MAGIC_DNS_SUFFIX}`,
          connection_type: 'direct_p2p',
          status: 'connected',
        };
      }
    }

    return new Response(JSON.stringify({ nodes, count: nodes.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Get details for a specific node
 */
async function handleGetNode(nodeId: string, env: Env): Promise<Response> {
  if (env.FLEET_KV) {
    const raw = await env.FLEET_KV.get(`node:${nodeId}`);
    if (raw) {
      return new Response(raw, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }

  const mem = fleetNodes.get(nodeId);
  if (mem) {
    return new Response(JSON.stringify(mem), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  return new Response(JSON.stringify({ error: `Node ${nodeId} not found` }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

/**
 * WebSocket upgrade handler for bidirectional telemetry gateway
 */
function handleControlWebSocket(request: Request, env: Env): Response {
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  server.accept();
  telemetryWsClients.add(server);

  server.addEventListener('message', async (event: MessageEvent) => {
    try {
      const msg = typeof event.data === 'string' ? JSON.parse(event.data) : null;
      if (msg && msg.type === 'ping') {
        server.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
    } catch {}
  });

  server.addEventListener('close', () => {
    telemetryWsClients.delete(server);
  });

  server.addEventListener('error', () => {
    telemetryWsClients.delete(server);
  });

  server.send(
    JSON.stringify({
      type: 'connected',
      service: 'flarelens-control-plane',
      timestamp: Date.now(),
    })
  );

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/**
 * Broadcast telemetry data to all active WebSocket clients
 */
function broadcastTelemetry(data: any): void {
  const payloadStr = JSON.stringify(data);
  for (const ws of telemetryWsClients) {
    try {
      ws.send(payloadStr);
    } catch {
      telemetryWsClients.delete(ws);
    }
  }
}

/**
 * Smart Bin-Packing Scheduler:
 * Analyzes live node metrics (CPU, RAM, container count) and selects the optimal node.
 * Uses Best-Fit Decreasing (Bin-Packing) to consolidate workloads on fewer machines,
 * falling back to least-loaded when cluster is under high memory pressure.
 */
async function selectBestNodeForService(
  service: string,
  env: Env,
  requiredRamMb: number = 256
): Promise<string> {
  try {
    const nodeResp = await handleListNodes(env);
    const nodeData = (await nodeResp.json()) as { nodes: NodeRecord[] };
    const nodes = nodeData.nodes || [];

    if (nodes.length === 0) {
      return 'node-1';
    }

    const now = Date.now();
    // A node is eligible if it is not marked dead, and has reported a heartbeat within the last 120s
    const eligibleNodes = nodes.filter((n) => {
      if (n.status === 'dead' || n.status === 'Unhealthy') return false;
      const lastHbMs = n.last_heartbeat ? (n.last_heartbeat < 10_000_000_000 ? n.last_heartbeat * 1000 : n.last_heartbeat) : 0;
      if (lastHbMs > 0 && (now - lastHbMs > 120_000)) return false;
      return true;
    });

    const candidates = eligibleNodes.length > 0 ? eligibleNodes : nodes;
    if (candidates.length === 1) {
      return candidates[0].node_id;
    }

    const requiredBytes = requiredRamMb * 1024 * 1024;

    // Score candidates based on free RAM and CPU usage
    const scored = candidates.map((node) => {
      const totalBytes =
        node.latest_telemetry?.metrics?.ram_total_bytes ||
        node.specs?.ram_total_bytes ||
        4 * 1024 * 1024 * 1024;
      const usedBytes = node.latest_telemetry?.metrics?.ram_used_bytes || 0;
      const freeBytes = Math.max(0, totalBytes - usedBytes);
      const cpuUsage = node.latest_telemetry?.metrics?.cpu_usage_pct || 0;
      const hasEnough = freeBytes >= requiredBytes;

      return {
        node_id: node.node_id,
        freeBytes,
        hasEnough,
        cpuUsage,
        containersCount: node.latest_telemetry?.containers?.length || 0,
      };
    });

    // 1. Filter candidates that have enough free RAM
    const capable = scored.filter((s) => s.hasEnough);

    if (capable.length > 0) {
      // Bin-Packing (Best-Fit): Pick the node with the SMALLEST free RAM that still fits the workload.
      // This packs workloads tightly, leaving other nodes free to idle or sleep.
      // Secondary sort: lower CPU usage.
      capable.sort((a, b) => {
        const ramDiff = a.freeBytes - b.freeBytes;
        if (Math.abs(ramDiff) > 128 * 1024 * 1024) {
          return ramDiff; // Smallest free space first (bin-packing)
        }
        return a.cpuUsage - b.cpuUsage;
      });
      return capable[0].node_id;
    }

    // Fallback if all nodes are under high memory pressure: Pick the node with the MOST free RAM (least-loaded)
    scored.sort((a, b) => b.freeBytes - a.freeBytes);
    return scored[0].node_id;
  } catch (err) {
    console.warn(`[Scheduler] selectBestNodeForService error for ${service}:`, err);
    return 'node-1';
  }
}

/**
 * Resolves fleet nodes for targeted, auto-scheduled, or cluster-wide multi-node rollouts
 */
async function resolveFleetNodes(targetNodeId: string, env: Env, serviceName?: string): Promise<string[]> {
  const allNodes: string[] = [];
  if (env.FLEET_KV) {
    try {
      const raw = await env.FLEET_KV.get('fleet:nodes');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) allNodes.push(...parsed);
      }
    } catch {}
  }
  for (const n of fleetNodes.keys()) {
    if (!allNodes.includes(n)) allNodes.push(n);
  }

  // 1. Broadcast to all active production nodes
  if (targetNodeId === 'all-prod') {
    const prodNodes = allNodes.filter((n) => !n.includes('wsl') && !n.includes('test'));
    return prodNodes.length > 0 ? prodNodes : (allNodes.length > 0 ? allNodes : ['node-1']);
  }
  if (targetNodeId === 'all') {
    return allNodes.length > 0 ? allNodes : ['node-1'];
  }

  // 2. Intelligent Elastic Bin-Packing ("auto" or "smart" or empty)
  if (!targetNodeId || targetNodeId === 'auto' || targetNodeId === 'smart') {
    const bestNode = await selectBestNodeForService(serviceName || 'app', env);
    return [bestNode];
  }

  return [targetNodeId];
}

/**
 * Trigger an ArgoCD-style Blue/Green deployment (supports single node, auto-scheduled, or multi-node fleet rollouts)
 */
async function handleTriggerDeploy(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const payload = (await request.json()) as DeployRequestPayload;
    if (!payload.service || !payload.image) {
      return new Response(JSON.stringify({ error: 'Missing required fields: service, image' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (!payload.node_id || payload.node_id === 'auto' || payload.node_id === 'smart') {
      payload.node_id = await selectBestNodeForService(payload.service, env);
    }

    const targetNodes = await resolveFleetNodes(payload.node_id, env, payload.service);
    const nowIso = new Date().toISOString();

    // 0a. Auto-inject declarative Blue/Green defaults if omitted
    const defaults = getServiceDeclarativeDefaults(payload.service, payload.env || 'uat');
    if (!payload.domain && defaults.domain) payload.domain = defaults.domain;
    if (!payload.container_port && defaults.container_port) payload.container_port = defaults.container_port;
    if (!payload.host_port_blue && defaults.host_port_blue) payload.host_port_blue = defaults.host_port_blue;
    if (!payload.host_port_green && defaults.host_port_green) payload.host_port_green = defaults.host_port_green;
    if (!payload.health_path && defaults.health_path) payload.health_path = defaults.health_path;
    if (!payload.command && defaults.command) payload.command = defaults.command;
    if (!payload.entrypoint && defaults.entrypoint) payload.entrypoint = defaults.entrypoint;
    if (!payload.networks && defaults.networks) payload.networks = defaults.networks;
    if (!payload.workers && defaults.workers) payload.workers = defaults.workers;
    if (!payload.timeout_seconds && defaults.timeout_seconds) payload.timeout_seconds = defaults.timeout_seconds;
    if (!payload.drain_seconds && defaults.drain_seconds) payload.drain_seconds = defaults.drain_seconds;
    if (payload.pre_deploy_snapshot === undefined && defaults.pre_deploy_snapshot !== undefined) {
      payload.pre_deploy_snapshot = defaults.pre_deploy_snapshot;
    }

    // 0b. Auto-inject encrypted zero-plaintext secrets from Vault if not explicitly provided
    if (!payload.secrets && env.FLEET_KV) {
      try {
        const masterKey = env.VAULT_MASTER_KEY || env.INGEST_SECRET || 'flarelens-default-vault-key';
        const vaultRes = await resolveVaultSecrets(env.FLEET_KV, payload.service, payload.env || 'uat', masterKey);
        if (vaultRes?.secrets) {
          payload.secrets = vaultRes.secrets;
        } else {
          console.warn(`No secrets found in Vault for ${payload.service} (checked environment: ${payload.env || 'uat'})`);
        }
      } catch (err) {
        console.warn(`Could not auto-decrypt vault secrets for ${payload.service}:`, err);
      }
    }

    const createdDeployments: DeploymentRecord[] = [];

    for (const targetNode of targetNodes) {
      const deployID = targetNodes.length > 1
        ? `dep_${Date.now()}_${targetNode}_${Math.random().toString(36).substring(2, 6)}`
        : (payload.deployment_id || `dep_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);

      const nodePayload = { ...payload, node_id: targetNode, deployment_id: deployID };

      const record: DeploymentRecord = {
        deployment_id: deployID,
        service: payload.service,
        image: payload.image,
        node_id: targetNode,
        env: payload.env || (payload.is_preview ? 'preview' : 'production'),
        status: 'initiated',
        created_at: nowIso,
        updated_at: nowIso,
        message: payload.is_preview
          ? `Ephemeral PR preview initiated for PR #${payload.pr_number} (${payload.service}) on ${targetNode}`
          : (payload.canary_weight && payload.canary_weight > 0
              ? `Canary deployment (${payload.canary_weight}% / ${payload.canary_duration || 30}s soak) initiated for ${payload.service} on ${targetNode}`
              : `Deployment initiated for ${payload.service} with image ${payload.image} on ${targetNode}`),
        is_preview: payload.is_preview,
        pr_number: payload.pr_number,
        canary_weight: payload.canary_weight,
        canary_duration: payload.canary_duration,
      };

      // 1. Save in KV and in-memory map
      fleetDeployments.set(deployID, record);
      if (env.FLEET_KV) {
        await safeKvPut(env.FLEET_KV, `deployment:${deployID}`, JSON.stringify(record));
        try {
          const rawList = await env.FLEET_KV.get('fleet:deployments');
          const list: string[] = rawList ? JSON.parse(rawList) : [];
          if (!list.includes(deployID)) {
            list.unshift(deployID);
            if (list.length > 50) list.pop(); // keep last 50
            await safeKvPut(env.FLEET_KV, 'fleet:deployments', JSON.stringify(list));
          }
        } catch {}
      }

      // 2. Broadcast deploy event to WebSocket subscribers & SSE
      broadcastTelemetry({
        type: 'deploy_initiated',
        deployment: record,
        request: nodePayload,
      });

      const deployLog: LogRecord = {
        id: `log_${Date.now()}_${deployID}`,
        timestamp: nowIso,
        time_iso: nowIso,
        level: 'info',
        service: 'flarelens-gitops',
        environment: record.env,
        message: `GitOps Deploy Initiated: ${payload.service} -> ${payload.image} on node ${targetNode}`,
        attributes: {
          deployment_id: deployID,
          service: payload.service,
          image: payload.image,
          node_id: targetNode,
        },
      };
      ringBuffer.push(deployLog);
      if (ringBuffer.length > RING_BUFFER_MAX) ringBuffer.shift();
      broadcastSSE(deployLog);

      // 3. Queue deploy command for edge agent execution via R2 / memory queue
      const deployCmd = {
        id: deployID,
        type: 'deploy',
        node_id: targetNode,
        deployment_id: deployID,
        service: payload.service,
        image: payload.image,
        env: record.env,
        container_port: payload.container_port,
        host_port_blue: payload.host_port_blue,
        host_port_green: payload.host_port_green,
        domain: payload.domain,
        health_path: payload.health_path,
        command: payload.command,
        entrypoint: payload.entrypoint,
        networks: payload.networks,
        volumes: payload.volumes,
        workers: payload.workers,
        secrets: payload.secrets,
        network: payload.network,
        canary_weight: payload.canary_weight,
        canary_duration: payload.canary_duration,
        pre_deploy_snapshot: payload.pre_deploy_snapshot,
        run_migrations: payload.run_migrations,
        migration_cmd: payload.migration_cmd,
        is_preview: payload.is_preview,
        pr_number: payload.pr_number,
        timestamp: nowIso,
      };

      const nodeCmds = inMemoryCommands.get(targetNode) || [];
      nodeCmds.push(deployCmd);
      inMemoryCommands.set(targetNode, nodeCmds);

      if (env.BACKUP_BUCKET) {
        ctx.waitUntil(
          env.BACKUP_BUCKET.put(
            `control/commands/${targetNode}/${deployCmd.id}.json`,
            JSON.stringify(deployCmd),
            { httpMetadata: { contentType: 'application/json' } }
          )
        );
      }

      createdDeployments.push(record);
    }

    return new Response(JSON.stringify({
      status: 'initiated',
      target_nodes: targetNodes,
      deployments: createdDeployments,
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Deploy trigger failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Automated CI/CD & GitHub Webhook GitOps Handler
 * Verifies HMAC signature or bearer token, extracts image & service, fetches secrets, and triggers blue/green deploy.
 */
async function handleDeployWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const rawBody = await request.text();
    const sigHeader = request.headers.get('x-hub-signature-256');
    const authHeader = request.headers.get('Authorization') || '';
    const apiKeyHeader = request.headers.get('x-api-key') || '';
    const customHeader = request.headers.get('x-webhook-secret') || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : '';
    const url = new URL(request.url);
    const queryToken = url.searchParams.get('token') || '';
    const providedToken = bearerToken || apiKeyHeader || customHeader || queryToken;

    const webhookSecret = env.WEBHOOK_SECRET || '';
    const validTokens = [webhookSecret, env.INGEST_SECRET, env.DASHBOARD_PASSWORD, env.ENROLL_TOKEN].filter(Boolean);

    // 0. GitHub Actions M2M Workload Identity (OIDC Token)
    let authenticatedOidcClaims: any = null;
    if (bearerToken && isGitHubOidcToken(bearerToken)) {
      const oidcResult = await verifyGitHubOidcToken(bearerToken, {
        expectedAudience: [url.origin, url.hostname, 'https://control.flarelens.dev'],
        allowedOwners: [],
      });
      if (!oidcResult.valid) {
        return new Response(JSON.stringify({ error: `Unauthorized GitHub OIDC: ${oidcResult.error}` }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      authenticatedOidcClaims = oidcResult.claims;
      console.log(`[Deploy Webhook] Authenticated via GitHub Actions M2M OIDC: repo=${authenticatedOidcClaims.repository}, actor=${authenticatedOidcClaims.actor}, ref=${authenticatedOidcClaims.ref}`);
    }

    if (authenticatedOidcClaims) {
      // Authenticated via cryptographic GitHub Actions OIDC token!
    } else if (sigHeader) {
      // Verify HMAC-SHA256 signature if GitHub signature header is present
      const secretToVerify = webhookSecret || env.INGEST_SECRET || '';
      if (secretToVerify) {
        const isValid = await verifyGitHubSignature(secretToVerify, sigHeader, rawBody);
        if (!isValid) {
          return new Response(JSON.stringify({ error: 'Invalid HMAC signature in x-hub-signature-256' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }
      }
    } else if (validTokens.length > 0) {
      // Direct API / CI curl call without GitHub signature: check Bearer / token / basic auth
      let isAuthValid = false;
      if (providedToken && validTokens.includes(providedToken)) {
        isAuthValid = true;
      } else if (authHeader.startsWith('Basic ')) {
        try {
          const [u, p] = atob(authHeader.substring(6).trim()).split(':');
          if (validTokens.includes(p)) isAuthValid = true;
        } catch {}
      }

      if (!isAuthValid) {
        return new Response(JSON.stringify({ error: 'Unauthorized: Valid webhook signature, Authorization token, or GitHub Actions OIDC token required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    let parsedJson: any;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: 'Malformed JSON payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const githubEvent = request.headers.get('x-github-event');
    const deployParsed = parseDeployWebhook(parsedJson, githubEvent);

    if (!deployParsed) {
      return new Response(JSON.stringify({
        status: 'ignored',
        message: 'Webhook received but event is not a deployable push or container package publication',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (deployParsed.action === 'teardown') {
      const teardownPayload: PreviewTeardownPayload = {
        service: deployParsed.service,
        pr_number: deployParsed.pr_number || 0,
        node_id: deployParsed.node_id || 'all',
      };
      const subReq = new Request('https://internal/api/v1/control/preview/teardown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(teardownPayload),
      });
      return handleTriggerPreviewTeardown(subReq, env, ctx);
    }

    // Build deployment payload with resolved zero-plaintext secrets and declarative Blue/Green defaults
    const masterKey = env.VAULT_MASTER_KEY || env.INGEST_SECRET || 'flarelens-default-vault-key';
    const deployReq = await resolveWebhookDeployPayload(deployParsed, env.FLEET_KV, masterKey);

    // If GitHub token available and commit SHA present, report pending status
    if (env.GITHUB_TOKEN && deployParsed.commit_sha && parsedJson.repository?.full_name) {
      const desc = deployParsed.is_preview
        ? `Ephemeral preview live at https://${deployParsed.domain || `pr-${deployParsed.pr_number}-${deployParsed.service}.example.com`}`
        : `GitOps deploy initiated for ${deployParsed.service}:${deployParsed.image}`;
      ctx.waitUntil(
        reportGitHubStatus(
          parsedJson.repository.full_name,
          deployParsed.commit_sha,
          env.GITHUB_TOKEN,
          'pending',
          deployParsed.domain ? `https://${deployParsed.domain}` : url.origin,
          desc
        )
      );
    }

    // If Cloudflare Queue is available, enqueue for guaranteed asynchronous execution
    if (env.DEPLOY_QUEUE) {
      await env.DEPLOY_QUEUE.send({
        type: 'deploy',
        payload: deployReq,
        commit_sha: deployParsed.commit_sha,
        repo: parsedJson.repository?.full_name,
        timestamp: new Date().toISOString(),
      });

      return new Response(JSON.stringify({
        status: 'queued',
        queue: 'flarelens-deploy-queue',
        deployment_id: deployReq.deployment_id || `queued_${Date.now()}`,
        message: `Deployment queued for ${deployReq.service}:${deployReq.image} on ${deployReq.node_id}`,
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const subReq = new Request('https://internal/api/v1/control/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(deployReq),
    });

    return handleTriggerDeploy(subReq, env, ctx);
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Webhook processing failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Ephemeral PR Preview Teardown Handler
 * Emits teardown command to target nodes and updates deployment records.
 */
async function handleTriggerPreviewTeardown(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const payload = (await request.json()) as PreviewTeardownPayload;
    if (!payload.service || !payload.pr_number) {
      return new Response(JSON.stringify({ error: 'Missing required fields: service, pr_number' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const targetNodes = await resolveFleetNodes(payload.node_id || 'all', env);
    const nowIso = new Date().toISOString();

    for (const targetNode of targetNodes) {
      const teardownReq = {
        service: payload.service,
        pr_number: payload.pr_number,
        node_id: targetNode,
      };

      // 1. Broadcast preview teardown event to fleet / node listeners
      broadcastTelemetry({
        type: 'preview_teardown',
        teardown: teardownReq,
      });

      // 2. Mark any matching preview deployments in memory and KV as destroyed
      for (const [depId, dep] of fleetDeployments.entries()) {
        if (dep.is_preview && dep.pr_number === payload.pr_number && dep.service === payload.service) {
          dep.status = 'destroyed';
          dep.message = `Ephemeral preview environment torn down for PR #${payload.pr_number}`;
          dep.updated_at = nowIso;
          fleetDeployments.set(depId, dep);
          if (env.FLEET_KV) {
            ctx.waitUntil(safeKvPut(env.FLEET_KV, `deployment:${depId}`, JSON.stringify(dep)));
          }
        }
      }

      const logRec: LogRecord = {
        id: `log_${Date.now()}_pr_${payload.pr_number}`,
        timestamp: nowIso,
        time_iso: nowIso,
        level: 'info',
        service: 'flarelens-gitops',
        environment: 'preview',
        message: `PR Preview Teardown: ${payload.service} PR #${payload.pr_number} on ${targetNode}`,
        attributes: {
          service: payload.service,
          pr_number: payload.pr_number,
          node_id: targetNode,
        },
      };
      ringBuffer.push(logRec);
      if (ringBuffer.length > RING_BUFFER_MAX) ringBuffer.shift();
      broadcastSSE(logRec);
    }

    return new Response(JSON.stringify({
      status: 'teardown_initiated',
      service: payload.service,
      pr_number: payload.pr_number,
      target_nodes: targetNodes,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Preview teardown failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * List active Ephemeral PR Preview Environments
 */
async function handleListPreviews(env: Env): Promise<Response> {
  const depResponse = await handleListDeployments(env);
  const data = (await depResponse.json()) as { deployments: DeploymentRecord[] };
  const previews = (data.deployments || []).filter((d) => d.is_preview && d.status !== 'destroyed');
  return new Response(JSON.stringify({ previews, count: previews.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

/**
 * List historical deployments
 */
async function handleListDeployments(env: Env): Promise<Response> {
  try {
    const list: DeploymentRecord[] = [];

    if (env.FLEET_KV) {
      const rawList = await env.FLEET_KV.get('fleet:deployments');
      if (rawList) {
        try {
          const ids: string[] = JSON.parse(rawList);
          for (const id of ids) {
            const raw = await env.FLEET_KV.get(`deployment:${id}`);
            if (raw) list.push(JSON.parse(raw));
          }
        } catch {}
      } else {
        const kvList = await env.FLEET_KV.list({ prefix: 'deployment:' });
        for (const k of kvList.keys) {
          const raw = await env.FLEET_KV.get(k.name);
          if (raw) list.push(JSON.parse(raw));
        }
      }
    }

    // Merge in-memory
    for (const [id, rec] of fleetDeployments.entries()) {
      if (!list.some((d) => d.deployment_id === id)) {
        list.push(rec);
      }
    }

    return new Response(JSON.stringify({ deployments: list, count: list.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Aggregate active fleet services from deployments, running containers, and vault
 */
async function handleListServices(env: Env): Promise<Response> {
  try {
    // 1. Get all deployment records to know latest deployed version & slot
    const depResp = await handleListDeployments(env);
    const depData = (await depResp.json()) as { deployments: DeploymentRecord[] };
    const deployments = depData.deployments || [];

    // Map service -> latest non-preview deployment
    const latestDepMap = new Map<string, DeploymentRecord>();
    for (const d of deployments) {
      if (!d.service || d.is_preview) continue;
      const existing = latestDepMap.get(d.service);
      if (!existing || new Date(d.created_at).getTime() > new Date(existing.created_at).getTime()) {
        latestDepMap.set(d.service, d);
      }
    }

    // 2. Get all nodes to inspect running containers
    const nodeResp = await handleListNodes(env);
    const nodeData = (await nodeResp.json()) as { nodes: NodeRecord[] };
    const nodes = nodeData.nodes || [];

    // Gather all containers across nodes
    const allContainers: { node_id: string; container: any }[] = [];
    for (const node of nodes) {
      const telem = node.latest_telemetry;
      if (telem && Array.isArray(telem.containers)) {
        for (const c of telem.containers) {
          allContainers.push({ node_id: node.node_id, container: c });
        }
      }
    }

    // 3. Known / Registered Services Map
    const serviceMap = new Map<string, any>();

    // Seed with latest deployed services
    for (const [svcName, dep] of latestDepMap.entries()) {
      serviceMap.set(svcName, {
        name: svcName,
        env: dep.env || 'uat',
        slot: dep.active_slot || 'blue',
        status: dep.status === 'success' ? 'running' : dep.status,
        image: dep.image,
        node_id: dep.node_id || 'node-1',
        last_deploy: dep.updated_at || dep.created_at,
        restarts: 0,
        container_id: null,
        container_name: null,
        container_status: 'Managed via FlareLens',
      });
    }

    // Seed/correlate infrastructure and running containers from nodes
    for (const { node_id, container } of allContainers) {
      const rawName = (container.names && container.names[0]) ? container.names[0].replace(/^\//, '') : container.id;
      
      // Match against known service or register standalone container
      let matchedService: string | null = null;
      for (const svcName of serviceMap.keys()) {
        if (rawName.includes(svcName) || svcName.includes(rawName)) {
          matchedService = svcName;
          break;
        }
      }

      // Check restarts in Status string (e.g. "Restarting (3) 10s ago") or container.restart_count
      let restartCount = container.restart_count || 0;
      if (!restartCount && container.status) {
        const m = container.status.match(/Restarting \((\d+)\)/);
        if (m) restartCount = parseInt(m[1], 10);
      }

      if (matchedService) {
        const svc = serviceMap.get(matchedService);
        svc.container_id = container.id;
        svc.container_name = rawName;
        svc.container_status = container.status;
        svc.state = container.state;
        svc.restarts = restartCount;
        if (rawName.includes('green')) svc.slot = 'green';
        else if (rawName.includes('blue')) svc.slot = 'blue';
      } else {
        // Register container as a fleet microservice
        const cleanName = rawName.replace(/-(blue|green)$/, '');
        serviceMap.set(cleanName, {
          name: cleanName,
          env: rawName.includes('prod') ? 'prod' : (rawName.includes('uat') ? 'uat' : 'infra'),
          slot: rawName.includes('green') ? 'green' : (rawName.includes('blue') ? 'blue' : 'standalone'),
          status: container.state === 'running' ? 'running' : (container.state || 'active'),
          image: container.image,
          node_id: node_id,
          restarts: restartCount,
          container_id: container.id,
          container_name: rawName,
          container_status: container.status,
          last_deploy: null,
        });
      }
    }

    const services = Array.from(serviceMap.values());
    return new Response(JSON.stringify({ services, count: services.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Callback from agent to update deployment status
 */
async function handleUpdateDeployStatus(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const update = (await request.json()) as {
      deployment_id: string;
      service: string;
      status: 'success' | 'failed' | 'rolled_back';
      active_slot?: string;
      active_port?: number;
      message?: string;
      duration_ms?: number;
    };

    if (!update.deployment_id) {
      return new Response(JSON.stringify({ error: 'Missing deployment_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const nowIso = new Date().toISOString();
    let record = fleetDeployments.get(update.deployment_id);
    if (!record && env.FLEET_KV) {
      const raw = await env.FLEET_KV.get(`deployment:${update.deployment_id}`);
      if (raw) {
        try { record = JSON.parse(raw); } catch {}
      }
    }

    if (record) {
      record.status = update.status;
      record.active_slot = update.active_slot || record.active_slot;
      record.active_port = update.active_port || record.active_port;
      record.message = update.message || record.message;
      record.duration_ms = update.duration_ms || record.duration_ms;
      record.updated_at = nowIso;
      fleetDeployments.set(update.deployment_id, record);

      if (env.FLEET_KV) {
        ctx.waitUntil(safeKvPut(env.FLEET_KV, `deployment:${update.deployment_id}`, JSON.stringify(record)));
      }
    }

    // Broadcast status change
    broadcastTelemetry({
      type: 'deploy_status_updated',
      deployment: update,
    });

    const level = update.status === 'success' ? 'info' : 'error';
    const logRec: LogRecord = {
      id: `log_${Date.now()}_${update.deployment_id}`,
      timestamp: nowIso,
      time_iso: nowIso,
      level,
      service: update.service || 'flarelens-gitops',
      environment: record?.env || 'uat',
      message: `Deployment ${update.deployment_id} (${update.service}): ${update.status.toUpperCase()} -> ${update.message || ''}`,
      attributes: {
        deployment_id: update.deployment_id,
        service: update.service,
        status: update.status,
        active_slot: update.active_slot || '',
        duration_ms: update.duration_ms || 0,
      },
    };
    ringBuffer.push(logRec);
    if (ringBuffer.length > RING_BUFFER_MAX) ringBuffer.shift();
    broadcastSSE(logRec);

    return new Response(JSON.stringify({ status: 'updated', deployment_id: update.deployment_id }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * List database snapshots stored in R2 / KV
 */
async function handleListBackups(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const prefix = url.searchParams.get('prefix') || 'postgres/';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);

    const backups: any[] = [];
    const targetBucket = env.BACKUP_BUCKET || env.LOGS_BUCKET;

    // 1. List objects directly from R2
    if (targetBucket) {
      const listed = await targetBucket.list({
        prefix,
        limit,
      });

      for (const obj of listed.objects) {
        backups.push({
          key: obj.key,
          size: obj.size,
          uploaded: obj.uploaded,
          httpEtag: obj.httpEtag,
          customMetadata: obj.customMetadata,
        });
      }
    }

    // 2. Fetch recorded backups from KV
    const kvBackups: BackupRecord[] = [];
    if (env.FLEET_KV) {
      const rawList = await env.FLEET_KV.get('fleet:backups');
      if (rawList) {
        try {
          const keys: string[] = JSON.parse(rawList);
          const nowMs = Date.now();
          for (const k of keys) {
            const raw = await env.FLEET_KV.get(`backup:${k}`);
            if (raw) {
              const rec = JSON.parse(raw);
              // Clean up or skip stale "initiated" records older than 2 minutes
              if (rec.status === 'initiated') {
                const recMs = new Date(rec.timestamp).getTime();
                if (nowMs - recMs > 2 * 60 * 1000) continue;
              }
              kvBackups.push(rec);
            }
          }
        } catch {}
      }
    }

    return new Response(
      JSON.stringify({
        backups,
        recorded_backups: kvBackups,
        count: backups.length,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Trigger an on-demand database backup on a target node
 */
async function handleTriggerBackup(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const payload = (await request.json()) as BackupRequestPayload;
    if (!payload.node_id) {
      return new Response(JSON.stringify({ error: 'Missing required field: node_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const tag = payload.tag || 'manual';
    const nowIso = new Date().toISOString();
    const backupKey = `postgres/prod/${new Date().toISOString().replace(/[:.]/g, '-')}_${tag}.sql.gz`;

    const record: BackupRecord = {
      key: backupKey,
      bucket: 'flarelens-backups',
      timestamp: nowIso,
      tag,
      node_id: payload.node_id,
      status: 'initiated',
    };

    fleetBackups.set(backupKey, record);

    // 1. Enqueue in-memory command queue
    const cmd = {
      id: `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type: 'backup',
      node_id: payload.node_id,
      tag,
      key: backupKey,
      timestamp: nowIso,
    };
    const nodeCmds = inMemoryCommands.get(payload.node_id) || [];
    nodeCmds.push(cmd);
    inMemoryCommands.set(payload.node_id, nodeCmds);

    // 2. Persist to R2 Command Queue (1M free writes/month, globally synchronized across all Cloudflare PoPs)
    if (env.BACKUP_BUCKET) {
      ctx.waitUntil(
        env.BACKUP_BUCKET.put(
          `control/commands/${payload.node_id}/${cmd.id}.json`,
          JSON.stringify(cmd),
          { httpMetadata: { contentType: 'application/json' } }
        )
      );
    }

    if (env.FLEET_KV) {
      ctx.waitUntil(safeKvPut(env.FLEET_KV, `backup:${backupKey}`, JSON.stringify(record)));
      try {
        const rawList = await env.FLEET_KV.get('fleet:backups');
        const list: string[] = rawList ? JSON.parse(rawList) : [];
        if (!list.includes(backupKey)) {
          list.unshift(backupKey);
          if (list.length > 50) list.pop();
          ctx.waitUntil(safeKvPut(env.FLEET_KV, 'fleet:backups', JSON.stringify(list)));
        }

        const rawCmds = await env.FLEET_KV.get(`fleet:commands:${payload.node_id}`);
        const cmds: any[] = rawCmds ? JSON.parse(rawCmds) : [];
        cmds.push(cmd);
        ctx.waitUntil(safeKvPut(env.FLEET_KV, `fleet:commands:${payload.node_id}`, JSON.stringify(cmds)));
      } catch {}
    }

    // Broadcast to WebSocket and Live SSE
    broadcastTelemetry({
      type: 'backup_initiated',
      backup: record,
    });

    const backupLog: LogRecord = {
      id: `log_${Date.now()}_backup`,
      timestamp: nowIso,
      time_iso: nowIso,
      level: 'info',
      service: 'flarelens-backup',
      environment: 'production',
      message: `Database backup initiated on node ${payload.node_id} (tag: ${tag})`,
      attributes: {
        node_id: payload.node_id,
        tag,
        key: backupKey,
      },
    };
    ringBuffer.push(backupLog);
    if (ringBuffer.length > RING_BUFFER_MAX) ringBuffer.shift();
    broadcastSSE(backupLog);

    return new Response(JSON.stringify({ status: 'initiated', record }), {
      status: 202,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Trigger a database restore on a target node
 */
async function handleTriggerRestore(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const payload = (await request.json()) as RestoreRequestPayload;
    if (!payload.node_id || !payload.key) {
      return new Response(JSON.stringify({ error: 'Missing required fields: node_id, key' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const nowIso = new Date().toISOString();

    const cmd = {
      id: `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type: 'restore',
      node_id: payload.node_id,
      key: payload.key,
      target_db: payload.target_db || '',
      timestamp: nowIso,
    };
    const nodeCmds = inMemoryCommands.get(payload.node_id) || [];
    nodeCmds.push(cmd);
    inMemoryCommands.set(payload.node_id, nodeCmds);

    if (env.BACKUP_BUCKET) {
      ctx.waitUntil(
        env.BACKUP_BUCKET.put(
          `control/commands/${payload.node_id}/${cmd.id}.json`,
          JSON.stringify(cmd),
          { httpMetadata: { contentType: 'application/json' } }
        )
      );
    }

    if (env.FLEET_KV) {
      try {
        const rawCmds = await env.FLEET_KV.get(`fleet:commands:${payload.node_id}`);
        const cmds: any[] = rawCmds ? JSON.parse(rawCmds) : [];
        cmds.push(cmd);
        ctx.waitUntil(safeKvPut(env.FLEET_KV, `fleet:commands:${payload.node_id}`, JSON.stringify(cmds)));
      } catch {}
    }

    // Broadcast to WebSocket and Live SSE
    broadcastTelemetry({
      type: 'restore_initiated',
      restore: payload,
    });

    const restoreLog: LogRecord = {
      id: `log_${Date.now()}_restore`,
      timestamp: nowIso,
      time_iso: nowIso,
      level: 'warn',
      service: 'flarelens-backup',
      environment: 'production',
      message: `Database restore initiated on node ${payload.node_id} from snapshot ${payload.key} (target: ${payload.target_db || 'default'})`,
      attributes: {
        node_id: payload.node_id,
        key: payload.key,
        target_db: payload.target_db,
      },
    };
    ringBuffer.push(restoreLog);
    if (ringBuffer.length > RING_BUFFER_MAX) ringBuffer.shift();
    broadcastSSE(restoreLog);

    return new Response(JSON.stringify({ status: 'initiated', payload }), {
      status: 202,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Edge Agent Command Polling endpoint (GET /api/v1/control/commands?node_id=...)
 */
async function handleGetNodeCommands(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const nodeId = url.searchParams.get('node_id');
    if (!nodeId) {
      return new Response(JSON.stringify({ commands: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const commandMap = new Map<string, any>();

    // 1. Fetch commands from R2 queue (Globally synchronized across all Cloudflare PoPs, 1M writes/mo free)
    if (env.BACKUP_BUCKET) {
      try {
        const listed = await env.BACKUP_BUCKET.list({
          prefix: `control/commands/${nodeId}/`,
          limit: 20,
        });
        for (const obj of listed.objects) {
          const file = await env.BACKUP_BUCKET.get(obj.key);
          if (file) {
            const raw = await file.text();
            const parsed = JSON.parse(raw);
            commandMap.set(parsed.id, parsed);
          }
        }
      } catch {}
    }

    // 2. In-memory commands
    const memCmds = inMemoryCommands.get(nodeId) || [];
    for (const c of memCmds) {
      commandMap.set(c.id, c);
    }

    // 3. KV commands if available
    if (env.FLEET_KV) {
      try {
        const rawCmds = await env.FLEET_KV.get(`fleet:commands:${nodeId}`);
        if (rawCmds) {
          const kvCmds: any[] = JSON.parse(rawCmds);
          for (const c of kvCmds) {
            commandMap.set(c.id, c);
          }
        }
      } catch {}
    }

    const commands = Array.from(commandMap.values());

    return new Response(JSON.stringify({ commands }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ commands: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Edge Agent Command Acknowledgment endpoint (POST /api/v1/control/commands/ack?id=...&node_id=...)
 */
async function handleAckNodeCommand(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const cmdId = url.searchParams.get('id');
    const nodeId = url.searchParams.get('node_id');

    if (cmdId && nodeId) {
      // 1. Delete from R2 command queue
      if (env.BACKUP_BUCKET) {
        try {
          await env.BACKUP_BUCKET.delete(`control/commands/${nodeId}/${cmdId}.json`);
        } catch {}
      }

      // 2. Remove from in-memory
      const memCmds = inMemoryCommands.get(nodeId) || [];
      inMemoryCommands.set(nodeId, memCmds.filter(c => c.id !== cmdId));

      // 3. Remove from KV if present
      if (env.FLEET_KV) {
        try {
          const rawCmds = await env.FLEET_KV.get(`fleet:commands:${nodeId}`);
          if (rawCmds) {
            const cmds: any[] = JSON.parse(rawCmds);
            const filtered = cmds.filter((c: any) => c.id !== cmdId);
            await safeKvPut(env.FLEET_KV, `fleet:commands:${nodeId}`, JSON.stringify(filtered));
          }
        } catch {}
      }
    }

    return new Response(JSON.stringify({ status: 'ack' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ status: 'ack' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Callback from agent reporting backup or restore status
 */
async function handleUpdateBackupStatus(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const update = (await request.json()) as {
      key: string;
      status: 'completed' | 'failed';
      node_id?: string;
      tag?: string;
      size?: number;
      error?: string;
    };

    if (!update.key) {
      return new Response(JSON.stringify({ error: 'Missing key parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const nowIso = new Date().toISOString();
    let record = fleetBackups.get(update.key);
    if (!record && env.FLEET_KV) {
      const raw = await env.FLEET_KV.get(`backup:${update.key}`);
      if (raw) {
        try { record = JSON.parse(raw); } catch {}
      }
    }

    if (record) {
      record.status = update.status;
      if (update.size) record.size = update.size;
      if (update.error) record.error = update.error;
      fleetBackups.set(update.key, record);

      if (env.FLEET_KV) {
        ctx.waitUntil(safeKvPut(env.FLEET_KV, `backup:${update.key}`, JSON.stringify(record)));
      }
    }

    // Broadcast status change
    broadcastTelemetry({
      type: 'backup_status_updated',
      backup: update,
    });

    const level = update.status === 'completed' ? 'info' : 'error';
    const logRec: LogRecord = {
      id: `log_${Date.now()}_backup_status`,
      timestamp: nowIso,
      time_iso: nowIso,
      level,
      service: 'flarelens-backup',
      environment: 'production',
      message: `Database backup ${update.key}: ${update.status.toUpperCase()}${update.error ? ` - ${update.error}` : ''}`,
      attributes: {
        key: update.key,
        status: update.status,
        node_id: update.node_id,
        size: update.size,
      },
    };
    ringBuffer.push(logRec);
    if (ringBuffer.length > RING_BUFFER_MAX) ringBuffer.shift();
    broadcastSSE(logRec);

    return new Response(JSON.stringify({ status: 'updated', key: update.key }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * List services that have encrypted secrets stored in Vault
 */
async function handleListVaultSecrets(env: Env): Promise<Response> {
  try {
    const list: VaultMetadata[] = [];
    if (env.FLEET_KV) {
      const rawList = await env.FLEET_KV.get('fleet:vault:services');
      if (rawList) {
        try {
          const services: string[] = JSON.parse(rawList);
          for (const s of services) {
            const rawVault = await env.FLEET_KV.get(`vault:${s}`);
            if (rawVault) {
              const enc = JSON.parse(rawVault) as EncryptedVaultPayload;
              list.push({
                service: enc.service,
                env: enc.env || 'production',
                updated_at: enc.updated_at,
                keys_count: enc.keys_count || 0,
              });
            }
          }
        } catch {}
      } else {
        const kvList = await env.FLEET_KV.list({ prefix: 'vault:' });
        for (const k of kvList.keys) {
          const raw = await env.FLEET_KV.get(k.name);
          if (raw) {
            const enc = JSON.parse(raw) as EncryptedVaultPayload;
            list.push({
              service: enc.service,
              env: enc.env || 'production',
              updated_at: enc.updated_at,
              keys_count: enc.keys_count || 0,
            });
          }
        }
      }
    }

    return new Response(JSON.stringify({ services: list, count: list.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Get decrypted secrets for an authorized service
 */
async function handleGetVaultSecrets(service: string, env: Env, envName?: string): Promise<Response> {
  try {
    if (!env.FLEET_KV) {
      return new Response(JSON.stringify({ error: 'FLEET_KV not configured' }), { status: 500 });
    }

    const lookupKeys = getVaultLookupKeys(service, envName);
    let raw: string | null = null;
    let matchedVaultKey = '';

    for (const k of lookupKeys) {
      raw = await env.FLEET_KV.get(k);
      if (raw) {
        matchedVaultKey = k;
        break;
      }
    }

    if (!raw) {
      return new Response(JSON.stringify({ error: `No secrets found for service: ${service} (checked keys: ${lookupKeys.join(', ')})` }), { status: 404 });
    }

    const encPayload = JSON.parse(raw) as EncryptedVaultPayload;
    const masterKey = env.VAULT_MASTER_KEY || env.INGEST_SECRET || 'flarelens-default-vault-key';
    const secrets = await decryptSecrets(encPayload, masterKey);

    return new Response(
      JSON.stringify({
        service: encPayload.service || service,
        env: encPayload.env || envName || 'production',
        updated_at: encPayload.updated_at,
        keys_count: Object.keys(secrets).length,
        matched_vault_key: matchedVaultKey,
        secrets,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Store encrypted secrets for a service
 */
async function handleSaveVaultSecrets(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    if (!env.FLEET_KV) {
      return new Response(JSON.stringify({ error: 'FLEET_KV not configured' }), { status: 500 });
    }

    const payload = (await request.json()) as {
      service: string;
      secrets: Record<string, string>;
      env?: string;
    };

    if (!payload.service || !payload.secrets || typeof payload.secrets !== 'object') {
      return new Response(JSON.stringify({ error: 'Missing required fields: service, secrets' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const masterKey = env.VAULT_MASTER_KEY || env.INGEST_SECRET || 'flarelens-default-vault-key';
    const encrypted = await encryptSecrets(payload.service, payload.secrets, masterKey, payload.env || 'production');

    await safeKvPut(env.FLEET_KV, `vault:${payload.service}`, JSON.stringify(encrypted));

    // Update index list
    try {
      const rawList = await env.FLEET_KV.get('fleet:vault:services');
      const list: string[] = rawList ? JSON.parse(rawList) : [];
      if (!list.includes(payload.service)) {
        list.push(payload.service);
        await safeKvPut(env.FLEET_KV, 'fleet:vault:services', JSON.stringify(list));
      }
    } catch {}

    const logRec: LogRecord = {
      id: `vault_${Date.now()}_${payload.service}`,
      timestamp: new Date().toISOString(),
      time_iso: new Date().toISOString(),
      level: 'info',
      service: 'flarelens-vault',
      environment: payload.env || 'production',
      message: `Secrets encrypted (AES-256-GCM) and updated for service: ${payload.service} (${encrypted.keys_count} keys)`,
      attributes: {
        service: payload.service,
        keys_count: encrypted.keys_count,
      },
    };
    ringBuffer.push(logRec);
    if (ringBuffer.length > RING_BUFFER_MAX) ringBuffer.shift();
    broadcastSSE(logRec);

    return new Response(
      JSON.stringify({
        status: 'saved',
        service: payload.service,
        keys_count: encrypted.keys_count,
        updated_at: encrypted.updated_at,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Import raw .env file content directly into encrypted Vault
 */
async function handleImportEnvSecrets(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    if (!env.FLEET_KV) {
      return new Response(JSON.stringify({ error: 'FLEET_KV not configured' }), { status: 500 });
    }

    const payload = (await request.json()) as {
      service: string;
      env_content: string;
      env?: string;
      auto_deploy?: boolean;
    };

    if (!payload.service || !payload.env_content) {
      return new Response(JSON.stringify({ error: 'Missing required fields: service, env_content' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const parsed = parseEnvContent(payload.env_content);
    const keyCount = Object.keys(parsed).length;
    if (keyCount === 0) {
      return new Response(JSON.stringify({ error: 'No valid key-value pairs parsed from .env content' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const masterKey = env.VAULT_MASTER_KEY || env.INGEST_SECRET || 'flarelens-default-vault-key';
    const encrypted = await encryptSecrets(payload.service, parsed, masterKey, payload.env || 'production');

    await safeKvPut(env.FLEET_KV, `vault:${payload.service}`, JSON.stringify(encrypted));

    // Update index list
    try {
      const rawList = await env.FLEET_KV.get('fleet:vault:services');
      const list: string[] = rawList ? JSON.parse(rawList) : [];
      if (!list.includes(payload.service)) {
        list.push(payload.service);
        await safeKvPut(env.FLEET_KV, 'fleet:vault:services', JSON.stringify(list));
      }
    } catch {}

    // Auto-trigger Blue/Green zero-downtime deployment if requested
    let triggeredDeployId: string | null = null;
    if (payload.auto_deploy) {
      const cleanService = payload.service.replace(/-(uat|prod|production|dev|infra|infrastructure)$/, '');
      const targetEnv = payload.env || (payload.service.includes('prod') ? 'production' : 'uat');
      let targetNode = 'node-1';
      let targetImage = '';

      // 1. Check in-memory fleetDeployments
      for (const [_, dep] of fleetDeployments.entries()) {
        if ((dep.service === payload.service || dep.service === cleanService) && dep.image) {
          targetImage = dep.image;
          targetNode = dep.node_id || targetNode;
          break;
        }
      }

      // 2. Check KV deployment history if in-memory was empty
      if (!targetImage && env.FLEET_KV) {
        try {
          const rawDeps = await env.FLEET_KV.get('fleet:deployments');
          if (rawDeps) {
            const ids: string[] = JSON.parse(rawDeps);
            for (const id of ids) {
              const raw = await env.FLEET_KV.get(`deployment:${id}`);
              if (raw) {
                const dep: DeploymentRecord = JSON.parse(raw);
                if ((dep.service === payload.service || dep.service === cleanService) && dep.image) {
                  targetImage = dep.image;
                  targetNode = dep.node_id || targetNode;
                  break;
                }
              }
            }
          }
        } catch {}
      }

      if (targetImage) {
        const deployReq = new Request('https://internal/api/v1/control/deploy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            service: cleanService,
            image: targetImage,
            node_id: targetNode,
            env: targetEnv,
            secrets: parsed,
          }),
        });
        const deployResp = await handleTriggerDeploy(deployReq, env, ctx);
        if (deployResp.ok) {
          const depData = (await deployResp.json()) as any;
          triggeredDeployId = depData.deployment_id || (depData.deployments && depData.deployments[0]?.deployment_id);
        }
      }
    }

    return new Response(
      JSON.stringify({
        status: 'imported',
        service: payload.service,
        keys_count: keyCount,
        parsed_keys: Object.keys(parsed),
        auto_deploy: Boolean(payload.auto_deploy),
        updated_at: encrypted.updated_at,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Delete secrets for a service
 */
async function handleDeleteVaultSecrets(service: string, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    if (!env.FLEET_KV) {
      return new Response(JSON.stringify({ error: 'FLEET_KV not configured' }), { status: 500 });
    }

    try {
      await env.FLEET_KV.delete(`vault:${service}`);
    } catch {}

    try {
      const rawList = await env.FLEET_KV.get('fleet:vault:services');
      if (rawList) {
        const list: string[] = JSON.parse(rawList);
        const filtered = list.filter((s) => s !== service);
        await safeKvPut(env.FLEET_KV, 'fleet:vault:services', JSON.stringify(filtered));
      }
    } catch {}

    return new Response(JSON.stringify({ status: 'deleted', service }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Zero-Trust Sovereign Mesh: Get status of Coordinator, Subnet & DERP Relays
 */
async function handleMeshGetStatus(env: Env): Promise<Response> {
  try {
    const peers = await loadAllMeshPeers(env);
    const directCount = peers.filter(p => p.connection_type !== 'derp_relay').length;
    const derpCount = peers.filter(p => p.connection_type === 'derp_relay').length;

    return new Response(JSON.stringify({
      status: 'operational',
      subnet: MESH_SUBNET,
      coordinator_url: COORDINATOR_URL,
      magic_dns_suffix: MAGIC_DNS_SUFFIX,
      derp_regions: DERP_REGIONS,
      stats: {
        total_peers: peers.length,
        direct_p2p: directCount,
        derp_relay: derpCount,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Zero-Trust Sovereign Mesh: Register node peer with 100.64.0.x CGNAT & MagicDNS
 */
async function handleMeshRegister(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const payload = (await request.json()) as MeshRegisterPayload;
    if (!payload.node_id) {
      return new Response(JSON.stringify({ error: 'Missing required field: node_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const allPeers = await loadAllMeshPeers(env);
    const nowIso = new Date().toISOString();
    const cleanName = (payload.hostname || payload.name || payload.node_id).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const magicDns = `${cleanName}${MAGIC_DNS_SUFFIX}`;

    let peer = allPeers.find((p) => p.id === payload.node_id);
    if (peer) {
      peer.name = payload.name || peer.name;
      peer.hostname = payload.hostname || peer.hostname || cleanName;
      peer.magic_dns = magicDns;
      peer.public_key = payload.public_key || peer.public_key || '';
      peer.node_key = payload.node_key || peer.node_key;
      peer.endpoint = payload.endpoint || peer.endpoint;
      peer.listen_port = payload.listen_port || peer.listen_port || 51820;
      peer.connection_type = payload.connection_type || peer.connection_type || 'direct_p2p';
      peer.os = payload.os || peer.os;
      peer.client_version = payload.client_version || peer.client_version;
      if (payload.ssh_public_key) {
        peer.ssh_public_key = payload.ssh_public_key;
      }
      peer.online = true;
      peer.last_seen = nowIso;
      peer.updated_at = nowIso;
    } else {
      const overlayIp = allocateMeshIP(allPeers, 'node');
      peer = {
        id: payload.node_id,
        name: payload.name || payload.node_id,
        hostname: payload.hostname || cleanName,
        magic_dns: magicDns,
        tailscale_ip: overlayIp,
        overlay_ip: overlayIp,
        public_key: payload.public_key || '',
        ssh_public_key: payload.ssh_public_key || '',
        node_key: payload.node_key,
        endpoint: payload.endpoint,
        listen_port: payload.listen_port || 51820,
        connection_type: payload.connection_type || 'direct_p2p',
        os: payload.os || 'linux',
        client_version: payload.client_version || 'flarelens-mesh/v1.0',
        type: 'node',
        online: true,
        created_at: nowIso,
        updated_at: nowIso,
        last_seen: nowIso,
      };
      allPeers.push(peer);
    }

    fleetMeshPeers.set(peer.id, peer);
    if (env.FLEET_KV) {
      ctx.waitUntil(safeKvPut(env.FLEET_KV, `mesh:peer:${peer.id}`, JSON.stringify(peer)));
      const idList = allPeers.map((p) => p.id);
      ctx.waitUntil(safeKvPut(env.FLEET_KV, 'mesh:peers', JSON.stringify(idList)));
    }

    broadcastTelemetry({
      type: 'mesh_peer_updated',
      peer,
      peers_count: allPeers.length,
    });

    return new Response(JSON.stringify({
      status: 'registered',
      peer,
      subnet: MESH_SUBNET,
      coordinator_url: COORDINATOR_URL,
      magic_dns_suffix: MAGIC_DNS_SUFFIX,
      peers: allPeers,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Zero-Trust Sovereign Mesh: List all active peers
 */
async function handleMeshListPeers(env: Env): Promise<Response> {
  try {
    const peers = await loadAllMeshPeers(env);
    return new Response(JSON.stringify({
      subnet: MESH_SUBNET,
      coordinator_url: COORDINATOR_URL,
      magic_dns_suffix: MAGIC_DNS_SUFFIX,
      derp_regions: DERP_REGIONS,
      peers,
      count: peers.length,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Zero-Trust Sovereign Mesh: Generate Tailscale Pre-Auth Key
 */
async function handleMeshCreatePreAuthKey(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as any;
    const cfUser = request.headers.get('cf-access-authenticated-user-email') || body.user || 'operator';

    const keyRecord = generatePreAuthKey({
      user: cfUser,
      reusable: body.reusable ?? true,
      ephemeral: body.ephemeral ?? false,
      expiresDays: body.expires_days || 90,
      tags: body.tags || ['tag:fleet'],
    });

    if (env.FLEET_KV) {
      ctx.waitUntil(safeKvPut(env.FLEET_KV, `mesh:preauth_key:${keyRecord.id}`, JSON.stringify(keyRecord)));
    }

    const connectCommand = buildTailscaleConnectCommand(keyRecord.key, {
      hostname: body.hostname,
      isSubnetRouter: body.is_subnet_router,
    });

    return new Response(JSON.stringify({
      status: 'created',
      key: keyRecord,
      coordinator_url: COORDINATOR_URL,
      connect_command: connectCommand,
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Zero-Trust Sovereign Mesh: Enroll client or gateway device
 */
async function handleMeshCreateClient(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const payload = (await request.json()) as MeshCreateClientPayload;
    if (!payload.name) {
      return new Response(JSON.stringify({ error: 'Missing client name' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const allPeers = await loadAllMeshPeers(env);
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const nowIso = new Date().toISOString();
    const cleanName = (payload.hostname || payload.name).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const magicDns = `${cleanName}${MAGIC_DNS_SUFFIX}`;

    let privKey = '';
    let pubKey = payload.public_key || '';

    if (!pubKey) {
      const generated = generateWireGuardKeypair();
      privKey = generated.privateKey;
      pubKey = generated.publicKey;
    }

    const overlayIp = allocateMeshIP(allPeers, payload.device_type || 'client');
    const cfUser = request.headers.get('cf-access-authenticated-user-email');

    // Generate dedicated Tailscale Pre-Auth key
    const authKeyRecord = generatePreAuthKey({
      user: cfUser || 'admin',
      reusable: payload.reusable ?? false,
      ephemeral: payload.ephemeral ?? false,
      tags: payload.tags || ['tag:client'],
    });

    const clientPeer: MeshPeerRecord = {
      id: clientId,
      name: payload.name,
      hostname: cleanName,
      magic_dns: magicDns,
      tailscale_ip: overlayIp,
      overlay_ip: overlayIp,
      public_key: pubKey,
      ssh_public_key: payload.ssh_public_key || '',
      connection_type: 'direct_p2p',
      type: payload.device_type || 'client',
      created_by: cfUser || 'admin',
      created_at: nowIso,
      updated_at: nowIso,
      last_seen: nowIso,
      online: true,
      tags: payload.tags || ['tag:client'],
    };

    allPeers.push(clientPeer);
    fleetMeshPeers.set(clientPeer.id, clientPeer);

    if (env.FLEET_KV) {
      ctx.waitUntil(safeKvPut(env.FLEET_KV, `mesh:peer:${clientPeer.id}`, JSON.stringify(clientPeer)));
      ctx.waitUntil(safeKvPut(env.FLEET_KV, `mesh:preauth_key:${authKeyRecord.id}`, JSON.stringify(authKeyRecord)));
      const idList = allPeers.map((p) => p.id);
      ctx.waitUntil(safeKvPut(env.FLEET_KV, 'mesh:peers', JSON.stringify(idList)));
      if (privKey) {
        ctx.waitUntil(safeKvPut(env.FLEET_KV, `mesh:client_priv:${clientPeer.id}`, privKey, { expirationTtl: 86400 * 30 }));
      }
    }

    const nodePeers = allPeers.filter((p) => p.type === 'node' || p.type === 'gateway');
    const wireguardConf = privKey ? buildWireGuardClientConfig(clientPeer, privKey, nodePeers) : '';
    const agentCmd = buildAgentConnectCommand(authKeyRecord.key, { hostname: cleanName });
    const tailscaleCmd = buildTailscaleConnectCommand(authKeyRecord.key, { hostname: cleanName });
    const gatewayPeerIp = nodePeers[0]?.endpoint ? nodePeers[0].endpoint.split(':')[0] : undefined;
    const mikrotikConfig = buildMikroTikConfig(authKeyRecord.key, cleanName, overlayIp, gatewayPeerIp);

    broadcastTelemetry({
      type: 'mesh_peer_updated',
      peer: clientPeer,
      peers_count: allPeers.length,
    });

    return new Response(JSON.stringify({
      status: 'created',
      peer: clientPeer,
      auth_key: authKeyRecord.key,
      coordinator_url: COORDINATOR_URL,
      agent_command: agentCmd,
      connect_command: agentCmd,
      tailscale_command: tailscaleCmd,
      mikrotik_config: mikrotikConfig,
      private_key: privKey,
      config: wireguardConf,
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Zero-Trust Sovereign Mesh: Download fallback client .conf profile
 */
async function handleMeshGetClientConfig(clientId: string, env: Env): Promise<Response> {
  try {
    const allPeers = await loadAllMeshPeers(env);
    const client = allPeers.find((p) => p.id === clientId);
    if (!client) {
      return new Response('Client peer not found', { status: 404 });
    }

    let privKey = '<YOUR_PRIVATE_KEY>';
    if (env.FLEET_KV) {
      const stored = await env.FLEET_KV.get(`mesh:client_priv:${clientId}`);
      if (stored) privKey = stored;
    }

    const nodePeers = allPeers.filter((p) => p.type === 'node' || p.type === 'gateway');
    const conf = buildWireGuardClientConfig(client, privKey, nodePeers);

    return new Response(conf, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="flarelens-${client.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.conf"`,
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err: any) {
    return new Response((err as Error).message, { status: 500 });
  }
}

/**
 * Zero-Trust Sovereign Mesh: Delete peer
 */
async function handleMeshDeletePeer(peerId: string, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    fleetMeshPeers.delete(peerId);
    if (env.FLEET_KV) {
      try {
        ctx.waitUntil(env.FLEET_KV.delete(`mesh:peer:${peerId}`));
        ctx.waitUntil(env.FLEET_KV.delete(`mesh:client_priv:${peerId}`));
      } catch {}
      const allPeers = await loadAllMeshPeers(env);
      const filtered = allPeers.filter((p) => p.id !== peerId);
      ctx.waitUntil(safeKvPut(env.FLEET_KV, 'mesh:peers', JSON.stringify(filtered.map((p) => p.id))));
    }

    broadcastTelemetry({
      type: 'mesh_peer_removed',
      peer_id: peerId,
    });

    return new Response(JSON.stringify({ status: 'deleted', id: peerId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * Helper to load all mesh peers from KV and in-memory cache
 */
async function loadAllMeshPeers(env: Env): Promise<MeshPeerRecord[]> {
  const peers: MeshPeerRecord[] = [];
  if (env.FLEET_KV) {
    try {
      const rawList = await env.FLEET_KV.get('mesh:peers');
      if (rawList) {
        const ids: string[] = JSON.parse(rawList);
        for (const id of ids) {
          const rawPeer = await env.FLEET_KV.get(`mesh:peer:${id}`);
          if (rawPeer) peers.push(JSON.parse(rawPeer));
        }
      }
    } catch {}
  }

  for (const [id, p] of fleetMeshPeers.entries()) {
    if (!peers.some((x) => x.id === id)) {
      peers.push(p);
    }
  }

  return peers;
}

/**
 * Serves Linux / Windows bootstrap installer scripts with appropriate MIME headers
 */
async function handleInstallScript(request: Request, env: Env, type: 'sh' | 'ps1'): Promise<Response> {
  const contentType = type === 'sh' ? 'text/x-shellscript; charset=utf-8' : 'text/plain; charset=utf-8';
  if (env.ASSETS) {
    const assetResp = await env.ASSETS.fetch(request);
    if (assetResp.status === 200) {
      const headers = new Headers(assetResp.headers);
      headers.set('Content-Type', contentType);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(assetResp.body, { status: 200, headers });
    }
  }

  // Fallback: minimal bootstrap script
  const origin = new URL(request.url).origin;
  if (type === 'sh') {
    return new Response(
      `#!/usr/bin/env bash\nset -euo pipefail\necho "[*] Fetching FlareLens from ${origin}..."\nmkdir -p /opt/flarelens/bin\ncurl -fsSL "${origin}/api/v1/agent/binary/linux-amd64" -o /opt/flarelens/bin/flarelens-agent\nchmod +x /opt/flarelens/bin/flarelens-agent\necho "[+] Installed /opt/flarelens/bin/flarelens-agent"`,
      { status: 200, headers: { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' } }
    );
  } else {
    return new Response(
      `Write-Host "[*] Fetching FlareLens Windows agent from ${origin}..."\nNew-Item -ItemType Directory -Path "$env:ProgramFiles\\FlareLens" -Force | Out-Null\nInvoke-WebRequest -Uri "${origin}/api/v1/agent/binary/windows-amd64" -OutFile "$env:ProgramFiles\\FlareLens\\flarelens.exe" -UseBasicParsing\nWrite-Host "[+] Installed flarelens.exe"`,
      { status: 200, headers: { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' } }
    );
  }
}

/**
 * Serves compiled agent binaries from Cloudflare R2
 */
async function handleAgentBinary(target: string, env: Env): Promise<Response> {
  const binaryKey = `binaries/flarelens-agent-${target}`;
  if (env.LOGS_BUCKET) {
    const obj = await env.LOGS_BUCKET.get(binaryKey);
    if (obj) {
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('etag', obj.httpEtag);
      headers.set('Content-Type', 'application/octet-stream');
      headers.set('Content-Disposition', `attachment; filename="flarelens-agent-${target}"`);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(obj.body, { headers });
    }
  }

  // Fallback: Redirect to GitHub release asset
  return Response.redirect(`https://github.com/antwig2/flarelens/releases/download/v0.1.0/flarelens-agent-${target}`, 302);
}

