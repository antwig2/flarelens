# FlareLens Host Agent (`flarelens-agent`)

The official high-performance, cross-platform host agent and P2P WireGuard mesh daemon for the **FlareLens Unified Edge Control Plane**.

[![CI](https://github.com/antwig2/flarelens/actions/workflows/ci.yml/badge.svg)](https://github.com/antwig2/flarelens/actions/workflows/ci.yml)
[![Release](https://github.com/antwig2/flarelens/actions/workflows/release.yml/badge.svg)](https://github.com/antwig2/flarelens/actions/workflows/release.yml)
[![Go Report Card](https://goreportcard.com/badge/github.com/antwig2/flarelens)](https://goreportcard.com/report/github.com/antwig2/flarelens)

---

## ⚡ What is FlareLens Agent?

`flarelens-agent` is a single static Go binary designed to run on any host—from a $10/mo bare-metal VM up to multi-cloud fleets. It connects back to your Cloudflare Workers edge control plane via NATS WebSocket / TLS tunnels, replacing 15 disparate commercial tools (Datadog, ArgoCD, Ansible, Tailscale, Vault, LaunchDarkly, ManageEngine PAM360, etc.) with zero egress costs.

### Key Capabilities

1. **Kernel-Level WireGuard Mesh (Tailscale / PAM360 Alternative)**:
   - Automated Curve25519 key generation (`RFC 7748`).
   - Pure P2P UDP overlay network (`flarelens0`) with $0 egress.
   - Operators can connect securely from Windows, Linux, or macOS without third-party VPN clients.
2. **Zero-Downtime Blue/Green Deployments**:
   - Docker engine orchestration with pre-warming and Traefik dynamic router traffic swapping.
   - 30-second health check polling and zero dropped in-flight requests.
3. **Automated Database Migrations & Rollback Guardrails**:
   - Automatic pre-deploy database snapshot (`pg_dump` streamed directly to Cloudflare R2).
   - Atomic rollback execution if migration fails or health check times out.
4. **Kernel OOM Protection & Score Governance**:
   - Host daemon auto-configured with `/proc/self/oom_score_adj = -1000`.
   - Dynamic container OOM protection (-900 for PostgreSQL, -800 for Redis, +500 for background workers).
5. **Real-Time Telemetry & Local WAL Buffer**:
   - Host metrics (CPU, RAM, Disk, Load, Uptime, Pending OS Reboots).
   - Ephemeral disk WAL buffer so no telemetry or logs are lost during network blips.
6. **Cross-Platform Native Support**:
   - Linux (x86_64, ARM64)
   - Windows (x86_64 PE64 executable)
   - macOS (Intel & Apple Silicon)

---

## 🚀 Quick Install

### Linux (30-Second Bootstrap)

```bash
curl -fsSL https://control.flarelens.dev/install.sh | sudo bash -s -- \
  --control "https://control.flarelens.dev" \
  --token "your-enrollment-token"
```

### Windows (PowerShell 1-Liner)

Open PowerShell as Administrator:

```powershell
iwr -useb https://control.flarelens.dev/install.ps1 | iex
```

### Manual Download

Download pre-compiled binaries from [GitHub Releases](https://github.com/antwig2/flarelens/releases):

| OS | Architecture | Binary Asset | Archive |
| :--- | :--- | :--- | :--- |
| **Linux** | x86_64 (amd64) | `flarelens-agent-linux-amd64` | `.tar.gz` |
| **Linux** | ARM64 (aarch64) | `flarelens-agent-linux-arm64` | `.tar.gz` |
| **Windows** | x86_64 (amd64) | `flarelens-agent-windows-amd64.exe` | `.zip` |
| **macOS** | Apple Silicon | `flarelens-agent-darwin-arm64` | `.tar.gz` |
| **macOS** | Intel (amd64) | `flarelens-agent-darwin-amd64` | `.tar.gz` |

---

## ⚙️ Configuration

Configuration is loaded in the following order of precedence:
1. CLI Flags (`--config`, `--node-id`, `--control-url`, etc.)
2. Environment Variables (`KIWID_NODE_ID`, `KIWID_CONTROL_URL`, `KIWID_ENROLL_TOKEN`)
3. YAML Configuration File (`/etc/kiwid/agent.yaml` on Linux, `$ProgramData\FlareLens\agent.yaml` on Windows)
4. Built-in Production Defaults

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
# Print version and build metadata
flarelens-agent --version

# Run daemon with custom config
flarelens-agent --config /etc/kiwid/agent.yaml

# Run in development mode
flarelens-agent --dev --log-level debug

# Override mesh port and control URL
flarelens-agent --mesh-port 51820 --control-url https://control.flarelens.dev
```

---

## 🏗️ Development & Building

### Prerequisites

- Go 1.22+ installed
- Docker daemon running (optional for container deploy testing)

### Build Locally

```bash
# Build for host architecture
go build -o bin/flarelens-agent ./cmd/agent

# Test all packages
go test -v ./...

# Cross-compile for Windows
GOOS=windows GOARCH=amd64 go build -o bin/flarelens-agent.exe ./cmd/agent

# Cross-compile for Linux ARM64
GOOS=linux GOARCH=arm64 go build -o bin/flarelens-agent-arm64 ./cmd/agent
```

### Release Build with GoReleaser

```bash
# Verify GoReleaser configuration
goreleaser check

# Generate snapshot release locally
goreleaser release --snapshot --clean
```

---

## 📄 License

Apache 2.0. Copyright &copy; 2026 FlareLens Authors.
