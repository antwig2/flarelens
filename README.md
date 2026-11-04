<p align="center">
  <h1 align="center">FlareLens</h1>
  <b>Your infrastructure. One serverless control plane.</b><br>
  Unified fleet management, peer-to-peer WireGuard networking, atomic blue/green deployments, encrypted secrets, and R2 lakehouse observability.
</p>

<p align="center">
  <a href="https://flarelens.dev/">Website</a> ·
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens">Deploy to Cloudflare</a> ·
  <a href="https://github.com/antwig2/flarelensd">Host Agent (flarelensd)</a> ·
  <a href="https://github.com/antwig2/flarelens/releases">Releases</a>
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens"><img alt="Deploy to Cloudflare Workers" src="https://deploy.workers.cloudflare.com/button"></a>
  <a href="https://github.com/antwig2/flarelens/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/antwig2/flarelens?label=release&color=f38020"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-555"></a>
</p>

---

FlareLens is an open-source infrastructure operations and security platform built on Cloudflare Workers and a lightweight Go host daemon (`flarelensd`). It replaces fragmented management stacks with a single sovereign control plane running at the edge.

*Manage what you own. Secure what you connect. See everything that matters.*

## Why FlareLens

- **Zero coordinator servers**: The entire control plane runs serverlessly on Cloudflare Workers and KV. No management VMs, databases, or bastions to patch.
- **P2P encrypted mesh**: Direct point-to-point WireGuard overlay across clouds, bare-metal, and workstations with < 0.1 ms overhead and zero open firewall ports.
- **Zero-downtime rollouts**: Git-driven blue/green container deployments with inotify Traefik routing swaps in < 1 ms and automatic database snapshot rollbacks.
- **Zero-plaintext secrets**: AES-256-GCM encrypted secrets vault at the edge, injected directly into container RAM with no unencrypted `.env` files on disk.
- **Edge lakehouse observability**: Stores compressed columnar Parquet telemetry directly in Cloudflare R2 with DuckDB analytics and $0 egress fees.
- **Sovereign & resilient**: Host agents (`flarelensd`) keep existing workloads and local network routes operating continuously even if control-plane connectivity drops.

## Quick start

### 1. Deploy the control plane

One-click deploy to your Cloudflare account:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens)

Or deploy manually with Wrangler:

```sh
git clone https://github.com/antwig2/flarelens.git && cd flarelens
npm install
npx wrangler kv namespace create FLEET_KV
npx wrangler r2 bucket create flarelens-logs
cp wrangler.toml.example wrangler.toml
npm run deploy
```

### 2. Enroll a server

Run the installer on any Linux server, cloud VM, or bare-metal host:

```sh
curl -fsSL https://<your-worker-url>/install.sh | sudo bash -s -- \
  --control "https://<your-worker-url>" \
  --token "<YOUR_ENROLL_TOKEN>"
```

### 3. Join the mesh from a workstation

Connect your laptop or workstation with RFC 8628 browser SSO:

```sh
sudo flarelensd login --control=https://<your-worker-url>
```

## How it works

```
[ Operator / Browser ] ── HTTPS / SSO ──┐
                                         ▼
                             ┌───────────────────────┐
                             │   Cloudflare Workers  │ (Control Plane)
                             │  KV / R2 Parquet / WAF│
                             └───────────┬───────────┘
                                         │ Secure TLS Signals
                                         ▼
┌──────────────────────────────── flarelensd ────────────────────────────────┐
│  Cloud VM / Bare Metal                 │  Container Host / Workstation     │
│  ├─ Docker / Systemd                   │  ├─ Blue/Green Traefik Swap (<1ms)│
│  └─ RAM Secrets Injection              │  └─ Ephemeral PR Previews         │
│                     ◄─── WireGuard Mesh (P2P) ───►                         │
└────────────────────────────────────────────────────────────────────────────┘
```

The serverless control plane coordinates state, secrets, and WireGuard discovery without touching data traffic. Workload traffic flows peer-to-peer over WireGuard.

## Ecosystem

| Component | Description | Repository |
|-----------|-------------|------------|
| **Control Plane** | Serverless API, UI dashboard, secrets vault & auth gate | [antwig2/flarelens](https://github.com/antwig2/flarelens) |
| **`flarelensd`** | Lightweight Go host agent, WireGuard manager & rollout engine | [antwig2/flarelensd](https://github.com/antwig2/flarelensd) |

## Documentation

- [Features & Architecture](https://flarelens.dev/)
- [Host Daemon Guide](https://github.com/antwig2/flarelensd)
- [Self-Hosting Guide](https://flarelens.dev/docs/self-hosting)

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE).
