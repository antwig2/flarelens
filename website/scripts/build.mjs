#!/usr/bin/env node
/**
 * Zero-dependency static site builder for flarelens.dev.
 *
 * 1. Copies website/src/* -> website/dist/
 * 2. Copies ../public/install.sh and ../public/install.ps1 -> website/dist/
 * 3. Extracts FLEET_JSON_SCHEMA from ../src/control/fleet.ts -> website/dist/schemas/fleet.schema.json
 * 4. Generates /llms.txt and /llms-full.txt (complete Markdown docs + JSON Schema for AI agents)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const websiteRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(websiteRoot, '..');
const srcDir = path.join(websiteRoot, 'src');
const distDir = path.join(websiteRoot, 'dist');

function copyRecursive(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      copyRecursive(path.join(from, entry), path.join(to, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

async function main() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  // 1. Copy website/src -> website/dist
  copyRecursive(srcDir, distDir);

  // 2. Sync canonical installer scripts from ../public/
  for (const installer of ['install.sh', 'install.ps1']) {
    const srcInstaller = path.join(repoRoot, 'public', installer);
    if (fs.existsSync(srcInstaller)) {
      fs.copyFileSync(srcInstaller, path.join(distDir, installer));
    }
  }

  // 3. Emit canonical JSON Schema at /schemas/fleet.schema.json
  const fleetModule = await import(path.join(repoRoot, 'src', 'control', 'fleet.ts'));
  if (!fleetModule?.FLEET_JSON_SCHEMA) {
    throw new Error('FLEET_JSON_SCHEMA not exported from ../src/control/fleet.ts');
  }
  const schemaJson = JSON.stringify(fleetModule.FLEET_JSON_SCHEMA, null, 2);
  const schemaOut = path.join(distDir, 'schemas', 'fleet.schema.json');
  fs.mkdirSync(path.dirname(schemaOut), { recursive: true });
  fs.writeFileSync(schemaOut, schemaJson + '\n', 'utf8');

  // 4. Generate /llms.txt and /llms-full.txt for AI coding agents
  const readmeMd = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const llmsSummary = [
    '# FlareLens',
    '',
    '> Open-source serverless infrastructure control plane (Cloudflare Workers + D1 + R2) and static Go host daemon (`flarelensd`) for zero-downtime Blue/Green Docker deployments, Zero-Git declarative fleet revisions, direct P2P WireGuard mesh with 5-second MagicDNS, RAM-only AES-256-GCM secrets, hard kernel cgroups, and an R2 Apache Parquet log lakehouse.',
    '',
    '- [Documentation](https://flarelens.dev/docs/)',
    '- [Full Agent Context](https://flarelens.dev/llms-full.txt)',
    '- [How FlareLens Compares](https://flarelens.dev/compare/)',
    '- [Fleet Manifest JSON Schema](https://flarelens.dev/schemas/fleet.schema.json)',
    '- [Linux/macOS Installer](https://flarelens.dev/install.sh)',
    '- [Control Plane Repository](https://github.com/antwig2/flarelens)',
    '- [Host Daemon Repository](https://github.com/antwig2/flarelensd)',
    '',
  ].join('\n');

  const llmsFull = [
    '# FlareLens — Complete Platform & Schema Reference (llms-full.txt)',
    '',
    'Canonical URLs:',
    '- Website: https://flarelens.dev/',
    '- Docs: https://flarelens.dev/docs/',
    '- Compare: https://flarelens.dev/compare/',
    '- JSON Schema: https://flarelens.dev/schemas/fleet.schema.json',
    '- Installer: https://flarelens.dev/install.sh',
    '',
    '---',
    '',
    readmeMd.trim(),
    '',
    '---',
    '',
    '## Control Plane HTTP Endpoints',
    '',
    '- `POST /api/v1/ingest` — 15s host heartbeat; returns piggybacked `commands`, `mesh_peers`, `cluster_endpoints`, and `flags_version`.',
    '- `POST /api/v1/control/fleet/sync` — Sync declarative manifests via Bearer token or keyless GitHub Actions OIDC (`id-token: write`).',
    '- `POST /api/v1/control/fleet/promote` — Promote manifests across environments (`uat -> prod`) with immutable D1+R2 revision (`rev-N`).',
    '- `POST /api/v1/control/fleet/rollback` — Roll back fleet state to any historical `rev-N` snapshot.',
    '- `POST /api/v1/control/nodes/:id/drain` & `/uncordon` — Drain stateless replicas off a node while fencing stateful DB volumes.',
    '- `POST /api/v1/control/nodes/:id/prune-images` — Trigger two-pass Docker image garbage collection (dangling >24h, unused >72h).',
    '- `POST /api/v1/control/agent/releases` — Publish SHA-256 verified `flarelensd` OTA binary release.',
    '',
    '---',
    '',
    '## Canonical Fleet Manifest JSON Schema (`https://flarelens.dev/schemas/fleet.schema.json`)',
    '',
    '```json',
    schemaJson,
    '```',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(distDir, 'llms.txt'), llmsSummary, 'utf8');
  fs.writeFileSync(path.join(distDir, 'llms-full.txt'), llmsFull, 'utf8');

  console.log('✅ Built flarelens.dev static site into website/dist/');
  console.log('   • Synced /install.sh & /install.ps1');
  console.log('   • Generated /schemas/fleet.schema.json');
  console.log('   • Generated /llms.txt & /llms-full.txt');
}

main().catch((err) => {
  console.error('❌ Website build failed:', err);
  process.exit(1);
});
