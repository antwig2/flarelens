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

  console.log('🎉 ALL FLARELENS OPEN-SOURCE D1 CONTROL PLANE TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
