# FlareLens

> **The unified control plane for modern infrastructure — combining zero-trust networking, observability, and deployments into a single lightweight binary.**

[![CI](https://github.com/antwig2/flarelens/actions/workflows/ci.yml/badge.svg)](https://github.com/antwig2/flarelens/actions/workflows/ci.yml)
[![Release](https://github.com/antwig2/flarelens/actions/workflows/release.yml/badge.svg)](https://github.com/antwig2/flarelens/actions/workflows/release.yml)
[![Go Version](https://img.shields.io/badge/Go-1.22+-00ADD8?style=flat&logo=go)](https://go.dev/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/Platforms-Linux_|_Windows_|_macOS-informational)](https://github.com/antwig2/flarelens/releases)

---

## ⚡ Overview

**FlareLens** unifies fleet management, peer-to-peer zero-trust networking, continuous delivery, and full-stack observability into a single static Go daemon (`flarelens-agent`) orchestrated by a serverless Cloudflare edge control plane.

Whether running on bare-metal servers, cloud VMs, Raspberry Pis, or developer workstations, FlareLens connects your fleet over an encrypted WireGuard mesh without opening public firewall ports or paying bandwidth egress tolls.

```
┌────────────────────────────────────────────────────────────────────────┐
│                   CLOUDFLARE EDGE CONTROL PLANE                        │
│                   https://control.flarelens.dev                        │
│                                                                        │
│   • Cloudflare Access (SSO / OTP)     • Cloudflare R2 (Logs / Backups) │
│   • Fleet KV (State & Registry)       • WebSocket Real-time Telemetry  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Encrypted TLS / WS Tunnel
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      FLARELENS HOST AGENT (Go)                         │
│                                                                        │
│  [ P2P WireGuard Mesh ]  ─── P2P UDP ───  [ Other Nodes & Laptops ]    │
│  [ Blue/Green GitOps  ]  ─── Docker ────  [ Zero-Downtime Traffic ]    │
│  [ Kernel OOM Shield  ]  ── /proc score ─ [ -1000 Protection ]         │
│  [ Telemetry & WAL    ]  ── Metrics ───  [ CPU, RAM, Disk, Reboots ]   │
│  [ Database Snapshot  ]  ── pg_dump ───  [ Direct-to-R2 Stream ]       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## ✨ Core Pillars

### 🌐 1. Zero-Trust WireGuard Mesh
- **Pure Peer-to-Peer**: Automated Curve25519 key generation (`RFC 7748`) establishing direct kernel-level WireGuard overlays (`10.42.0.0/16`) between nodes.
- **Zero Open Ports**: Traverses NATs and corporate firewalls without public IP requirements or centralized VPN concentrators.
- **Operator Access**: Generate dynamic `.conf` profiles or mobile QR codes in seconds for instant developer access to private internal services.

### 🔄 2. Blue/Green Zero-Downtime GitOps
- **Production Pre-Warming**: Pulls new Docker images, starts the target container, and validates HTTP health checks before swapping traffic.
- **Traefik Dynamic Routing**: Live router hot-swap with 0 dropped in-flight requests.
- **Automatic Rollback**: Instant fallback to the previous healthy container if migration or readiness probes fail.

### 💾 3. Automated Database Safety & R2 Backups
- **Pre-Deploy Snapshots**: Automatically streams compressed PostgreSQL backups (`pg_dump`) directly to Cloudflare R2 before running schema migrations.
- **Zero Egress Fees**: Eliminates cloud egress transfer costs entirely through Cloudflare R2's S3-compatible architecture.

### 🛡️ 4. Kernel OOM Protection & Governance
- **Self-Preservation**: Auto-configures `/proc/self/oom_score_adj = -1000` so the daemon survives under severe host memory exhaustion.
- **Container Prioritization**: Adjusts scores across workloads (`-900` for databases, `-800` for caches, `+500` for background queue workers).

### 📊 5. Edge Observability & Resilient WAL
- **Host & Container Metrics**: Real-time collection of CPU, Memory, Disk, Load Averages, and OS reboot requirements.
- **Local Write-Ahead Log (WAL)**: Telemetry and logs are buffered on disk during network disconnects and flushed when connectivity recovers.

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

## ⚙️ Configuration

Configuration is loaded dynamically from:
1. CLI Flags (`--config`, `--node-id`, `--control-url`)
2. Environment Variables (`KIWID_NODE_ID`, `KIWID_CONTROL_URL`, `KIWID_ENROLL_TOKEN`)
3. YAML Configuration (`/etc/kiwid/agent.yaml` on Linux, `$ProgramData\FlareLens\agent.yaml` on Windows)

### Sample `agent.yaml`

```yaml
identity:
  node_id: "node-fra-01"
  hostname: "app-prod-1"
  region: "fra1"
  tags: ["app", "prod"]

control_plane:
  endpoint: "https://control.flarelens.dev"
  heartbeat_interval: 15s

mesh:
  enabled: true
  listen_port: 51820
  interface_name: "flarelens0"

telemetry:
  log_level: "info"
  metrics_interval: 10s

database:
  mode: "host_native"
  host: "localhost"
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
- Docker (optional, for Blue/Green deploy testing)

```bash
# Clone repository
git clone https://github.com/antwig2/flarelens.git
cd flarelens

# Run test suite
go test -v ./...

# Build binary locally
go build -ldflags="-s -w" -o bin/flarelens-agent ./cmd/agent

# Cross-compile matrix
make cross-compile
```

---

## 📄 License

Licensed under the [Apache License, Version 2.0](LICENSE).  
Copyright &copy; 2026 FlareLens Authors.
