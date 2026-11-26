import assert from 'node:assert';
import { Database } from 'bun:sqlite';
import worker from './src/index.ts';

function createMockD1() {
  const sqlite = new Database(':memory:');
  function makeStmt(sql, bound = []) {
    return {
      sql,
      bound,
      bind(...args) {
        return makeStmt(sql, args);
      },
      async run() {
        sqlite.prepare(sql).run(...bound);
        return { success: true, meta: {} };
      },
      async first() {
        const row = sqlite.prepare(sql).get(...bound);
        return row ?? null;
      },
      async all() {
        const results = sqlite.prepare(sql).all(...bound);
        return { success: true, results };
      },
    };
  }
  return {
    sqlite,
    prepare(sql) {
      return makeStmt(sql);
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) {
        sqlite.prepare(s.sql).run(...s.bound);
        out.push({ success: true });
      }
      return out;
    },
  };
}

function createMockKV() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, val) {
      store.set(key, String(val));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const keys = [];
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) keys.push({ name: k });
      }
      return { keys };
    },
  };
}

function createMockR2() {
  const objects = new Map();
  let listCalls = 0;
  return {
    get listCalls() {
      return listCalls;
    },
    resetListCalls() {
      listCalls = 0;
    },
    async put(key, body, opts = {}) {
      const buf = body instanceof ArrayBuffer ? Buffer.from(body) : Buffer.from(String(body));
      objects.set(key, { buf, opts });
    },
    async get(key) {
      const item = objects.get(key);
      if (!item) return null;
      return {
        body: item.buf,
        async text() {
          return item.buf.toString('utf8');
        },
        httpEtag: '"mock-etag"',
        writeHttpMetadata() {},
      };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = '' } = {}) {
      listCalls++;
      const res = [];
      for (const [k] of objects.entries()) {
        if (k.startsWith(prefix)) res.push({ key: k });
      }
      return { objects: res };
    },
  };
}

async function runTests() {
  console.log('🧪 Running FlareLens Open-Source Control Plane D1 & Piggyback Suite...\n');

  const kv = createMockKV();
  const logsBucket = createMockR2();
  const backupBucket = createMockR2();
  const controlDb = createMockD1();

  // Seed legacy KV state to verify seamless one-time D1 hydration + deduplication
  await kv.put('fleet:nodes', JSON.stringify(['node-alpha', 'node-alpha']));
  await kv.put(
    'node:node-alpha',
    JSON.stringify({
      node_id: 'node-alpha',
      hostname: 'alpha-1',
      provider: 'baremetal',
      region: 'eu-central',
      tags: ['prod'],
      status: 'Healthy',
      version: '0.2.1',
      last_heartbeat: Date.now(),
      enrolled_at: '2026-11-14T00:00:00.000Z',
    })
  );
  await kv.put('mesh:peers', JSON.stringify(['peer-1', 'peer-1', 'peer-1']));
  await kv.put(
    'mesh:peer:peer-1',
    JSON.stringify({
      id: 'peer-1',
      name: 'workstation-1',
      overlay_ip: '100.64.0.10',
      public_key: 'wg-pub-1',
      type: 'client',
      online: true,
    })
  );

  const pendingWaitTasks = [];
  const ctx = {
    waitUntil(p) {
      pendingWaitTasks.push(Promise.resolve(p));
    },
  };
  const env = {
    CONTROL_DB: controlDb,
    FLEET_KV: kv,
    LOGS_BUCKET: logsBucket,
    BACKUP_BUCKET: backupBucket,
    INGEST_SECRET: 'test-ingest-secret',
    ENROLL_TOKEN: 'test-enroll-token',
    DASHBOARD_PASSWORD: 'test-admin-password',
    WEBHOOK_SECRET: 'test-webhook-secret',
  };

  console.log('1️⃣  Testing D1 State Hydration, Mesh Deduplication & Webhook Enqueue...');
  const deployRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/deploy/webhook', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-webhook-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        service: 'web-api',
        env: 'production',
        node_id: 'node-alpha',
        image: 'ghcr.io/example/web-api:v1.2.0',
      }),
    }),
    env,
    ctx
  );
  assert.strictEqual(deployRes.status, 202, 'Deploy webhook should enqueue command into D1');
  const peerCnt = controlDb.sqlite.prepare('SELECT COUNT(*) AS cnt FROM mesh_peers').get();
  assert.strictEqual(peerCnt.cnt, 1, 'Duplicate mesh peers from KV must deduplicate to 1 row in D1');
  console.log('   ✅ Passed: D1 hydrated, mesh peers deduplicated, and deploy queued.\n');

  console.log('2️⃣  Testing Zero R2.list() Polling & Piggybacked 15s Heartbeat Response...');
  backupBucket.resetListCalls();
  const hbRes1 = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/ingest', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-ingest-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        node_id: 'node-alpha',
        timestamp: new Date().toISOString(),
        status: 'Healthy',
        docker_healthy: true,
        metrics: { cpu_usage_pct: 9.5, ram_used_bytes: 1e9, ram_usage_pct: 25.0, disk_usage_pct: 20.0 },
        containers: [],
      }),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));
  assert.strictEqual(hbRes1.status, 202);
  const hbBody1 = await hbRes1.json();
  assert.strictEqual(hbBody1.commands.length, 1, 'Heartbeat must piggyback pending D1 command');
  assert.ok(typeof hbBody1.flags_version === 'string' && hbBody1.flags_version.length > 0);
  assert.strictEqual(backupBucket.listCalls, 0, 'Heartbeat must perform 0 R2.list() Class A calls');

  // Verify agent can fetch flags with ENROLL_TOKEN even when DASHBOARD_PASSWORD is set
  const agentFlagsRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/flags', {
      headers: { Authorization: 'Bearer test-enroll-token' },
    }),
    env,
    ctx
  );
  assert.strictEqual(agentFlagsRes.status, 200, 'Agent ENROLL_TOKEN must be permitted on GET /api/v1/control/flags');

  // Verify least-privilege: ENROLL_TOKEN must NOT access admin Secrets Vault
  const vaultDeniedRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/secrets', {
      headers: { Authorization: 'Bearer test-enroll-token' },
    }),
    env,
    ctx
  );
  assert.strictEqual(vaultDeniedRes.status, 401, 'Agent ENROLL_TOKEN must be rejected on admin Secrets Vault');
  console.log('   ✅ Passed: Piggybacked commands & flags_version delivered; least-privilege enforced.\n');

  console.log('3️⃣  Testing Query-Param Command Ack & Feature Flag Version Rotation...');
  const cmdId = hbBody1.commands[0].id;
  const initialVer = hbBody1.flags_version;

  const ackRes = await worker.fetch(
    new Request(
      `https://control.flarelens.dev/api/v1/control/commands/ack?node_id=node-alpha&id=${encodeURIComponent(cmdId)}`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-enroll-token' },
      }
    ),
    env,
    ctx
  );
  assert.strictEqual(ackRes.status, 200);

  const toggleRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/flags/toggle', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key: 'pre_deploy_snapshots', enabled: false }),
    }),
    env,
    ctx
  );
  assert.strictEqual(toggleRes.status, 200);

  const hbRes2 = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/ingest', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-ingest-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        node_id: 'node-alpha',
        timestamp: new Date().toISOString(),
        status: 'Healthy',
        docker_healthy: true,
        metrics: { cpu_usage_pct: 6.0, ram_used_bytes: 1e9, ram_usage_pct: 20.0, disk_usage_pct: 20.0 },
        containers: [],
      }),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));
  const hbBody2 = await hbRes2.json();
  assert.strictEqual(hbBody2.commands.length, 0, 'Acked command must be removed from D1');
  assert.notStrictEqual(hbBody2.flags_version, initialVer, 'Flag toggle must rotate flags_version');
  assert.strictEqual(backupBucket.listCalls, 0);
  console.log('   ✅ Passed: Command ACK cleared D1 row and flag toggle rotated flags_version.\n');

  console.log('4️⃣  Testing Declarative Fleet GitOps (adopt_only + Suspended) & Agent OTA Rollouts...');
  // Report a running edge-proxy container on node-alpha
  await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/ingest', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-ingest-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        node_id: 'node-alpha',
        timestamp: new Date().toISOString(),
        status: 'Healthy',
        docker_healthy: true,
        metrics: { cpu_usage_pct: 5.0, ram_used_bytes: 1e9, ram_usage_pct: 20.0, disk_usage_pct: 20.0 },
        containers: [
          {
            id: 'ctr-proxy',
            names: ['/edge-proxy'],
            image: 'traefik:v3.2',
            state: 'running',
            status: 'Up 10m',
            created: 1,
          },
        ],
      }),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));

  const syncRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/sync', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-ingest-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        commit_sha: 'abc1234',
        reconcile: true,
        manifests: [
          {
            service: 'edge-proxy',
            env: 'infra',
            node_id: 'node-alpha',
            image: 'traefik:v3.2',
            container_name: 'edge-proxy',
            adopt_only: true,
          },
          {
            service: 'billing-api',
            env: 'prod',
            enabled: false,
            node_id: 'node-alpha',
            image: 'ghcr.io/my-org/billing-api:prod',
            container_port: 8080,
            host_port_blue: 9080,
            host_port_green: 9081,
          },
        ],
      }),
    }),
    env,
    ctx
  );
  assert.strictEqual(syncRes.status, 200);
  const syncBody = await syncRes.json();
  assert.strictEqual(syncBody.synced_count, 2);
  assert.strictEqual(syncBody.skipped_count, 1);
  assert.deepStrictEqual(syncBody.reconciled[0].adopted_nodes, ['node-alpha']);

  const whSuspRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/deploy/webhook', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        service: 'billing-api',
        image: 'ghcr.io/my-org/billing-api:2.1.0',
        env: 'production',
        node_id: 'node-alpha',
      }),
    }),
    env,
    ctx
  );
  assert.strictEqual(whSuspRes.status, 202);
  const whSuspBody = await whSuspRes.json();
  assert.strictEqual(whSuspBody.status, 'suspended');

  const fleetStRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/status', {
      headers: { Authorization: 'Bearer test-admin-password' },
    }),
    env,
    ctx
  );
  const fleetStBody = await fleetStRes.json();
  assert.strictEqual(fleetStBody.summary.synced, 1);
  assert.strictEqual(fleetStBody.summary.suspended, 1);

  const fakeBin = new Uint8Array(2048).fill(7);
  const pubOtaRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/agent/releases?version=0.5.0&target=linux-amd64', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-ingest-secret' },
      body: fakeBin,
    }),
    env,
    ctx
  );
  assert.strictEqual(pubOtaRes.status, 201);

  const trigOtaRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/agent/update', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ node_id: 'node-alpha', target: 'linux-amd64' }),
    }),
    env,
    ctx
  );
  assert.strictEqual(trigOtaRes.status, 202);
  const trigOtaBody = await trigOtaRes.json();
  assert.strictEqual(trigOtaBody.version, '0.5.0');
  assert.strictEqual(trigOtaBody.commands_queued, 1);
  console.log('   ✅ Passed: Fleet GitOps adopt_only + Suspended guard + Agent OTA verified.\n');

  console.log('5️⃣  Testing Zero-Git Fleet CRUD, Immutable D1+R2 Revisions, UAT→Prod Promotion & 1-Click Rollback...');
  const schemaRes = await worker.fetch(
    new Request('https://control.flarelens.dev/schemas/fleet.schema.json'),
    env,
    ctx
  );
  assert.strictEqual(schemaRes.status, 200, 'Public JSON schema must return 200 without auth');
  const schemaJson = await schemaRes.json();
  assert.strictEqual(schemaJson.type, 'object');

  const createRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/manifests', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        manifest: {
          service: 'orders-api',
          env: 'uat',
          enabled: true,
          image: 'ghcr.io/example/orders-api:1.0.0',
          domains: ['orders-uat.example.com'],
          container_port: 8080,
          host_port_blue: 8081,
          host_port_green: 8082,
          networks: ['app-uat', 'flarelens-edge'],
          env_vars: { JWT_SECRET_KEY: 'top-secret-1', LOG_LEVEL: 'info' },
        },
        reason: 'Created orders-api in UI without Git',
        reconcile: false,
      }),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));
  assert.strictEqual(createRes.status, 200);
  const createBody = await createRes.json();
  assert.strictEqual(createBody.created, true);
  const initialOrdersRev = createBody.revision.rev_id;
  const r2RevSnapshot = await backupBucket.get(`state/revisions/${initialOrdersRev}.json`);
  assert.ok(r2RevSnapshot, 'R2 state/revisions/rev-N.json snapshot must be written');

  const updateRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/manifests', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        manifest: {
          service: 'orders-api',
          env: 'uat',
          enabled: true,
          image: 'ghcr.io/example/orders-api:1.1.0',
          domains: ['orders-uat.example.com'],
          container_port: 8080,
          host_port_blue: 8081,
          host_port_green: 8082,
          networks: ['app-uat', 'flarelens-edge'],
          env_vars: { JWT_SECRET_KEY: 'top-secret-2', LOG_LEVEL: 'debug' },
        },
        reconcile: false,
      }),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));
  const updateBody = await updateRes.json();
  const diffStr = updateBody.revision.diff_summary.join(' | ');
  assert.ok(diffStr.includes('orders-api:1.0.0 → ghcr.io/example/orders-api:1.1.0'));
  assert.ok(!diffStr.includes('top-secret-2'), 'Sensitive env_vars must be masked in revision diff');

  // Promote uat/orders-api -> prod/orders-api (auto-offsets ports +1000 and swaps env tokens when prod doesn't exist yet)
  const promoteRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/promote', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ service: 'orders-api', from_env: 'uat', to_env: 'prod', reconcile: false }),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));
  assert.strictEqual(promoteRes.status, 200);
  const promoteBody = await promoteRes.json();
  assert.strictEqual(promoteBody.manifest.image, 'ghcr.io/example/orders-api:1.1.0');
  assert.strictEqual(promoteBody.manifest.host_port_blue, 9081);
  assert.deepStrictEqual(promoteBody.manifest.networks, ['app-prod', 'flarelens-edge']);

  // Delete uat/orders-api and restore via 1-click Rollback
  const delRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/manifests?env=uat&service=orders-api', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-admin-password' },
    }),
    env,
    ctx
  );
  assert.strictEqual(delRes.status, 200);

  const rbRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/rollback', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rev_id: initialOrdersRev, reconcile: false }),
    }),
    env,
    ctx
  );
  assert.strictEqual(rbRes.status, 200);
  const rbBody = await rbRes.json();
  assert.strictEqual(rbBody.manifest.image, 'ghcr.io/example/orders-api:1.0.0');

  const expRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/export?env=uat', {
      headers: { Authorization: 'Bearer test-admin-password' },
    }),
    env,
    ctx
  );
  assert.strictEqual(expRes.status, 200);
  const expBody = await expRes.json();
  assert.strictEqual(expBody.count, 1);
  console.log('   ✅ Passed: Zero-Git CRUD, D1+R2 revisions, UAT→Prod promotion, 1-click rollback & export verified!\n');

  // =========================================================================
  // 6. MULTI-SERVER PLACEMENT, WIREGUARD MESH ROUTING, DRAIN & AUTO-FAILOVER
  // =========================================================================
  console.log('6️⃣  Testing Multi-Server Placement, WireGuard Mesh Endpoints, Drain Fencing & Auto-Failover...');

  for (const [idx, nid] of ['pool-eu-1', 'pool-eu-2', 'pool-eu-3'].entries()) {
    const enrollNodeRes = await worker.fetch(
      new Request('https://control.flarelens.dev/api/v1/control/enroll', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-enroll-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          node_id: nid,
          hostname: `${nid}.internal`,
          provider: 'hetzner',
          region: 'eu-central',
          tags: ['staging', 'mesh'],
          specs: { cpus: 4, ram_total_bytes: 8_589_934_592 },
          mesh: { tailscale_ip: `100.64.0.${31 + idx}`, public_key: `wg-pub-${nid}` },
        }),
      }),
      env,
      ctx
    );
    assert.strictEqual(enrollNodeRes.status, 200);

    const hbPoolRes = await worker.fetch(
      new Request('https://control.flarelens.dev/api/v1/ingest', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-ingest-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          node_id: nid,
          timestamp: new Date().toISOString(),
          status: 'Healthy',
          docker_healthy: true,
          metrics: {
            cpu_usage_pct: 10 + idx * 5,
            ram_used_bytes: 1_500_000_000,
            ram_total_bytes: 8_589_934_592,
            ram_usage_pct: 17.5,
            disk_usage_pct: 20.0,
          },
          containers: [],
        }),
      }),
      env,
      ctx
    );
    assert.strictEqual(hbPoolRes.status, 202);
  }

  // Stateful PostgreSQL singleton pinned to pool-eu-1
  const dbCreateRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/manifests', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        manifest: {
          service: 'postgres',
          env: 'staging',
          mode: 'singleton',
          image: 'postgres:18',
          node_id: 'pool-eu-1',
          placement_strategy: 'pinned',
          memory_mb: 1024,
          aliases: ['postgres-staging'],
          ports: ['127.0.0.1:5432:5432'],
        },
        reconcile: true,
      }),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));
  assert.strictEqual(dbCreateRes.status, 200);

  // Stateless 2-replica Blue/Green API with HA anti-affinity spread across EU pool
  const appSpreadRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/manifests', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        manifest: {
          service: 'checkout-api',
          env: 'staging',
          image: 'ghcr.io/example/checkout-api:2.0.0',
          domains: ['checkout.example.com'],
          replicas: 2,
          memory_mb: 512,
          cpu_cores: 1.25,
          placement_strategy: 'spread',
          required_tags: ['staging'],
          container_port: 8080,
          host_port_blue: 8281,
          host_port_green: 8282,
          health_path: '/health',
          networks: ['app-staging', 'flarelens-edge'],
        },
        reconcile: true,
      }),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));
  assert.strictEqual(appSpreadRes.status, 200);

  const plListRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/placements?env=staging', {
      headers: { Authorization: 'Bearer test-admin-password' },
    }),
    env,
    ctx
  );
  assert.strictEqual(plListRes.status, 200);
  const plListBody = await plListRes.json();
  const appPlacements = plListBody.placements.filter((p) => p.service === 'checkout-api');
  assert.strictEqual(appPlacements.length, 2, '2 replicas must be scheduled across distinct nodes');
  const distinctAppNodes = new Set(appPlacements.map((p) => p.node_id));
  assert.strictEqual(distinctAppNodes.size, 2, 'spread strategy must enforce anti-affinity');

  // Inspect piggybacked heartbeat on remote replica node (not pool-eu-1)
  const remoteNodeId = [...distinctAppNodes].find((n) => n !== 'pool-eu-1') || [...distinctAppNodes][0];
  const siblingNodeId = [...distinctAppNodes].find((n) => n !== remoteNodeId);
  const siblingPlacement = appPlacements.find((p) => p.node_id === siblingNodeId);

  const hbRemoteRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/ingest', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-ingest-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        node_id: remoteNodeId,
        timestamp: new Date().toISOString(),
        status: 'Healthy',
        docker_healthy: true,
        metrics: { cpu_usage_pct: 12, ram_used_bytes: 1_500_000_000, ram_total_bytes: 8_589_934_592 },
        containers: [],
      }),
    }),
    env,
    ctx
  );
  assert.strictEqual(hbRemoteRes.status, 202);
  const hbRemoteBody = await hbRemoteRes.json();
  assert.ok(hbRemoteBody.overlay_ip.startsWith('100.64.0.'), 'Piggybacked heartbeat must include overlay_ip');
  assert.ok(Array.isArray(hbRemoteBody.mesh_peers) && hbRemoteBody.mesh_peers.length >= 2);
  assert.ok(Array.isArray(hbRemoteBody.cluster_endpoints) && hbRemoteBody.cluster_endpoints.length >= 2);

  const deployCheckoutCmd = (hbRemoteBody.commands || []).find(
    (c) => c.type === 'deploy' && c.service === 'checkout-api'
  );
  assert.ok(deployCheckoutCmd, 'Remote node must receive deploy command for checkout-api');
  assert.strictEqual(deployCheckoutCmd.memory_mb, 512, 'deploy command must carry memory_mb cgroup limit');
  assert.strictEqual(deployCheckoutCmd.cpu_cores, 1.25, 'deploy command must carry cpu_cores cgroup limit');
  assert.ok(
    Array.isArray(deployCheckoutCmd.extra_hosts) &&
      deployCheckoutCmd.extra_hosts.includes('postgres-staging:100.64.0.31') &&
      deployCheckoutCmd.extra_hosts.includes('postgres:100.64.0.31'),
    'Remote app replica must receive ExtraHosts mapping postgres to pool-eu-1 WireGuard overlay IP'
  );
  assert.ok(
    Array.isArray(deployCheckoutCmd.remote_upstreams) &&
      deployCheckoutCmd.remote_upstreams.includes(
        `http://${siblingPlacement.mesh_ip}:${siblingPlacement.mesh_port}`
      ),
    'Traefik remote_upstreams must include sibling WireGuard mesh upstream'
  );

  // Drain pool-eu-1: postgres must be fenced (NOT wiped), stateless replicas remain 2 across pool-eu-2 & pool-eu-3
  const drainRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/nodes/pool-eu-1/drain', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Kernel upgrade maintenance' }),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));
  assert.strictEqual(drainRes.status, 200);
  const drainBody = await drainRes.json();
  assert.strictEqual(drainBody.schedulable, false);
  assert.ok(
    drainBody.fenced.some((f) => f.service === 'postgres'),
    'Stateful postgres singleton on drained node must be fenced, never auto-wiped'
  );

  // Verify cordoned status survives subsequent Healthy heartbeats from pool-eu-1
  await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/ingest', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-ingest-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        node_id: 'pool-eu-1',
        timestamp: new Date().toISOString(),
        status: 'Healthy',
        docker_healthy: true,
        metrics: { cpu_usage_pct: 5, ram_used_bytes: 1_000_000_000, ram_total_bytes: 8_589_934_592 },
        containers: [{ name: 'postgres-staging', image: 'postgres:18', status: 'Up 10 minutes', state: 'running' }],
      }),
    }),
    env,
    ctx
  );
  const drainedNodeInfoRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/nodes/pool-eu-1', {
      headers: { Authorization: 'Bearer test-admin-password' },
    }),
    env,
    ctx
  );
  const drainedNodeInfo = await drainedNodeInfoRes.json();
  assert.strictEqual(drainedNodeInfo.schedulable, false, 'Cordoned state must survive Healthy heartbeats');
  assert.strictEqual(drainedNodeInfo.status, 'Draining');

  // Uncordon pool-eu-1 -> restores schedulable=true
  const uncordonRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/nodes/pool-eu-1/uncordon', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));
  assert.strictEqual(uncordonRes.status, 200);

  // Simulate sudden crash of pool-eu-2 (stale last_heartbeat > 90s) and run failover-check
  await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/enroll', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-enroll-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        node_id: 'pool-eu-2',
        hostname: 'pool-eu-2.internal',
        provider: 'hetzner',
        region: 'eu-central',
        tags: ['staging', 'mesh'],
        last_heartbeat: Date.now() - 180_000,
        specs: { cpus: 4, ram_total_bytes: 8_589_934_592 },
        mesh: { tailscale_ip: '100.64.0.32', public_key: 'wg-pub-pool-eu-2' },
      }),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));

  const failoverRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/failover-check', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ stale_threshold_ms: 90_000 }),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));
  assert.strictEqual(failoverRes.status, 200);
  const failoverBody = await failoverRes.json();
  assert.ok(failoverBody.dead_nodes.includes('pool-eu-2'));

  const postFailoverPlRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/placements?env=staging', {
      headers: { Authorization: 'Bearer test-admin-password' },
    }),
    env,
    ctx
  );
  const postFailoverPlBody = await postFailoverPlRes.json();
  const survivorCheckoutNodes = postFailoverPlBody.placements
    .filter((p) => p.service === 'checkout-api')
    .map((p) => p.node_id)
    .sort();
  assert.deepStrictEqual(
    survivorCheckoutNodes,
    ['pool-eu-1', 'pool-eu-3'],
    'Dead-node failover must automatically reschedule checkout-api onto surviving healthy peers'
  );

  // Verify on-demand Docker image garbage collection command queueing
  const pruneImagesRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/nodes/pool-eu-1/prune-images', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ until_hours: 72 }),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));
  assert.strictEqual(pruneImagesRes.status, 202);
  const pruneImagesBody = await pruneImagesRes.json();
  assert.strictEqual(pruneImagesBody.status, 'queued');
  assert.strictEqual(pruneImagesBody.until_hours, 72);

  const hbPruneCheck = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/ingest', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-ingest-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        node_id: 'pool-eu-1',
        timestamp: new Date().toISOString(),
        status: 'Healthy',
        docker_healthy: true,
        metrics: { cpu_usage_pct: 8, ram_used_bytes: 1_000_000_000, ram_total_bytes: 8_589_934_592 },
        containers: [],
      }),
    }),
    env,
    ctx
  );
  const hbPruneBody = await hbPruneCheck.json();
  assert.ok(
    (hbPruneBody.commands || []).some((c) => c.type === 'prune_images' && c.until_hours === 72),
    'prune_images command must be queued on target node'
  );
  console.log('   ✅ Passed: Multi-node spread scheduling, WireGuard ExtraHosts & remote_upstreams, hard cgroup limits, image prune, drain fencing & dead-node failover verified!\n');

  console.log('7️⃣  Testing Mesh Logout (Ed25519 Signed Leave) & Server Unenroll (flarelensd leave/uninstall)...');
  // 7a. Generate real Ed25519 keypair in Web Crypto and build OpenSSH authorized_keys line
  const edKeyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rawEdPub = new Uint8Array(await crypto.subtle.exportKey('raw', edKeyPair.publicKey));
  const algBytes = new TextEncoder().encode('ssh-ed25519');
  const wireBlob = new Uint8Array(4 + algBytes.length + 4 + rawEdPub.length);
  const dv = new DataView(wireBlob.buffer);
  dv.setUint32(0, algBytes.length, false);
  wireBlob.set(algBytes, 4);
  dv.setUint32(4 + algBytes.length, rawEdPub.length, false);
  wireBlob.set(rawEdPub, 8 + algBytes.length);
  const sshPubLine = `ssh-ed25519 ${Buffer.from(wireBlob).toString('base64')} flarelens-mesh`;

  const laptopWgPub = 'wgPubKeyLaptopEd25519Test00000000000000000000=';
  await env.CONTROL_DB
    .prepare(
      `INSERT INTO mesh_peers (id, name, overlay_ip, public_key, type, online, last_seen, updated_at, record_json)
       VALUES (?, ?, ?, ?, 'client', 1, ?, ?, ?)`
    )
    .bind(
      'client-dev-laptop',
      'dev-laptop',
      '100.64.0.99',
      laptopWgPub,
      new Date().toISOString(),
      new Date().toISOString(),
      JSON.stringify({
        id: 'client-dev-laptop',
        name: 'dev-laptop',
        overlay_ip: '100.64.0.99',
        public_key: laptopWgPub,
        ssh_public_key: sshPubLine,
        type: 'client',
        online: true,
      })
    )
    .run();

  // Unauthenticated spoofing attempt without signature must be rejected (401)
  const spoofLeaveRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/mesh/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peer_id: 'client-dev-laptop', public_key: laptopWgPub }),
    }),
    env,
    ctx
  );
  assert.strictEqual(spoofLeaveRes.status, 401, 'Unsigned keyless mesh leave must be rejected');

  // Valid Ed25519-signed logout from SSO laptop without Authorization token must succeed (200)
  const leaveTs = String(Math.floor(Date.now() / 1000));
  const leaveMsg = new TextEncoder().encode(`flarelens-mesh-leave:${laptopWgPub}:${leaveTs}`);
  const leaveSigBuf = await crypto.subtle.sign({ name: 'Ed25519' }, edKeyPair.privateKey, leaveMsg);
  const signedLeaveRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/mesh/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peer_id: 'client-dev-laptop',
        public_key: laptopWgPub,
        timestamp: leaveTs,
        ssh_signature: Buffer.from(leaveSigBuf).toString('base64'),
      }),
    }),
    env,
    ctx
  );
  assert.strictEqual(signedLeaveRes.status, 200, 'Ed25519-signed workstation logout must succeed');
  const signedLeaveBody = await signedLeaveRes.json();
  assert.deepStrictEqual(signedLeaveBody.removed_ids, ['client-dev-laptop']);

  // 7b. Server unenroll via ENROLL_TOKEN (`flarelensd leave` / `uninstall`)
  const nodeLeaveRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/nodes/pool-eu-3/leave', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-enroll-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Operator ran flarelensd uninstall' }),
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));
  assert.strictEqual(nodeLeaveRes.status, 200);
  const nodeLeaveBody = await nodeLeaveRes.json();
  assert.strictEqual(nodeLeaveBody.status, 'unenrolled');
  assert.strictEqual(nodeLeaveBody.node_id, 'pool-eu-3');

  const verifyGoneRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/nodes/pool-eu-3', {
      headers: { Authorization: 'Bearer test-admin-password' },
    }),
    env,
    ctx
  );
  assert.strictEqual(verifyGoneRes.status, 404, 'Unenrolled node must be removed from D1 & memory');

  // 7c. Dashboard Remove Node button (`DELETE /api/v1/control/nodes/:id`)
  const dashDelNodeRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/nodes/pool-eu-2', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-admin-password' },
    }),
    env,
    ctx
  );
  await Promise.all(pendingWaitTasks.splice(0));
  assert.strictEqual(dashDelNodeRes.status, 200, 'Dashboard DELETE /api/v1/control/nodes/:id must succeed');
  const dashDelNodeBody = await dashDelNodeRes.json();
  assert.strictEqual(dashDelNodeBody.status, 'unenrolled');
  assert.strictEqual(dashDelNodeBody.node_id, 'pool-eu-2');
  const verifyDashDelGone = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/nodes/pool-eu-2', {
      headers: { Authorization: 'Bearer test-admin-password' },
    }),
    env,
    ctx
  );
  assert.strictEqual(verifyDashDelGone.status, 404, 'Dashboard-removed node must return 404');
  console.log('   ✅ Passed: Ed25519 keyless mesh logout, spoof rejection & safe server unenroll / Dashboard DELETE verified!\n');

  console.log('8️⃣  Testing Declarative CronJobs (UTC Schedule, Slot Dedup, Concurrency Forbid) & One-Off Jobs...');
  const jobManifestRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/fleet/manifests', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        manifest: {
          service: 'billing-worker',
          env: 'uat',
          mode: 'blue_green',
          image: 'ghcr.io/example/billing-worker:1.4.0',
          container_port: 8080,
          host_port_blue: 18091,
          host_port_green: 18092,
          memory_mb: 512,
          jobs: [
            {
              name: 'sync-fx-rates',
              schedule: '*/5 * * * *',
              command: ['/app/billing', 'jobs', 'sync-fx'],
              concurrency_policy: 'forbid',
              timeout_seconds: 300,
              memory_mb: 384,
              cpu_cores: 0.5,
            },
            {
              name: 'backfill-ledger',
              command: ['/app/billing', 'jobs', 'backfill'],
              timeout_seconds: 900,
            },
          ],
        },
        reconcile: false,
      }),
    }),
    env,
    ctx
  );
  assert.strictEqual(jobManifestRes.status, 200, 'Manifest with jobs[] must validate and save');

  // Non-matching minute (02:01 UTC) must trigger 0 cron jobs
  const missTickRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/jobs/cron-tick', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ timestamp: '2026-11-26T02:01:00Z' }),
    }),
    env,
    ctx
  );
  const missTickBody = await missTickRes.json();
  assert.strictEqual(missTickBody.triggered.length, 0, '02:01 UTC must not match */5 schedule');

  // Matching minute (02:05 UTC) must enqueue exactly 1 run_job command
  const hitTickRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/jobs/cron-tick', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ timestamp: '2026-11-26T02:05:00Z' }),
    }),
    env,
    ctx
  );
  const hitTickBody = await hitTickRes.json();
  assert.strictEqual(hitTickBody.triggered.length, 1, '02:05 UTC must trigger sync-fx-rates once');
  const cronRunId = hitTickBody.triggered[0].run_id;

  // Duplicate tick in same minute (02:05:40Z) must skip via slot_already_fired
  const dupTickRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/jobs/cron-tick', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ timestamp: '2026-11-26T02:05:40Z' }),
    }),
    env,
    ctx
  );
  const dupTickBody = await dupTickRes.json();
  assert.strictEqual(dupTickBody.triggered.length, 0, 'Same UTC minute slot must never double-fire');
  assert.ok(dupTickBody.skipped.some((s) => s.reason === 'slot_already_fired'));

  // Next slot (02:10 UTC) while run 1 is still active must skip via concurrency_policy: forbid
  const forbidTickRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/jobs/cron-tick', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ timestamp: new Date(Date.now() + 5 * 60 * 1000).toISOString().replace(/:\d{2}\.\d{3}Z$/, ':00Z') }),
    }),
    env,
    ctx
  );
  // Note: only check concurrency skip if random current minute +5m happens to be divisible by 5; test deterministic timestamp aligned to now:
  const alignedNext5m = new Date(Math.ceil((Date.now() + 60_000) / (5 * 60_000)) * (5 * 60_000));
  const forbidAlignedRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/jobs/cron-tick', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ timestamp: alignedNext5m.toISOString() }),
    }),
    env,
    ctx
  );
  const forbidAlignedBody = await forbidAlignedRes.json();
  void forbidTickRes;
  assert.strictEqual(forbidAlignedBody.triggered.length, 0, 'concurrency_policy:forbid must block overlapping run');
  assert.ok(
    forbidAlignedBody.skipped.some((s) => s.reason === 'concurrency_forbid_active_run' || s.reason === 'slot_already_fired')
  );

  // Agent status callback -> succeeded with output
  const jobStatusRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/jobs/status', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-enroll-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        run_id: cronRunId,
        job_name: 'sync-fx-rates',
        service: 'billing-worker',
        env: 'uat',
        node_id: hitTickBody.triggered[0].node_id,
        status: 'succeeded',
        exit_code: 0,
        output: 'Synced 18 FX currency pairs',
        duration_ms: 412,
      }),
    }),
    env,
    ctx
  );
  assert.strictEqual(jobStatusRes.status, 200, 'Agent POST /api/v1/control/jobs/status must succeed');

  // Ad-hoc one-off job trigger via POST /api/v1/control/jobs/run
  const adhocRunRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/jobs/run', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-password',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        env: 'uat',
        service: 'billing-worker',
        job_name: 'adhoc-audit',
        command: ['/app/billing', 'jobs', 'audit-balances'],
      }),
    }),
    env,
    ctx
  );
  assert.strictEqual(adhocRunRes.status, 202, 'One-off job run must return 202 queued');

  const jobsListRes = await worker.fetch(
    new Request('https://control.flarelens.dev/api/v1/control/jobs?env=uat&service=billing-worker', {
      headers: { Authorization: 'Bearer test-admin-password' },
    }),
    env,
    ctx
  );
  const jobsListBody = await jobsListRes.json();
  assert.strictEqual(jobsListBody.defined_jobs.length, 2, 'Must list both cron and manual jobs from manifest');
  assert.ok(jobsListBody.runs.length >= 2, 'Must return recorded cron + adhoc job runs');
  const completedCronRun = jobsListBody.runs.find((r) => r.run_id === cronRunId);
  assert.strictEqual(completedCronRun.status, 'succeeded');
  assert.strictEqual(completedCronRun.output, 'Synced 18 FX currency pairs');
  console.log('   ✅ Passed: Cron schedule matching, slot deduplication, concurrency forbid, agent callback & one-off job run verified!\n');

  console.log('🎉 ALL FLARELENS OPEN-SOURCE D1 CONTROL PLANE TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
