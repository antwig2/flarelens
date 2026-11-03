# FlareLens

> **Your infrastructure. One control plane.**

FlareLens is an open-source infrastructure operations and security platform that brings server management, private networking, automated deployments, secrets, access control, and observability into one unified experience.

Built on Cloudflare Workers and a lightweight Go host agent, FlareLens helps engineering teams manage infrastructure across public clouds, private data centers, bare-metal servers, and hybrid environments without introducing unnecessary operational complexity.

*Manage what you own. Secure what you connect. See everything that matters.*

[![Website](https://img.shields.io/badge/Website-flarelens.dev-blue)](https://flarelens.dev/)
[![GitHub](https://img.shields.io/badge/GitHub-antwig2%2Fflarelens-181717?logo=github)](https://github.com/antwig2/flarelens)
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens)
[![Host Daemon](https://img.shields.io/badge/Daemon-flarelensd_(Go)-00ADD8?style=flat&logo=go)](https://github.com/antwig2/flarelensd)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

[Website](https://flarelens.dev/) · [GitHub](https://github.com/antwig2/flarelens) · [Host Agent (`flarelensd`)](https://github.com/antwig2/flarelensd) · [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens)

---

## Infrastructure operations, simplified.

Modern infrastructure is distributed across cloud providers, virtual machines, private networks, containers, and developer environments.

Managing it often means combining several independent tools for provisioning, networking, deployment, security, monitoring, and incident response. Each tool introduces another dashboard, configuration model, integration, and operational dependency.

**FlareLens brings these capabilities together.**

Instead of assembling and maintaining a fragmented infrastructure management stack, engineering teams can operate their environments through one coordinated control plane.

FlareLens is designed around three principles:

1. **Unified operations**: Manage infrastructure, connectivity, deployments, and telemetry in one place.
2. **Infrastructure ownership**: Keep applications and workloads running in environments you control.
3. **Operational simplicity**: Reduce the number of components required to operate reliable infrastructure.

---

## Everything you need to operate your infrastructure.

### 🖥️ Fleet Management
*Know what is running, where it is running, and how it is performing.*
* Discover, register, and manage servers across your organisation.
* Maintain an inventory of connected hosts, operating systems, hardware resources, services, and operational status from a central dashboard.
* Monitor resource utilisation, track configuration changes, and coordinate desired-state reconciliation across managed nodes.

### 🌐 Private Networking
*Connect your infrastructure securely, wherever it runs.*
* Build encrypted private networks between servers, developer workstations, databases, and internal services using WireGuard.
* FlareLens coordinates peer discovery, network identities, and private service resolution without requiring a traditional central VPN concentrator for direct peer connections.
* Connect infrastructure across multiple cloud providers and private environments while keeping internal services off the public internet.

### 🚀 Deployment Automation
*Ship changes with confidence.*
* Coordinate application deployments across managed hosts using Git-driven workflows.
* Manage container workloads, deployment configurations, release health checks, and traffic routing through a central interface.
* Support blue/green deployment strategies, controlled releases, and automated rollback when application health checks fail.

### 🔐 Secrets Management
*Protect sensitive configuration throughout its lifecycle.*
* Manage application credentials, API keys, certificates, and runtime configuration from a central secrets interface.
* Use encrypted storage, controlled distribution, and role-based access to reduce dependence on manually maintained configuration files.
* Integrate secrets delivery into deployment workflows while minimising unnecessary exposure to operators and applications.

### 📊 Observability
*Understand what is happening across your infrastructure.*
* Collect and explore infrastructure metrics, application logs, container events, and operational signals through a unified monitoring experience.
* FlareLens uses a storage-oriented telemetry architecture built around Cloudflare R2, Apache Parquet, and DuckDB to support cost-conscious historical analysis.
* Move from fleet overview to individual host diagnostics without switching between multiple monitoring platforms.

### 🛡️ Identity & Access
*Give the right people the right access.*
* Centralise administrative authentication, infrastructure permissions, and operational audit trails.
* Integrate identity providers through SSO and OIDC, manage role-based permissions, and support identity-aware access to infrastructure services.
* Keep infrastructure operations accountable and traceable.

---

## Designed for the infrastructure you already have.

FlareLens works around your existing infrastructure rather than requiring you to migrate workloads to a new hosting environment.

| Environment | Examples |
| :--- | :--- |
| **Public cloud** | AWS, Azure, Google Cloud |
| **Cloud VPS** | Hetzner, DigitalOcean, other VPS providers |
| **Private infrastructure** | Bare-metal servers, on-premises data centers |
| **Container workloads** | Docker-based applications and services |
| **Developer environments** | Linux, macOS, and Windows workstations |
| **Distributed systems** | Database hosts, internal services, edge gateways |

*Your infrastructure remains yours. FlareLens provides a coordinated operational layer above it.*

---

## Architecture: A lightweight control plane. A direct data plane.

FlareLens separates infrastructure coordination from application execution and network traffic. This separation is central to its architecture.

### Control Plane — Cloudflare Workers
The control plane manages the shared operational state of your organisation's infrastructure. Its responsibilities include:
* Fleet inventory and desired-state configuration
* WireGuard peer discovery and coordination
* Authentication and access policies
* Encrypted secrets management
* Deployment orchestration and signalling
* Telemetry ingestion and operational metadata

The control plane is built using TypeScript and Cloudflare's serverless platform, reducing the need to operate dedicated management servers.

### Host Agent — `flarelensd`
The data-plane agent is a lightweight Go service installed on managed infrastructure. It is responsible for local execution and coordination, including:
* Reporting host health and operational state
* Managing local network configuration
* Monitoring containers and services
* Executing authorised deployment operations
* Collecting and forwarding telemetry
* Reconciling local configuration with desired state

The host agent is designed to preserve running workloads when control-plane connectivity is interrupted.

### Private Data Plane — WireGuard
Where direct peer-to-peer connectivity is available, WireGuard carries encrypted infrastructure traffic between participating nodes.

Cloudflare Workers coordinate control-plane operations rather than serving as the default application-traffic router. This allows infrastructure traffic to remain separate from control-plane signalling.

### Architectural Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                   FLARELENS INFRASTRUCTURE CONTROL PLANE               │
│                            Cloudflare Workers                          │
│                                                                        │
│   ┌──────────────────────────────┬─────────────────────────────────┐   │
│   │     Fleet & Ops              │   Security & Mesh               │   │
│   │     Observability Lakehouse  │   Secrets Vault & Access Gate   │   │
│   └──────────────────────────────┴─────────────────────────────────┘   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Secure Control Channel (TLS)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        flarelensd Host Agents                          │
│                                                                        │
│        [ Cloud VMs ]        [ Bare Metal ]        [ On-Prem ]          │
│              ▲                     ▲                   ▲               │
│              └═════════════════════╬═══════════════════┘               │
│                                    ▼                                   │
│                        WireGuard Encrypted Mesh                        │
│                         (Direct P2P UDP Line-Speed)                    │
│                                                                        │
│                         Applications & Services                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Built for reliability and operational independence.

Infrastructure should not stop functioning simply because a management dashboard becomes unavailable.

FlareLens is designed to separate the availability of the control plane from the availability of the workloads it manages. Running containers, existing network interfaces, and established service routes can continue operating independently of temporary control-plane interruptions.

The platform also aims to minimise infrastructure overhead by using managed serverless services for coordination and lightweight agents for local execution.

---

## Technology Stack

| Layer | Technology |
| :--- | :--- |
| **Control plane** | TypeScript, Cloudflare Workers |
| **Host agent** | Go (`flarelensd`) |
| **Private networking** | WireGuard |
| **Identity** | Cloudflare Access, OIDC |
| **Metadata and state** | Cloudflare Workers KV |
| **Object storage** | Cloudflare R2 |
| **Telemetry formats** | Apache Parquet |
| **Analytics** | DuckDB |
| **Application runtime** | Docker |
| **Ingress management** | Traefik |
| **Deployment integration** | GitHub Actions |

---

## Getting Started

### 1. Deploy the Control Plane

FlareLens is designed to be deployed to your own Cloudflare account.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens)

Alternatively, deploy manually using Wrangler.

> **Prerequisites**: Node.js, npm, Wrangler CLI, and a Cloudflare account.

```bash
git clone https://github.com/antwig2/flarelens.git
cd flarelens
npm install

# Create required KV namespace and R2 bucket
npx wrangler kv namespace create FLEET_KV
npx wrangler r2 bucket create flarelens-logs

# Configure bindings and deploy
cp wrangler.toml.example wrangler.toml
# (Configure the required bindings in wrangler.toml)
npm run deploy
```

### 2. Enroll a Managed Server

After deploying the control plane, generate an enrollment token and install the host agent on a supported machine:

```bash
curl -fsSL https://<your-worker-url>/install.sh \
  | sudo bash -s -- \
  --control "https://<your-worker-url>" \
  --token "<YOUR_ENROLL_TOKEN>"
```

*For production environments, review and verify installer scripts before executing them with elevated privileges.*

### 3. Connect a Developer Workstation

Use the host agent to initiate identity-based authentication and join an authorised infrastructure network:

```bash
sudo flarelensd login \
  --control=https://<your-worker-url>
```

Consult the [host-agent documentation](https://github.com/antwig2/flarelensd) for platform-specific installation and networking requirements.

---

## Cost-conscious by design

FlareLens is designed to minimise the recurring infrastructure costs associated with operating a central management platform.

Its architecture takes advantage of Cloudflare Workers, KV, R2, and related managed services while using host agents for workload-local operations.

* **Small installations** may fit within available free-tier allowances, depending on usage, workload characteristics, and current Cloudflare limits.
* **Production costs** depend on fleet size, telemetry volume, request frequency, storage utilisation, and the Cloudflare services enabled.

The goal is to make infrastructure operations more accessible without requiring a large dedicated management stack.

---

## Open source and extensible

FlareLens is developed as an open-source platform for teams that want greater visibility and control over how their infrastructure is operated.

Its modular architecture creates opportunities to extend capabilities for different infrastructure environments, deployment strategies, and organisational policies.

Contributions, bug reports, and feature requests are welcome.

* [Source repository](https://github.com/antwig2/flarelens)
* [Host agent (`flarelensd`)](https://github.com/antwig2/flarelensd)
* [Issues](https://github.com/antwig2/flarelens/issues)
* [Discussions](https://github.com/antwig2/flarelens/discussions)

---

## License

FlareLens is licensed under the [Apache License, Version 2.0](LICENSE).

---

**FlareLens**  
*Your infrastructure. Your control. One platform.*
