# FlareLens

### Open-Source Serverless Infrastructure, Declarative Fleet Engine & Sovereign Mesh Platform

Manage servers, create & reconcile declarative workloads with immutable revisions (zero Git repo required), deploy zero-downtime Blue/Green releases, secure private WireGuard networks, and run an R2 Parquet log lakehouse from a **$0/month** Cloudflare Workers + D1 control plane.

[Website](https://flarelens.dev/) · [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens) · [Host Agent (`flarelensd`)](https://github.com/antwig2/flarelensd) · [Releases](https://github.com/antwig2/flarelens/releases)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens)
[![Latest release](https://img.shields.io/github/v/release/antwig2/flarelens?label=release&color=f38020)](https://github.com/antwig2/flarelens/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-555)](LICENSE)

FlareLens is an open-source platform for managing infrastructure across cloud, bare-metal, and hybrid environments. Built with a serverless Cloudflare Workers + D1 + R2 control plane and a single static Go host daemon ([`flarelensd`](https://github.com/antwig2/flarelensd)), it replaces centralized Kubernetes/Consul/Headscale control VMs, SSH-based Ansible playbooks, and boilerplate GitOps repositories with a 1-click serverless control plane.

---

## Key Capabilities

- **Zero-Git Declarative Fleet Engine & Immutable Revisions** — Create, edit, enable/suspend, and reconcile Blue/Green web services or stateful singletons (`postgres`, `dragonfly`, `traefik`, `cloudflared`) directly from the Dashboard UI. Every change is saved as an immutable numbered revision (`rev-1`, `rev-2`, …) in Cloudflare D1 + R2 (`state/revisions/rev-N.json`) with **1-click UAT → Prod promotion**, **1-click rollback** (even for deleted services), portable JSON export/import, and optional CI/Git sync (`POST /api/v1/control/fleet/sync`).
- **Multi-Server Placement, Hard Cgroup Isolation, Dynamic Mesh DNS (`TTL 5s`) & Auto-Failover** — Schedule multi-replica stateless apps across a server pool (`placement_strategy`: `spread` HA anti-affinity, `binpack` RAM consolidation, or `pinned` host affinity) with hard kernel cgroup RAM/CPU limits (`memory_mb`, `cpu_cores` — including zero-restart live singleton updates and automatic 72h Docker image pruning) and `required_tags`. `flarelensd` binds deterministic WireGuard overlay ports (`100.64.0.x:<mesh_port>`), runs an embedded UDP+TCP split-horizon `MagicDNSServer` on `<overlay_ip>:53` (`HostConfig.Dns` + `DnsSearch: ["<env>.mesh", "mesh"]`, round-robin `A` records, `TTL = 5s` with automatic `ExtraHosts` fallback), configures multi-node Traefik HTTP load-balancing with health checks, cordons/drains hosts cleanly (`POST /api/v1/control/nodes/:id/drain`), **fences stateful DB volumes** so persistent data is never auto-wiped, and automatically reschedules stateless replicas off dead nodes with zero container restarts.
- **`$0` Cloudflare D1 + Piggybacked 15s Control Plane** — Stores node state, placement leases, command queues, mesh peers, feature flags, and fleet revisions in Cloudflare D1 free tier (`5M` reads/day, `100K` writes/day). Pending commands, WireGuard mesh peers, cluster service endpoints, and flag version hashes piggyback directly onto the 15-second `/api/v1/ingest` heartbeat (`0` R2 `list()` Class A polling calls).
- **Zero-SSH Over-The-Air (`self_update`) & Host Maintenance** — SHA-256 verified binary upgrades, allowlisted systemd unit retirement (`retire_systemd_units`), and drain-locked graceful OS reboots (`reboot_node`) with pre-reboot command `ACK` verification so reboot loops cannot occur.
- **Zero-Plaintext Secrets Vault & RAM Secret Files** — AES-256-GCM encrypted secrets in Cloudflare KV injected strictly in memory (`-e KEY=VAL`) or materialized into ephemeral `/dev/shm` `tmpfs` directories (`__FLARELENS_FILE__`) for TLS/JWT/SAML certificates.
- **Direct Peer-to-Peer WireGuard Mesh** — Coordinates Curve25519 peer discovery at the edge while keeping all private server-to-server and operator traffic 100% P2P over UDP (`100.64.0.0/10` / `10.42.0.0/16`) — private data never traverses Cloudflare.
- **Parquet Log Lakehouse & Zero-Disk R2 Database Backups** — Compacts telemetry into Hive-partitioned Apache Parquet in Cloudflare R2 (queryable in-browser via DuckDB-WASM with `$0` egress) and streams `pg_dump` snapshots directly to R2 via `io.Pipe`.

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
