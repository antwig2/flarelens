# FlareLens

### Open-source Infrastructure Operations & Security Platform

Manage servers, deploy applications, secure private networks, and monitor your infrastructure from one serverless control plane.

[Website](https://flarelens.dev/) · [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens) · [Host Agent](https://github.com/antwig2/flarelensd) · [Releases](https://github.com/antwig2/flarelens/releases)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens)
[![Latest release](https://img.shields.io/github/v/release/antwig2/flarelens?label=release&color=f38020)](https://github.com/antwig2/flarelens/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-555)](LICENSE)

FlareLens is an open-source platform for managing infrastructure across cloud, on-premises, and hybrid environments. Built with Cloudflare Workers and a lightweight Go host agent (`flarelensd`), it brings infrastructure management, secure networking, application deployments, secrets management, and observability into one platform.

---

## Features

- **Infrastructure Management** — Manage servers, virtual machines, containers, and services from one dashboard.
- **Secure Networking** — Connect servers and workstations through private, encrypted WireGuard networking.
- **Application Deployments** — Automate container deployments with blue/green releases, health checks, and rollback support.
- **Secrets Management** — Securely store and distribute encrypted secrets and application configurations.
- **Monitoring & Observability** — Collect logs, monitor system health, track uptime, and analyze telemetry using Cloudflare R2.
- **Resilience & Recovery** — Manage backups and keep existing workloads running during control-plane connectivity interruptions.

## Quick Start

### 1. Deploy the control plane

Deploy FlareLens to your Cloudflare account:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens)

Or deploy manually:

```sh
git clone https://github.com/antwig2/flarelens.git
cd flarelens
npm install
npx wrangler kv namespace create FLEET_KV
npx wrangler r2 bucket create flarelens-logs
cp wrangler.toml.example wrangler.toml
npm run deploy
```

### 2. Connect a server

Install the FlareLens agent on a Linux server:

```sh
curl -fsSL "https://<your-worker-url>/install.sh?token=<YOUR_ENROLL_TOKEN>" | sudo bash
```

### 3. Connect a workstation

Join your private network using browser-based authentication:

```sh
sudo flarelensd login --control=https://<your-worker-url>
```

## Architecture

FlareLens uses a serverless control plane and lightweight host agents:

- **Control Plane** — Runs on Cloudflare Workers and manages infrastructure configuration, authentication, deployments, and monitoring.
- **Host Agent (`flarelensd`)** — Runs on managed machines and handles networking, application deployments, secrets, and telemetry.
- **Private Network** — Uses WireGuard to establish encrypted connections between infrastructure nodes.

Workloads continue running independently of the control plane.

## Components

| Component | Description | Repository |
|-----------|-------------|------------|
| **Control Plane** | Dashboard, APIs, authentication, and infrastructure management | [flarelens](https://github.com/antwig2/flarelens) |
| **Host Agent** | Lightweight Go daemon for networking, deployments, and monitoring | [flarelensd](https://github.com/antwig2/flarelensd) |

## Documentation

- [Website & Features](https://flarelens.dev/)
- [Host Agent Guide](https://github.com/antwig2/flarelensd)
- [Self-Hosting Guide](https://flarelens.dev/docs/self-hosting)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](https://github.com/antwig2/flarelens/blob/main/CONTRIBUTING.md) and [SECURITY.md](https://github.com/antwig2/flarelens/blob/main/SECURITY.md).

## License

FlareLens is licensed under [Apache License 2.0](https://github.com/antwig2/flarelens/blob/main/LICENSE).
