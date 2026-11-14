# FlareLens

### Open-Source Serverless Infrastructure, GitOps & Sovereign Mesh Platform

Manage servers, reconcile declarative `fleet/*.yml` workloads, deploy zero-downtime Blue/Green releases, secure private WireGuard networks, and run an R2 Parquet log lakehouse from a **$0/month** Cloudflare Workers + D1 control plane.

[Website](https://flarelens.dev/) · [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens) · [Host Agent (`flarelensd`)](https://github.com/antwig2/flarelensd) · [Releases](https://github.com/antwig2/flarelens/releases)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens)
[![Latest release](https://img.shields.io/github/v/release/antwig2/flarelens?label=release&color=f38020)](https://github.com/antwig2/flarelens/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-555)](LICENSE)

FlareLens is an open-source platform for managing infrastructure across cloud, bare-metal, and hybrid environments. Built with a serverless Cloudflare Workers + D1 control plane and a single static Go host daemon ([`flarelensd`](https://github.com/antwig2/flarelensd)), it replaces centralized Kubernetes/Consul/Headscale control VMs and SSH-based Ansible playbooks with pull-based, cryptographic GitOps.

---

## Key Capabilities

- **`$0` Cloudflare D1 + Piggybacked 15s Control Plane** — Stores node state, command queues, mesh peers, and feature flags in Cloudflare D1 free tier (`5M` reads/day, `100K` writes/day). Pending commands and flag version hashes piggyback directly onto the 15-second `/api/v1/ingest` heartbeat (`0` R2 `list()` Class A polling calls).
- **ArgoCD-Style Declarative `fleet/<env>/*.yml` GitOps** — Reconcile Blue/Green web services (with companion `workers`, multi-host `domains`, stable Docker DNS `aliases`, and `env_vars`) alongside stateful/infrastructure singletons (`postgres`, `dragonfly`, `traefik`, `vector`) with `adopt_only: true`, `networks: ["host"]`, and `enabled: false` (`Suspended` staging).
- **Zero-SSH Over-The-Air (`self_update`) & Host Maintenance** — SHA-256 verified binary upgrades, allowlisted systemd unit retirement (`retire_systemd_units`), and drain-locked graceful OS reboots (`reboot_node`) with pre-reboot command `ACK` verification so reboot loops cannot occur.
- **Zero-Plaintext Secrets Vault & RAM Secret Files** — AES-256-GCM encrypted secrets in Cloudflare KV injected strictly in memory (`-e KEY=VAL`) or materialized into ephemeral `/dev/shm` `tmpfs` directories (`__FLARELENS_FILE__`) for TLS/JWT/SAML certificates.
- **Direct Peer-to-Peer WireGuard Mesh** — Coordinates Curve25519 peer discovery at the edge while keeping all private server-to-server and operator traffic 100% P2P over UDP (`100.64.0.0/10` / `10.42.0.0/16`) — private data never traverses Cloudflare.
- **Parquet Log Lakehouse & Zero-Disk R2 Database Backups** — Compacts telemetry into Hive-partitioned Apache Parquet in Cloudflare R2 (queryable in-browser via DuckDB-WASM with `$0` egress) and streams `pg_dump` snapshots directly to R2 via `io.Pipe`.

---

## Do I Need `cloudflared`?

**No — standalone FlareLens users do NOT need `cloudflared`.**

FlareLens supports two public ingress topologies:

| Ingress Mode | How It Works | When to Choose |
|---|---|---|
| **Direct Edge Ingress (Default)** | Point DNS `A`/`AAAA` records directly at your VM (`80/tcp`, `443/tcp`). Traefik or Caddy terminates Let's Encrypt TLS natively while `flarelensd` flips dynamic upstream routes atomically (`< 1ms`). | Standard cloud VMs or bare metal where you want direct public traffic without any proxy intermediary. |
| **Zero-Inbound-Port Tunnel *(Optional)*** | Run `cloudflared` as an optional singleton in `fleet/infra/cloudflared.yml` (`networks: ["host"]`, `adopt_only: true`) forwarding to `http://127.0.0.1:80` (Traefik), and close ports `22`, `80`, and `443` on your cloud firewall. | Zero-trust deployments behind NAT/CGNAT or when you want Cloudflare WAF/DDoS protection with zero open inbound TCP ports. |

---

## Quick Start

### 1. Deploy the Control Plane (`$0` Cloudflare Free Tier)

```sh
git clone https://github.com/antwig2/flarelens.git
cd flarelens
npm install

# Create D1 control database, KV namespace, and R2 log/backup bucket
npx wrangler d1 create flarelens-control
npx wrangler kv namespace create FLEET_KV
npx wrangler r2 bucket create flarelens-logs

# Configure wrangler.toml and apply the D1 SQLite schema
cp wrangler.toml.example wrangler.toml
npx wrangler d1 migrations apply flarelens-control --remote

# Configure control-plane secrets
npx wrangler secret put INGEST_SECRET
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put VAULT_MASTER_KEY

# Deploy Worker
npm run deploy
```

### 2. Enroll a Server Node (`flarelensd`)

```sh
curl -fsSL "https://<your-worker-url>/install.sh" | sudo bash -s -- \
  --control "https://<your-worker-url>" \
  --token "<YOUR_INGEST_SECRET>"
```

### 3. Reconcile Declarative `fleet/<env>/*.yml` Manifests

Push `fleet/<env>/*.yml` manifests from GitHub Actions using keyless OIDC (`POST /api/v1/control/fleet/sync`):

```yaml
# Example: fleet/prod/billing-api.yml
service: billing-api
env: prod
domain: api.example.com
domains:
  - api.example.com
  - auth.example.com
image: ghcr.io/acme/billing-api:prod
container_port: 8080
host_port_blue: 9080
host_port_green: 9081
health_path: /health
networks:
  - app-prod
  - app-edge
aliases:
  - billing-api
env_vars:
  PUBLIC_URL: https://api.example.com
workers:
  - name: billing-drainer
    command: ["drainer", "start"]
    networks:
      - app-prod
```

### 4. Connect an Operator Workstation (Optional WireGuard Mesh)

```sh
sudo flarelens-agent login --control=https://<your-worker-url>
```

---

## Architecture

- **Control Plane (`antwig2/flarelens`)** — Cloudflare Worker + D1 + KV + R2 handling authentication, GitOps orchestration, encrypted Vault secrets, OTA binary distribution, and DuckDB-WASM Parquet observability.
- **Host Agent (`antwig2/flarelensd`)** — Single static Go daemon running on Linux/macOS/Windows hosts; executes zero-downtime Blue/Green & singleton Docker reconciliation, Traefik dynamic route flips, streaming R2 backups, and P2P WireGuard networking.
- **Sovereign Resilience** — Workloads continue serving live traffic independently even if control-plane connectivity is interrupted.

## Components

| Component | Description | Repository |
|-----------|-------------|------------|
| **Control Plane** | Dashboard, GitOps/OTA APIs, D1 state, Vault, and Parquet Lakehouse | [antwig2/flarelens](https://github.com/antwig2/flarelens) |
| **Host Agent** | Static Go daemon for Blue/Green & singleton orchestration, mesh, and backups | [antwig2/flarelensd](https://github.com/antwig2/flarelensd) |

## Contributing & Security

Contributions are welcome. See [CONTRIBUTING.md](https://github.com/antwig2/flarelens/blob/main/CONTRIBUTING.md) and [SECURITY.md](https://github.com/antwig2/flarelens/blob/main/SECURITY.md).

## License

FlareLens is licensed under [Apache License 2.0](https://github.com/antwig2/flarelens/blob/main/LICENSE).
