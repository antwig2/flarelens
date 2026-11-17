#!/usr/bin/env node
/**
 * Syncs root installers (/install.sh, /install.ps1) and extracts FLEET_JSON_SCHEMA
 * from ../src/control/fleet.ts into website/public/ before Astro/Nimbus builds.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const websiteRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(websiteRoot, "..");
const publicDir = path.join(websiteRoot, "public");

async function main() {
  fs.mkdirSync(publicDir, { recursive: true });

  for (const installer of ["install.sh", "install.ps1"]) {
    const srcInstaller = path.join(repoRoot, "public", installer);
    if (fs.existsSync(srcInstaller)) {
      fs.copyFileSync(srcInstaller, path.join(publicDir, installer));
    }
  }

  const fleetModule = await import(path.join(repoRoot, "src", "control", "fleet.ts"));
  if (!fleetModule?.FLEET_JSON_SCHEMA) {
    throw new Error("FLEET_JSON_SCHEMA not exported from ../src/control/fleet.ts");
  }
  const schemaOut = path.join(publicDir, "schemas", "fleet.schema.json");
  fs.mkdirSync(path.dirname(schemaOut), { recursive: true });
  fs.writeFileSync(schemaOut, JSON.stringify(fleetModule.FLEET_JSON_SCHEMA, null, 2) + "\n", "utf8");
}

main().catch((err) => {
  console.error("Failed to sync static schema/installers:", err);
  process.exit(1);
});
