# FlareLens

**The Sovereign Control Plane for Your Organisation's Infrastructure.**

[FlareLens](https://flarelens.dev) unifies server fleet management, zero-trust private networking, GitOps rollouts, and telemetry into a single, high-polish platform. Instead of managing a complex Kubernetes cluster or paying thousands of dollars for fragmented SaaS tools (Datadog + Tailscale + Doppler + PagerDuty), FlareLens delivers a unified serverless control plane powered by Cloudflare Workers and a lean Go host daemon.

[![Runtime](https://img.shields.io/badge/Runtime-Cloudflare_Workers-F38020?style=flat&logo=cloudflare)](https://workers.cloudflare.com)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript_5.6-3178C6?style=flat&logo=typescript)](https://www.typescriptlang.org/)
[![Host Daemon](https://img.shields.io/badge/Daemon-flarelensd_(Go)-00ADD8?style=flat&logo=go)](https://github.com/antwig2/flarelensd)
[![Protocol](https://img.shields.io/badge/Network-WireGuard_P2P-red.svg)](https://www.wireguard.com)
[![Storage](https://img.shields.io/badge/Storage-Cloudflare_R2_Parquet-teal.svg)](https://www.cloudflare.com/developer-platform/r2/)
[![Egress](https://img.shields.io/badge/Egress_Fees-$0_Zero_Egress-success)](#)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens)

---

## What is FlareLens?

Every growing organisation needs a central brain to coordinate its infrastructure. Traditionally, teams are forced to choose between two painful extremes:
1. **The Overkill Path (Kubernetes)**: Managing `etcd`, CNI plugins, ingress controllers, and YAML manifests just to run a few dozen containers across VMs.
2. **The Fragmented SaaS Path**: Cobbling together 5–6 different SaaS subscriptions (Tailscale for VPN, Datadog for APM, Doppler for secrets, BetterStack for logs, and PagerDuty for alerts) — racking up \$1,500+/mo in subscription and data egress bills.

FlareLens is the **sovereign middle path**: an edge control plane that acts as the thermostat for your infrastructure.

```
┌────────────────────────────────────────────────────────────────────────┐
│             FLARELENS: ORGANISATIONAL CONTROL PLANE                    │
│                                                                        │
│   [ Fleet Management ]      [ Zero-Trust Mesh ]      [ GitOps Engine ] │
│   Inventory, OS, hardware,  WireGuard P2P, MagicDNS, Zero-downtime     │
│   state reconciliation      keyless SSH via SSO      atomic rollouts   │
│                                                                        │
│   [ Secrets Vault ]         [ Observability Lake ]   [ Access Gate ]   │
│   AES-256 in-RAM injection, Zero-egress Parquet logs, Google/OIDC SSO, │
│   zero plaintext on disk    DuckDB analytics         role-based audit  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Desired State & Signaling (TLS)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        YOUR ORGANISATION'S INFRA                       │
│                                                                        │
│    Cloud VPSs (Hetzner, DO)  •  Bare Metal  •  On-Prem Data Centers   │
│    Developer Laptops  •  Database Clusters  •  Edge Gateways          │
└────────────────────────────────────────────────────────────────────────┘
```

* **Control Plane (This Repository)**: Runs serverless across 330+ Cloudflare edge locations. It stores desired state, coordinates WireGuard peer discovery, manages encrypted secrets, and aggregates telemetry into columnar Apache Parquet.
* **Data Plane ([`flarelensd`](https://github.com/antwig2/flarelensd))**: A lightweight Go daemon (<25MB RAM) running on your Linux, macOS, and Windows nodes. It configures in-kernel WireGuard interfaces (`wg0`), monitors local Docker containers, and executes atomic Traefik routing swaps.

> [!IMPORTANT]
> **Static Stability & Line-Speed Data Plane**: Application and network traffic flows **directly peer-to-peer over UDP** at full wire speed (10Gbps+). Application data **never** transits Cloudflare data centers. If the control plane is temporarily unreachable, your servers, tunnels, and containers continue running without interruption.

---

## Quick Start

### Option A: 1-Click Deploy to Cloudflare

Deploy the FlareLens control plane directly into your Cloudflare account with a single click:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens)

This automatically forks the repository to your GitHub account and provisions continuous deployment via Cloudflare Workers.

---

### Option B: Manual CLI Deploy

> **Prerequisites**: Node.js v18+ and the [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/).

#### 1. Deploy Your Control Plane (Cloudflare Worker)

```bash
git clone https://github.com/antwig2/flarelens.git
cd flarelens
npm install

# Create free KV namespace and R2 storage bucket
npx wrangler kv namespace create FLEET_KV
npx wrangler r2 bucket create flarelens-logs

# Configure and deploy
cp wrangler.toml.example wrangler.toml
# (Add your KV ID in wrangler.toml)
npm run deploy
```

Your control plane and dashboard UI will immediately be live at `https://flarelens.<your-subdomain>.workers.dev`.

#### 2. Enroll Your First Host Node

On any Ubuntu, Debian, RHEL, or Alpine server, run the 30-second bootstrap installer:

```bash
curl -fsSL https://<your-worker-url>/install.sh | sudo bash -s -- \
  --control "https://<your-worker-url>" \
  --token "<YOUR_ENROLL_TOKEN>"
```

#### 3. Connect from Your Laptop (Browser SSO)

Join your developer workstation to your organisation's private WireGuard mesh using RFC 8628 Device Flow SSO:

```bash
sudo flarelensd login --control=https://<your-worker-url>
```

A browser window will open for authentication via Cloudflare Access Zero Trust or Google Workspace, assigning your workstation a static `100.64.0.x` mesh IP with instant MagicDNS resolution (`node-1.mesh`, `db.mesh`).

---

## Key Capabilities

* **🌐 Sovereign WireGuard Mesh Coordinator**: Replaces centralized VPN concentrator VMs with serverless peer exchange directly on Cloudflare Workers. Direct P2P ChaCha20-Poly1305 encryption with sub-0.1ms kernel latency.
* **⚡ In-Memory MagicDNS (`*.mesh`)**: Automatically resolves `node-1.mesh`, `api.mesh`, and `postgres.mesh` across all registered servers and developer laptops without exposing public DNS records.
* **🔑 Sovereign Keyless SSH**: Cryptographically authorized terminal access using dynamic OpenSSH `AuthorizedKeysCommand` hooks verified by the edge coordinator against active SSO sessions.
* **📊 Zero-Egress Parquet Lakehouse**: Telemetry is buffered on the host, compacted into columnar Apache Parquet in Cloudflare R2 every 60 seconds, and queried directly in your browser using **DuckDB-WASM** with **\$0 bandwidth egress fees**.
* **⏱️ Sub-5ms Live Tail**: Streams container and host stdout/stderr logs in real time over Server-Sent Events (SSE).
* **🔄 GitOps Blue/Green Deployments**: Atomic inotify Traefik routing swaps in under 1 millisecond with automated schema migrations and instant health check rollback.
* **🔐 Zero-Plaintext Secrets Vault**: Encrypted with AES-256-GCM at the edge and injected directly into container process RAM during deployment. Zero `.env` files stored on disk.
* **🩺 Global Synthetic Monitoring**: Automated cron health probes executed from 300+ Anycast cities with instant alerts to Telegram and WhatsApp.

---

## Architecture: Control Plane vs. Data Plane

```
┌────────────────────────────────────────────────────────────────────────┐
│                   CONTROL PLANE (Cloudflare Edge)                      │
│                  "The Orchestrator, Not the Router"                    │
│                                                                        │
│   • Coordinates WireGuard peer discovery (Public Keys & Endpoints in KV)│
│   • Enforces Zero-Trust Admin Identity (Cloudflare Access SSO / OTP)  │
│   • Stores Cold Parquet Logs & DB Backups (Cloudflare R2 - $0 Egress)  │
│   • Runs Serverless across 330+ cities (Zero master servers to patch) │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Metadata & Signaling Only (TLS / WS)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      DATA PLANE (WireGuard Mesh)                       │
│                        "Direct, Private, P2P"                          │
│                                                                        │
│    [ Node 1 (VPS) ] ◄══════════ Direct Encrypted ═════════► [ Node 2 ] │
│                       UDP P2P (100.64.0.0/10)                          │
│                                                                        │
│    ❌ NEVER touches Cloudflare data centers.                            │
│    ✅ Full LAN line-speed (10Gbps+ direct WireGuard overlay).          │
│    ✅ End-to-end encrypted with local Curve25519 keys (RFC 7748).      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 💰 Pricing & Free Tier Compatibility

FlareLens is explicitly engineered to run **100% free** on Cloudflare's standard Free tier, while automatically unlocking enterprise primitives on a Workers Paid plan (\$5/mo).

| Resource | Cloudflare Free Tier ($0/mo) | Workers Paid ($5/mo) | Built-In FlareLens Guardrail |
| :--- | :--- | :--- | :--- |
| **Cloudflare Queues** | ❌ Not available | ✅ Unlimited background queues | **Automatic In-Process Fallback**: If `DEPLOY_QUEUE` is unbound, rollouts execute directly via async sub-requests. |
| **Workers KV Writes** | ⚠️ 1,000 writes/day | ✅ 1,000,000 writes/mo included | **State-Transition Filtering & `safeKvPut`**: Node heartbeats update in-memory maps and only touch KV on health state changes (`Healthy` → `Warning`). Daily quotas are caught without throwing exceptions. |
| **Cloudflare R2** | ✅ 10 GB storage, $0 egress | ✅ 10 GB storage, $0 egress | **Columnar Parquet Compaction**: Batches telemetry to minimize R2 Class A write operations. |
| **Zero Trust Access** | ✅ Up to 50 users free | ✅ Up to 50 users free | **Native SSO Integration**: Dashboard authentication relies on Cloudflare Access without open internet exposure. |
| **Worker CPU Time** | ⚠️ 10ms CPU / request | ✅ 50ms CPU / request | **Zero-Dependency Code**: Uses lightweight native Web Crypto and streaming parsers to stay well below 10ms limits. |

---

## Developers & Codebase Map

* **[Dashboard UI & Static Assets](./public)** — Web application for logs, telemetry, fleet, backups, and mesh topology.
* **[Edge Mesh Coordinator](./src/control/mesh.ts)** — Zero-trust WireGuard coordinator and MagicDNS engine.
* **[Ingress Topology Visualizer](./src/control/ingress.ts)** — Route mapping and live health probers.
* **[Secrets Vault Engine](./src/control/vault.ts)** — AES-256-GCM zero-plaintext secrets manager.
* **[GitOps Webhook Runner](./src/control/webhook.ts)** — GitHub Actions M2M cryptographic OIDC verifier and deployment trigger.
* **[Host Daemon (`flarelensd`)](https://github.com/antwig2/flarelensd)** — Standalone Go binary running on servers and workstations.

---

## Community and Support

* **[GitHub Issues](https://github.com/antwig2/flarelens/issues)** to report bugs 🐛 or request features.
* **[Discussions](https://github.com/antwig2/flarelens/discussions)** to ask questions, share feedback, and celebrate your deployments 💕.
* **[Twitter / X](https://x.com/flarelens)** to say "hi" and follow the latest updates.

---

## Contributing

We welcome contributions to FlareLens! If you would like to help improve the control plane, dashboard, or documentation:

1. Fork the repository.
2. Create your feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes (`git commit -m 'Add amazing feature'`).
4. Push to the branch (`git push origin feature/amazing-feature`).
5. Open a Pull Request.

---

## License

FlareLens is open-source software licensed under the [Apache License, Version 2.0](LICENSE).
