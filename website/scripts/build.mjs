#!/usr/bin/env node
/**
 * Zero-dependency static site builder for flarelens.dev.
 *
 * 1. Copies website/src/* -> website/dist/
 * 2. Copies ../public/install.sh and ../public/install.ps1 -> website/dist/
 * 3. Extracts FLEET_JSON_SCHEMA from ../src/control/fleet.ts -> website/dist/schemas/fleet.schema.json
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
  const schemaOut = path.join(distDir, 'schemas', 'fleet.schema.json');
  fs.mkdirSync(path.dirname(schemaOut), { recursive: true });
  fs.writeFileSync(schemaOut, JSON.stringify(fleetModule.FLEET_JSON_SCHEMA, null, 2) + '\n', 'utf8');

  console.log('✅ Built flarelens.dev static site into website/dist/');
  console.log('   • Synced /install.sh & /install.ps1');
  console.log('   • Generated /schemas/fleet.schema.json');
}

main().catch((err) => {
  console.error('❌ Website build failed:', err);
  process.exit(1);
});
