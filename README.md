# FlareLens

**Open-Source, Self-Hosted Infrastructure Platform**

### Your infrastructure. One control plane.

Deploy, manage, secure, and monitor applications across cloud and on-premises servers. FlareLens brings infrastructure operations together in an open-source, self-hosted platform, without the complexity of Kubernetes or a dedicated management server.

[Website](https://flarelens.dev/) · [Documentation](https://flarelens.dev/docs/) · [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens) · [Host Agent (`flarelensd`)](https://github.com/antwig2/flarelensd) · [Releases](https://github.com/antwig2/flarelens/releases)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens)
[![Latest release](https://img.shields.io/github/v/release/antwig2/flarelens?label=release&color=f38020)](https://github.com/antwig2/flarelens/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-555)](LICENSE)

FlareLens brings infrastructure management, declarative deployments, private networking, secrets, and observability together without requiring dedicated control-plane servers or a Kubernetes cluster. Built with a serverless Cloudflare Workers + D1 + KV + R2 control plane and a lightweight Go host daemon ([`flarelensd`](https://github.com/antwig2/flarelensd)), your applications continue running on your own machines while one control plane coordinates everything.

---

## Key Capabilities

- **Fleet Management** — Register and manage cloud VMs and physical servers from one dashboard. Schedule workloads across machines (`spread`, `binpack`, `pinned`), control CPU and memory allocation via hard Linux kernel cgroups (including zero-restart live singleton updates and automatic Docker image pruning), and perform server maintenance (node drain with stateful volume fencing, OTA `flarelensd` upgrades, and drain-locked OS reboots).
- **Application Deployments** — Deploy Docker applications, manage immutable revisions (`rev-1`, `rev-2`, … in D1 + R2), promote changes between environments (`uat → prod`), perform `<1ms` Blue/Green releases with ephemeral schema migrations, and roll back failed deployments in 1 click without requiring Kubernetes.
- **Private Mesh Networking** — Connect servers and operator devices across different networks using WireGuard (`100.64.0.0/10`), encrypted ChaCha20-Poly1305 peer-to-peer communication, and embedded split-horizon private service discovery (`MagicDNS` on `<overlay_ip>:53`, `TTL = 5s`).
- **Observability** — Monitor server health, resource usage, containers, and application logs on a 15-second piggybacked heartbeat (`0` R2 `list()` polling calls). Store logs in Cloudflare R2 using Snappy-compressed Apache Parquet and query them in-browser through DuckDB-WASM with `$0` egress.
- **Secrets & Feature Flags** — Manage AES-256-GCM encrypted application secrets (injected strictly in memory or mounted into `0700` `/dev/shm` RAM `tmpfs` via `__FLARELENS_FILE__`) and runtime configuration centrally, alongside sub-millisecond feature flags that control application behavior.
- **Backups & Recovery** — Stream PostgreSQL backups directly to Cloudflare R2 via `io.Pipe` with zero local disk staging, schedule recurring cron backups, protect database migrations with pre-deploy snapshots, and support automated or on-demand restoration.

---

## Do I Need a Git Repository or `cloudflared`?

- **No Git repository required** — You can manage your entire fleet natively in the FlareLens Dashboard (`+ New Service`, 1-click presets, `Promote UAT → Prod`, and `Rollback to rev-N`) backed by Cloudflare D1 + R2 state snapshots. If your team also uses CI/CD, push webhooks (`/api/v1/control/deploy/webhook`) and optional `fleet/<env>/*.yml` syncs (`/api/v1/control/fleet/sync`) plug right into the same revision timeline.
- **No `cloudflared` required** — FlareLens supports both **Direct Edge Ingress** (`A`/`AAAA` DNS records pointed directly at your VM with Traefik/Caddy Let's Encrypt TLS) and **Optional Zero-Inbound-Port Tunnels** (`cloudflared` singleton with ports `22`/`80`/`443` closed on your cloud firewall).

---

## Quick Start

### 1. Deploy the Control Plane (`$0` Cloudflare Free Tier)

**Option A — 1-Click Deploy Button (Auto-Provisions D1, KV & R2):**

Click [**Deploy to Cloudflare Workers**](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens) — Wrangler v4 automatically provisions `CONTROL_DB` (`flarelens-control`), `FLEET_KV`, `LOGS_BUCKET`, and `BACKUP_BUCKET`, and applies the D1 schema migrations. Then set `INGEST_SECRET`, `DASHBOARD_PASSWORD`, and `VAULT_MASTER_KEY` in your Worker settings.

**Option B — Wrangler CLI:**

```sh
git clone https://github.com/antwig2/flarelens.git
cd flarelens
npm install

# Configure control-plane secrets
npx wrangler secret put INGEST_SECRET
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put VAULT_MASTER_KEY

# Deploy Worker (Wrangler v4 auto-provisions D1, KV, and R2 bindings from wrangler.toml)
npm run deploy
npx wrangler d1 migrations apply flarelens-control --remote
```

### 2. Enroll a Server Node (`flarelensd`)

```sh
curl -fsSL "https://flarelens.dev/install.sh" | sudo bash -s -- \
  --control "https://<your-worker-url>" \
  --token "<YOUR_INGEST_SECRET>"
```

### 3. Add Services in the Dashboard (or Optional CI Push)

Open **Declarative Fleet** in your FlareLens Dashboard and click **`+ New Service`** to pick a 1-click template (**Blue/Green App**, **PostgreSQL 18**, **Dragonfly**, **Traefik v3**, or **Cloudflared**), save `rev-1`, promote `uat → prod`, or roll back to any historical revision in 1 click.

Want IDE validation or optional CI sync? Every FlareLens Worker serves its canonical JSON Schema at `GET /schemas/fleet.schema.json`:

```json
{
  "$schema": "https://flarelens.dev/schemas/fleet.schema.json",
  "service": "billing-api",
  "env": "prod",
  "domains": ["api.example.com", "auth.example.com"],
  "image": "ghcr.io/acme/billing-api:1.4.0",
  "replicas": 2,
  "memory_mb": 512,
  "placement_strategy": "spread",
  "container_port": 8080,
  "host_port_blue": 9080,
  "host_port_green": 9081,
  "health_path": "/health",
  "networks": ["app-prod", "flarelens-edge"],
  "aliases": ["billing-api"]
}
```

### 4. Connect an Operator Workstation (Optional WireGuard Mesh)

```sh
sudo flarelens-agent login --control=https://<your-worker-url>
```

---

## Architecture

- **Control Plane (`antwig2/flarelens`)** — Cloudflare Worker + D1 + KV + R2 handling authentication, zero-Git fleet revisions & rollbacks, encrypted Vault secrets, OTA binary distribution, and DuckDB-WASM Parquet observability.
- **Host Agent (`antwig2/flarelensd`)** — Single static Go daemon running on Linux/macOS/Windows hosts; executes zero-downtime Blue/Green & singleton Docker reconciliation, Traefik dynamic route flips, streaming R2 backups, and P2P WireGuard networking.
- **Sovereign Resilience** — Workloads continue serving live traffic independently even if control-plane connectivity is interrupted.

## Components

| Component | Description | Repository |
|-----------|-------------|------------|
| **Control Plane** | Dashboard, Zero-Git Fleet Engine, D1 revisions, Vault, and Parquet Lakehouse | [antwig2/flarelens](https://github.com/antwig2/flarelens) |
| **Host Agent** | Static Go daemon for Blue/Green & singleton orchestration, mesh, and backups | [antwig2/flarelensd](https://github.com/antwig2/flarelensd) |

## Contributing & Security

Contributions are welcome. See [CONTRIBUTING.md](https://github.com/antwig2/flarelens/blob/main/CONTRIBUTING.md) and [SECURITY.md](https://github.com/antwig2/flarelens/blob/main/SECURITY.md).

## License

FlareLens is licensed under [Apache License 2.0](https://github.com/antwig2/flarelens/blob/main/LICENSE).
