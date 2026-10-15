# FlareLens

> **The unified control plane for modern infrastructure — combining zero-trust networking, observability, and deployments into a single lightweight binary.**

[![CI](https://github.com/antwig2/flarelens/actions/workflows/ci.yml/badge.svg)](https://github.com/antwig2/flarelens/actions/workflows/ci.yml)
[![Release](https://github.com/antwig2/flarelens/actions/workflows/release.yml/badge.svg)](https://github.com/antwig2/flarelens/actions/workflows/release.yml)
[![Go Version](https://img.shields.io/badge/Go-1.22+-00ADD8?style=flat&logo=go)](https://go.dev/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/Platforms-Linux_|_Windows_|_macOS-informational)](https://github.com/antwig2/flarelens/releases)
[![Egress](https://img.shields.io/badge/Egress_Fees-$0_Zero_Egress-success)](#)

---

## ⚡ Overview

**FlareLens** transforms distributed, heterogeneous infrastructure into a self-healing, unified private cloud. Operated by a single static Go daemon (`flarelens-agent`) and a serverless edge control plane, FlareLens manages **bare-metal servers, virtual machines, containers, and developer workstations** without requiring expensive SaaS subscriptions, complex Kubernetes clusters, or centralized VPN concentrators.

```
┌────────────────────────────────────────────────────────────────────────┐
│                   CLOUDFLARE EDGE CONTROL PLANE                        │
│                   https://control.flarelens.dev                        │
│                                                                        │
│   Single Dashboard for Logs, Metrics, Health, Alerts, Secrets & Flags │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Metadata & Signaling Only (TLS / WS)
       ┌───────────────────────────┼───────────────────────────┐
       ▼                           ▼                           ▼
┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐
│   BARE-METAL / VM     │ │    CONTAINER HOST     │ │ DEVELOPER WORKSTATION │
│   (Zero Containers)   │ │   (Docker / Podman)   │ │  (Windows / macOS)    │
├───────────────────────┤ ├───────────────────────┤ ├───────────────────────┤
│ • Native Systemd apps │ │ • Blue/Green rollouts │ │ • P2P WireGuard mesh  │
│ • Host PostgreSQL     │ │ • Traefik atomic swap │ │ • Secure admin access │
│ • Kernel OOM (-1000)  │ │ • Container telemetry │ │ • Secrets injection   │
│ • OS reboot detection │ │ • In-memory secrets   │ │ • Zero open ports     │
└───────────────────────┘ └───────────────────────┘ └───────────────────────┘
```

---

## 🔒 Architecture: Control Plane vs. Data Plane

A foundational design principle of FlareLens is the strict physical separation between the **Control Plane** and the **Data Plane**:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   CONTROL PLANE (Cloudflare Edge)                      │
│                  "The Orchestrator, Not the Router"                    │
│                                                                        │
│   • Coordinates WireGuard peer discovery (Public Keys & Endpoints in KV│
│   • Enforces Zero-Trust Admin Identity (Cloudflare Access SSO / OTP)  │
│   • Stores Cold Parquet Logs & DB Backups (Cloudflare R2 - $0 Egress)  │
│   • Runs Serverless across 300+ cities (Zero master servers to patch)  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Metadata & Signaling Only (KB/sec)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      DATA PLANE (WireGuard Mesh)                       │
│                        "Direct, Private, P2P"                          │
│                                                                        │
│    [ Node 1 (AWS) ] ◄═════════ Direct Encrypted ════════► [ Node 2 ]   │
│                       UDP P2P (10.42.0.0/16)                           │
│                                                                        │
│    ❌ NEVER touches Cloudflare data centers.                            │
│    ❌ Zero packet inspection or throttling by third parties.            │
│    ✅ Full LAN line-speed (10Gbps+ direct).                             │
│    ✅ End-to-end encrypted with local Curve25519 keys (RFC 7748).      │
└────────────────────────────────────────────────────────────────────────┘
```

### Why Cloudflare for the Control Plane?
Traditional platforms require provisioning and maintaining expensive central master servers (Kubernetes Control Plane nodes, HashiCorp Consul clusters, or Jenkins controllers) with open public IP ports. 

FlareLens eliminates the master server by leveraging Cloudflare's serverless edge primitives:
- **Cloudflare Workers**: High-performance, sub-10ms global edge API.
- **Cloudflare Access**: Enterprise Zero-Trust identity (Google, GitHub, Microsoft 365, or Email One-Time PIN) protecting the dashboard without opening public firewall ports.
- **Cloudflare KV**: Ephemeral signaling and peer coordination registry.
- **Cloudflare R2**: Columnar Parquet log lakehouse and database backup storage with **zero bandwidth egress fees**.

### Why WireGuard for the Data Plane?
Private inter-server communications, database replication, internal microservice calls, and operator SSH sessions **never touch Cloudflare**. They travel **directly peer-to-peer (P2P)** between your machines over an encrypted WireGuard UDP overlay (`10.42.0.0/16`), delivering full line-speed and absolute privacy.

---

## 💰 Commercial Tools Replaced ($154k/Year Savings)

| Commercial Tool | Typical Annual Cost | FlareLens Subsystem | FlareLens Architectural Advantage |
| :--- | :--- | :--- | :--- |
| **Datadog / Splunk** | $45,000 / yr | **Observability Engine** | R2 Columnar Parquet Lakehouse + Live SSE stream ($0 egress fees) |
| **Tailscale / PAM360**| $16,000 / yr | **WireGuard Mesh** | Pure Go Curve25519 (`RFC 7748`) P2P overlay, 0 external CLI dependencies |
| **ArgoCD / Flux** | $18,000 / yr | **Blue/Green GitOps** | Atomic Traefik inotify cutover, automated health checks, zero Kubernetes bloat |
| **HashiCorp Vault** | $20,000 / yr | **Secrets Vault** | AES-GCM-256 encrypted KV storage with in-memory container/process injection |
| **LaunchDarkly** | $15,000 / yr | **Edge Feature Flags** | Sub-microsecond local in-memory Go cache (`sync.RWMutex`) with real-time edge sync |
| **AWS RDS Backups** | $12,000 / yr | **Zero-Disk Backup** | `io.Pipe` streaming `pg_dump` directly to Cloudflare R2 with zero local disk usage |
| **PagerDuty** | $8,000 / yr | **Real-Time Alerts** | Edge evaluation with configurable anomaly thresholds and alert cooldowns |
| **Ansible / Bastion**| $20,000 / yr | **Fleet Manager** | Single static 16MB Go daemon with remote reboot, OOM score governance, and telemetry |
| **TOTAL** | **$154,000+ / yr** | **FlareLens** | **Single 16MB Go Binary + Cloudflare Workers Edge ($5/mo infrastructure)** |

---

## ✨ Core Superpowers

### 🌐 1. Zero-Trust WireGuard Mesh (P2P)
- **Pure Go Cryptography**: Keypairs are generated in-memory using `golang.org/x/crypto/curve25519` with RFC 7748 key clamping (`priv[0] &= 248`, `priv[31] = (priv[31] & 127) | 64`). **Zero dependency on external `wg` CLI binaries.**
- **Peer-to-Peer Overlay**: Establishes direct kernel-level WireGuard overlays (`10.42.0.0/16`) between nodes.
- **Zero Inbound Ports on Host**: Traverses NATs and corporate firewalls without public IP requirements.
- **Instant Operator Access**: Generate dynamic `.conf` profiles or mobile QR codes in 2 seconds for secure administrative access.

### 🔄 2. Blue/Green Zero-Downtime GitOps
- **Atomic Inotify Route Swapping**: Traefik routing rules are updated via atomic file renames (`os.Rename(tmp, final)` to `/etc/traefik/dynamic/service.yaml`). This prevents `inotify` from reading incomplete YAML during rollouts, cutting over traffic in **< 1 millisecond with zero dropped TCP packets**.
- **Canary & Health Probing**: Automatically runs HTTP readiness checks on candidate containers before traffic cutover.
- **Isolated Migration Runner**: Executes database migrations inside an ephemeral container (`docker run --rm`) on a private network with injected secrets.
- **Automated Rollback**: If candidate probes fail or migrations abort, the active container continues serving traffic with **zero downtime**.

### 🚩 3. Edge-Synchronized Feature Flags
- **Zero-Latency In-Memory Evaluation**: The Go agent maintains a local, thread-safe cache (`Store` with `sync.RWMutex`). Application flag lookups complete in **< 1 microsecond with 0 network hops**.
- **Real-Time Edge Sync**: Toggling a flag on the dashboard propagates updates via NATS/WebSockets instantly.
- **Percentage Rollouts**: Supports deterministic rollout percentages (`rollout_pct: 0-100`) and environment scoping (`production`, `staging`, `infra`).

### 📊 4. Parquet Log Lakehouse & Live Stream
- **Dual-Tier Ingestion**: Ingests logs from systemd journald, Docker socket, syslog, Vector, or application SDKs via `POST /api/v1/ingest`.
- **Sub-Second Live Tail**: Real-time in-memory ring buffer streams live events to the web UI via Server-Sent Events (`/api/v1/live/sse`).
- **Columnar R2 Storage**: Automatically compacts log streams into compressed Apache Parquet files in Cloudflare R2, enabling SQL queries with **zero egress costs**.
- **Resilient WAL**: Local Write-Ahead Log buffers data to disk during network blips, guaranteeing zero log loss.

### 🔐 5. Zero-Trust Secrets Vault
- **AES-GCM-256 Authenticated Encryption**: Secrets are stored encrypted in Cloudflare KV.
- **In-Memory Injection**: Secrets are injected directly into container environment variables at launch time (`-e KEY=VAL`). They are **never written as cleartext `.env` files to the host hard drive**.

### 💾 6. Zero-Disk Streaming Database Backups
- **Memory-Piped `pg_dump`**: Streams compressed database backups directly into Cloudflare R2 via Go's `io.Pipe` and multipart S3 uploads.
- **Prevents Node Crashes**: Eliminates temporary 20GB `.sql` files on `/tmp`, preventing disk-full failures during deployments.
- **Host-Native & Container Support**: Works with both containerized PostgreSQL and host-native PostgreSQL installs.

### 🛡️ 7. Host Kernel OOM Governance & System Health
- **Self-Preservation**: Automatically sets `/proc/self/oom_score_adj = -1000` at startup on Linux so the host kernel never kills the FlareLens daemon under heavy load.
- **Workload Score Ladder**: Proactively prioritizes container survival (`-900` for databases, `-800` for caches, `+500` for background workers).
- **OS Kernel Patching & Reboot Detection**: Tracks `/var/run/reboot-required` on Linux and `RebootPending` registry keys on Windows.

---

## 🚀 Quick Install

### Linux (One-Line Bootstrap)

```bash
curl -fsSL https://control.flarelens.dev/install.sh | sudo bash -s -- \
  --control "https://control.flarelens.dev"
```

### Windows (PowerShell)

Open PowerShell as Administrator:

```powershell
iwr -useb https://control.flarelens.dev/install.ps1 | iex
```

### Pre-Built Binaries

Download signed release binaries from [GitHub Releases](https://github.com/antwig2/flarelens/releases):

| OS | Architecture | Binary Asset | Archive |
| :--- | :--- | :--- | :--- |
| **Linux** | x86_64 (`amd64`) | `flarelens-agent-linux-amd64` | `.tar.gz` |
| **Linux** | ARM64 (`arm64`) | `flarelens-agent-linux-arm64` | `.tar.gz` |
| **Windows** | x86_64 (`amd64`) | `flarelens-agent-windows-amd64.exe` | `.zip` |
| **macOS** | Apple Silicon (`arm64`) | `flarelens-agent-darwin-arm64` | `.tar.gz` |
| **macOS** | Intel (`amd64`) | `flarelens-agent-darwin-amd64` | `.tar.gz` |

---

## ⚙️ Configuration Reference

Configuration is loaded dynamically with the following precedence:
1. CLI Flags (`--config`, `--node-id`, `--control-url`)
2. Environment Variables (`KIWID_NODE_ID`, `KIWID_CONTROL_URL`, `KIWID_ENROLL_TOKEN`)
3. YAML Configuration (`/etc/kiwid/agent.yaml` on Linux, `$ProgramData\FlareLens\agent.yaml` on Windows)

### Sample `/etc/kiwid/agent.yaml`

```yaml
identity:
  node_id: "node-fra-01"
  hostname: "app-prod-1"
  provider: "bare-metal"
  region: "fra1"
  tags: ["app", "prod"]

control_plane:
  endpoint: "https://control.flarelens.dev"
  enroll_token: "${KIWID_ENROLL_TOKEN}"
  heartbeat_interval: 15s

mesh:
  enabled: true
  listen_port: 51820
  interface_name: "flarelens0"

telemetry:
  log_level: "info"
  metrics_interval: 10s

database:
  mode: "host_native" # Or "container" for Docker PostgreSQL
  host: "127.0.0.1"
  port: 5432
  backup:
    enabled: true
    pre_deploy_snapshot: true
```

---

## 🛠️ CLI Usage

```bash
# Print agent version and build information
flarelens-agent --version

# Run daemon with explicit configuration file
flarelens-agent --config /etc/kiwid/agent.yaml

# Run in development mode with debug logging
flarelens-agent --dev --log-level debug

# Connect to custom control plane and specify mesh port
flarelens-agent --control-url https://control.flarelens.dev --mesh-port 51820
```

---

## 🏗️ Development & Building

### Prerequisites

- Go 1.22 or later
- Docker (optional, for Blue/Green container tests)

```bash
# Clone repository
git clone https://github.com/antwig2/flarelens.git
cd flarelens

# Run test suite
go test -v ./...

# Build binary locally
go build -ldflags="-s -w" -o bin/flarelens-agent ./cmd/agent

# Verify GoReleaser configuration
goreleaser check
```

---

## 📄 License

Licensed under the [Apache License, Version 2.0](LICENSE).  
Copyright &copy; 2026 FlareLens Authors.
