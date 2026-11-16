/**
 * Canonical documentation content for flarelens.dev/docs/* and /llms-full.txt.
 *
 * Structured around:
 *  - Group I: Foundation — The 3 Self-Hosted PaaS Layers
 *  - Group II: Core Platform Capabilities — The 6 PaaS Pillars
 *  - Group III: Reference — CLI, Declarative Schema, OIDC & Management API
 */

export const DOC_GROUPS = [
  {
    id: 'foundation',
    title: 'Foundation',
    subtitle: 'Self-hosted PaaS architecture, control plane setup, and server enrollment.',
    slugs: ['getting-started', 'architecture'],
  },
  {
    id: 'capabilities',
    title: 'Core Platform Capabilities',
    subtitle: 'The six integrated PaaS modules for running stateful and stateless workloads on servers you own.',
    slugs: ['fleet', 'deployments', 'mesh', 'observability', 'secrets-and-flags', 'backups'],
  },
  {
    id: 'reference',
    title: 'Reference & Ecosystem',
    subtitle: 'Declarative manifest schema, host daemon CLI, GitHub OIDC CI/CD, and HTTP endpoints.',
    slugs: ['reference'],
  },
];

export const DOC_PAGES = [
  {
    slug: 'getting-started',
    group: 'foundation',
    kicker: 'Quickstart',
    cardTitle: 'Getting started',
    cardDesc: 'Deploy the Cloudflare control plane ($0 free tier), enroll servers, and launch your first service.',
    title: 'Getting Started',
    lead: 'FlareLens is an open-source, self-hosted Platform-as-a-Service (BYOC PaaS). You deploy the serverless control plane in your own Cloudflare account and run the lightweight Go agent on your own Linux, macOS, or bare-metal hosts.',
    sections: [
      {
        id: 'deploy-control-plane',
        heading: '1. Deploy the Control Plane',
        blocks: [
          {
            type: 'p',
            html: 'Your control plane runs entirely on Cloudflare Workers, D1 (SQLite), Workers KV, and R2 object storage—eliminating the dedicated management VM required by traditional self-hosted PaaS tools. Small and medium fleets fit comfortably inside Cloudflare’s <strong>$0/month Free Tier</strong>.',
          },
          {
            type: 'p',
            html: 'You can provision everything via the <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/antwig2/flarelens" target="_blank" rel="noopener noreferrer">Deploy to Cloudflare</a> button or directly from a terminal with Wrangler:',
          },
          {
            type: 'code',
            id: 'gs-cp-deploy',
            label: 'Control Plane Provisioning · bash',
            copyLabel: 'Copy control plane provisioning commands',
            code: `git clone https://github.com/antwig2/flarelens.git && cd flarelens
npm install

# Create D1 database, KV namespace, and R2 bucket (if not using 1-click deploy)
npx wrangler d1 migrations apply flarelens-db --remote

# Configure required edge secrets
npx wrangler secret put INGEST_SECRET        # Shared HMAC/Bearer token for enrolled agents
npx wrangler secret put DASHBOARD_PASSWORD   # Operator console password
npx wrangler secret put VAULT_MASTER_KEY     # 32-byte key for AES-256-GCM secret encryption

# Deploy Worker + Console UI
npx wrangler deploy`,
          },
          {
            type: 'callout',
            html: '<strong>Custom Domain:</strong> Attach a custom domain (for example <code>ops.example.com</code>) in the Cloudflare Workers dashboard under <em>Settings → Domains &amp; Routes</em> for automatic TLS certificates and WebSocket/SSE streaming.',
          },
        ],
      },
      {
        id: 'enroll-servers',
        heading: '2. Enroll Your Servers',
        blocks: [
          {
            type: 'p',
            html: 'Install <code>flarelensd</code> (~15 MB static Go binary) on any cloud VM, dedicated bare-metal host, or on-premises server running Docker Engine. The installer downloads a SHA-256 verified release binary, writes <code>/etc/flarelens/agent.toml</code>, generates a host Curve25519 WireGuard keypair, and registers a hardened <code>systemd</code> unit.',
          },
          {
            type: 'code',
            id: 'gs-enroll-linux',
            label: 'Linux / macOS Host Enrollment · bash',
            copyLabel: 'Copy Linux enrollment command',
            code: `curl -fsSL https://flarelens.dev/install.sh | sudo bash -s -- \\
  --endpoint https://ops.example.com \\
  --token "<YOUR_INGEST_SECRET>" \\
  --tags "role=app,env=prod,region=eu-central"`,
          },
          {
            type: 'p',
            html: 'For Windows Server hosts, run the PowerShell installer from an elevated prompt:',
          },
          {
            type: 'code',
            id: 'gs-enroll-win',
            label: 'Windows Server Enrollment · powershell',
            copyLabel: 'Copy PowerShell enrollment command',
            code: `irm https://flarelens.dev/install.ps1 | iex`,
          },
          {
            type: 'p',
            html: 'Within 15 seconds, the server appears as <strong>Online</strong> under <strong>Fleet Management</strong> with live CPU, RAM, disk, OS, and container telemetry.',
          },
        ],
      },
      {
        id: 'deploy-first-service',
        heading: '3. Launch Your First Workload',
        blocks: [
          {
            type: 'p',
            html: 'Open your FlareLens console, navigate to <strong>Deployments → New Service</strong>, and either pick a 1-click preset (PostgreSQL, Redis, Traefik, Worker, HTTP API) or define a service directly in the UI—no Git repository required:',
          },
          {
            type: 'code',
            id: 'gs-first-manifest',
            label: 'Declarative Workload Spec · YAML',
            copyLabel: 'Copy example workload manifest',
            code: `# $schema: https://flarelens.dev/schemas/fleet.schema.json
name: checkout-api
env: prod
strategy: blue_green
enabled: true

image: ghcr.io/acme/checkout-api:v1.4.0
domain: api.example.com
internal_port: 8080
health_path: /healthz

placement:
  strategy: spread
  replicas: 2
  required_tags: ["role=app", "env=prod"]

resources:
  memory_mb: 512
  cpu_cores: 1.0`,
          },
          {
            type: 'p',
            html: 'Saving the service records immutable revision <code>rev-1</code> in D1 + R2, schedules replicas across matching hosts, verifies <code>/healthz</code>, and atomically routes traffic through Traefik.',
          },
        ],
      },
    ],
  },

  {
    slug: 'architecture',
    group: 'foundation',
    kicker: 'System Design',
    cardTitle: 'Platform architecture',
    cardDesc: 'How the serverless Cloudflare control plane, flarelensd daemon, and P2P WireGuard mesh fit together.',
    title: 'Platform Architecture',
    lead: 'FlareLens separates orchestration state from workload execution across three clean layers—delivering a full Platform-as-a-Service experience while keeping compute, network traffic, and persistent data strictly on infrastructure you control.',
    sections: [
      {
        id: 'three-layers',
        heading: 'The Three PaaS Layers',
        blocks: [
          {
            type: 'table',
            caption: 'FlareLens three-part platform architecture',
            headers: ['Layer', 'Runtime', 'Responsibilities'],
            rows: [
              [
                '1. Serverless Control Plane',
                'Cloudflare Workers + D1 + KV + R2',
                'Operator dashboard, multi-server placement scheduler, immutable fleet revisions (rev-N), AES-256-GCM secret vault, WireGuard peer coordination, R2 Parquet log lakehouse, and streaming backup catalog.',
              ],
              [
                '2. Host Agent (flarelensd)',
                'Static Go binary on each host',
                'Docker container reconciliation, atomic <1ms Blue/Green Traefik swaps, Linux kernel cgroup enforcement, ephemeral /dev/shm secret mounts, streaming io.Pipe pg_dump backups, and 15s telemetry.',
              ],
              [
                '3. Private Overlay Mesh',
                'Kernel/Userspace WireGuard + MagicDNS',
                'Direct peer-to-peer ChaCha20-Poly1305 encrypted tunnels (100.64.0.0/10) between hosts and operator laptops, plus embedded <overlay_ip>:53 split-horizon DNS (*.mesh, TTL 5s).',
              ],
            ],
          },
          {
            type: 'callout',
            html: '<strong>Zero Cloudflare Data-Plane Proxy Tax:</strong> Application traffic and cross-server database queries travel directly to your hosts or over peer-to-peer WireGuard UDP tunnels—never hairpinned through Cloudflare Workers.',
          },
        ],
      },
      {
        id: 'heartbeat-protocol',
        heading: '15-Second Piggybacked Sync Protocol',
        blocks: [
          {
            type: 'p',
            html: 'Hosts require <strong>zero inbound management ports</strong> (no exposed SSH or Docker TCP sockets). Every 15 seconds, <code>flarelensd</code> sends an outbound HTTPS heartbeat to <code>POST /api/v1/ingest</code> containing host metrics and active container states, and receives a single piggybacked control envelope:',
          },
          {
            type: 'ul',
            items: [
              '<strong><code>commands[]</code></strong> — Pending deploy, blue/green swap, live cgroup resize, backup, restore, image prune, drain, or OTA self-update instructions.',
              '<strong><code>mesh_peers[]</code></strong> — Authenticated WireGuard public keys, endpoints, and <code>100.64.0.x/32</code> peer routes.',
              '<strong><code>cluster_endpoints{}</code></strong> — Healthy replica IP:port maps powering local WireGuard service forwarding and split-horizon <code>MagicDNS</code>.',
              '<strong><code>flags_version</code></strong> — Monotonic counter triggering delta fetches only when runtime feature flags actually change.',
            ],
          },
          {
            type: 'p',
            html: 'Because desired state lives in D1 and KV pointers rather than polling object storage listings, steady-state operation performs <strong>zero R2 <code>list()</code> calls</strong>.',
          },
        ],
      },
      {
        id: 'sovereign-autonomy',
        heading: 'Control-Plane Outage Resilience',
        blocks: [
          {
            type: 'p',
            html: 'Your data plane is autonomous. If Cloudflare or external WAN routing is temporarily unreachable:',
          },
          {
            type: 'ul',
            items: [
              'Running Docker containers, kernel cgroup protections, and Traefik/Caddy TLS ingress continue serving user traffic locally without interruption.',
              'Existing peer-to-peer WireGuard tunnels and local <code>MagicDNS</code> caches keep cross-host service-to-service calls working.',
              '<code>flarelensd</code> buffers outbound telemetry in bounded memory and reconciles pending revisions automatically as soon as connectivity returns.',
            ],
          },
        ],
      },
    ],
  },

  {
    slug: 'fleet',
    group: 'capabilities',
    kicker: 'Pillar 01 · Servers and Workloads',
    cardTitle: 'Fleet Management',
    cardDesc: 'Multi-server placement, hard Docker RAM/CPU cgroups, stateful volume fencing, and automated image pruning.',
    title: 'Fleet Management',
    lead: 'Group heterogeneous cloud VMs and bare-metal servers into one logical compute pool with tag-aware placement, hard Linux kernel resource isolation, live zero-restart database resizing, and safe maintenance draining.',
    sections: [
      {
        id: 'workload-kinds',
        heading: 'Workload Lifecycles: Blue/Green vs Singleton',
        blocks: [
          {
            type: 'p',
            html: 'FlareLens models every container workload cleanly according to whether it is stateless or stateful:',
          },
          {
            type: 'table',
            caption: 'Supported workload lifecycle strategies',
            headers: ['Strategy', 'Target Workloads', 'Runtime Behavior'],
            rows: [
              [
                'blue_green',
                'HTTP APIs, web frontends, background workers',
                'Boots candidate slot (-blue or -green) alongside live containers, runs migrations and health probes, swaps Traefik upstream in <1ms, and drains old connections.',
              ],
              [
                'singleton',
                'PostgreSQL, Redis, stateful brokers',
                'Enforces single-writer volume safety, pins to stateful storage hosts, and applies CPU/RAM cgroup changes in-place without container restarts when image/env are unchanged.',
              ],
              [
                'singleton + adopt_only',
                'Traefik ingress, host-level system daemons',
                'Monitors health, logs, and cgroup metrics of pre-existing foundational containers without recreating or replacing them during fleet syncs.',
              ],
            ],
          },
        ],
      },
      {
        id: 'placement-scheduler',
        heading: 'Multi-Server Placement Scheduler',
        blocks: [
          {
            type: 'p',
            html: 'Each node carries arbitrary key-value labels (such as <code>role=app</code>, <code>disk=nvme</code>, <code>region=us-east</code>). When scheduling replicas, the Control Plane filters healthy, uncordoned nodes matching <code>placement.required_tags</code> with sufficient unreserved RAM and applies one of three strategies:',
          },
          {
            type: 'ul',
            items: [
              '<strong><code>spread</code></strong> — Distributes replicas evenly across distinct failure domains and hosts to maximize availability.',
              '<strong><code>binpack</code></strong> — Packs workloads tightly onto the highest-utilized eligible servers so idle nodes can be retired.',
              '<strong><code>pinned</code></strong> — Locks stateful workloads deterministically to an explicit <code>node_id</code> where persistent volumes reside.',
            ],
          },
        ],
      },
      {
        id: 'cgroups-and-live-update',
        heading: 'Hard Kernel Cgroups & Zero-Restart DB Resizing',
        blocks: [
          {
            type: 'p',
            html: 'Resource declarations under <code>resources</code> (and optional background worker overrides under <code>worker.resources</code>) are enforced both by the Control Plane scheduler and directly by <code>flarelensd</code> in the Linux kernel via Docker Engine <code>HostConfig</code>:',
          },
          {
            type: 'code',
            id: 'fleet-cgroups-spec',
            label: 'Workload & Worker Resource Caps · YAML',
            copyLabel: 'Copy resource limits snippet',
            code: `resources:
  memory_mb: 1024   # HostConfig.Memory = MemorySwap = 1073741824 bytes (zero swap thrash)
  cpu_cores: 1.5    # HostConfig.NanoCPUs = 1500000000

worker:
  command: ["bundle", "exec", "sidekiq"]
  resources:
    memory_mb: 768
    cpu_cores: 1.0`,
          },
          {
            type: 'callout',
            html: '<strong>Live Zero-Restart Singleton Cgroup Updates:</strong> Raising <code>memory_mb</code> or <code>cpu_cores</code> on a running <code>singleton</code> database calls <code>POST /containers/{id}/update</code> directly against the Linux cgroup hierarchy—adjusting caps in milliseconds with <strong>zero dropped SQL connections</strong>.',
          },
        ],
      },
      {
        id: 'drain-fencing-prune',
        heading: 'Node Cordoning, Volume Fencing & Image Pruning',
        blocks: [
          {
            type: 'ul',
            items: [
              '<strong>Safe Node Drain &amp; Stateful Fencing:</strong> Cordoning and draining a host reschedules stateless <code>blue_green</code> replicas onto healthy peers while marking local stateful <code>singleton</code> volumes as <strong><code>fenced</code></strong>—never blindly wiping or migrating a live database disk.',
              '<strong>Two-Pass Automatic Image Pruning:</strong> After every successful rollout (and on-demand from the console), <code>flarelensd</code> runs a guarded two-pass Docker prune—reclaiming dangling layers older than 24h and unused tags older than 72h while keeping recent rollback images warm on NVMe.',
              '<strong>Host Operations &amp; OTA Agent Updates:</strong> Upgrade <code>flarelensd</code> fleet-wide via SHA-256 verified atomic binary swaps, retire allowlisted legacy <code>systemd</code> units, and trigger drain-locked OS reboots from the UI.',
            ],
          },
        ],
      },
    ],
  },

  {
    slug: 'deployments',
    group: 'capabilities',
    kicker: 'Pillar 02 · Revisions and Rollbacks',
    cardTitle: 'Deployments',
    cardDesc: 'Zero-Git revisions, <1ms Blue/Green swaps, ephemeral migrations, uat → prod promotion, and 1-click rollbacks.',
    title: 'Deployments',
    lead: 'Ship updates with confidence through immutable D1 + R2 revisions, atomic sub-millisecond Blue/Green cutovers, pre-deploy database guardrails, environment promotions, and instant 1-click rollbacks.',
    sections: [
      {
        id: 'zero-git-revisions',
        heading: 'Immutable Revisions (Zero-Git or GitOps)',
        blocks: [
          {
            type: 'p',
            html: 'Every change made in the FlareLens UI—or pushed via CI—writes a complete, immutable fleet snapshot (<code>rev-1</code>, <code>rev-2</code>, …) to D1 and archives the full JSON state in R2 (<code>state/revisions/rev-N.json</code>) with actor attribution, timestamp, and diff summary.',
          },
          {
            type: 'ul',
            items: [
              '<strong>Dashboard-First (Zero-Git):</strong> Create, edit, clone, suspend, and deploy services directly from the web console.',
              '<strong>Staged Services (<code>enabled: false</code>):</strong> Pre-stage production manifests in D1 as <code>Suspended</code>—auditing ports, domains, secrets, and resource caps with zero container mutations until cutover day.',
              '<strong>Optional GitOps Sync:</strong> Synchronize YAML/JSON manifests from GitHub Actions using keyless OIDC tokens (<code>id-token: write</code>) with zero long-lived deploy secrets.',
            ],
          },
        ],
      },
      {
        id: 'blue-green-pipeline',
        heading: '7-Step Zero-Downtime Blue/Green Pipeline',
        blocks: [
          {
            type: 'p',
            html: 'When deploying a <code>blue_green</code> service, <code>flarelensd</code> executes a deterministic 7-stage state machine on each target host:',
          },
          {
            type: 'ol',
            items: [
              '<strong>Pre-Deploy Guardrail:</strong> If <code>pre_deploy_snapshot: true</code> or <code>run_migrations: true</code> is enabled, streams a compressed <code>pg_dump</code> snapshot directly to R2 before touching schemas.',
              '<strong>Authenticated Image Pull:</strong> Pulls the new OCI image using ephemeral registry credentials injected in memory.',
              '<strong>Ephemeral Migration Container:</strong> Runs <code>migration_command</code> in a one-shot container attached to the internal network; aborts and triggers R2 snapshot restore on non-zero exit.',
              '<strong>Candidate Slot Boot:</strong> Starts the inactive slot (<code>-green</code> while <code>-blue</code> serves live traffic) with updated secrets, RAM files, and cgroup limits.',
              '<strong>HTTP Readiness Probe:</strong> Polls <code>health_path</code> on <code>internal_port</code> until consecutive <code>200 OK</code> responses confirm readiness.',
              '<strong>Atomic &lt;1ms Ingress Swap:</strong> Writes the updated Traefik dynamic upstream configuration atomically so new requests cut over in under a millisecond.',
              '<strong>Graceful Connection Drain:</strong> Allows in-flight requests on the retiring slot to finish before stopping the old container and pruning stale images.',
            ],
          },
        ],
      },
      {
        id: 'promote-and-rollback',
        heading: 'Environment Promotion & 1-Click Rollback',
        blocks: [
          {
            type: 'p',
            html: 'Promote verified image digests and runtime configurations from <code>uat</code> to <code>prod</code> in a single click while preserving environment-scoped domains, replica counts, and Vault secrets. If metrics degrade after a release, rolling back to any prior <code>rev-N</code> restores the exact container digests, environment variables, and even accidentally deleted services.',
          },
          {
            type: 'code',
            id: 'deploy-webhook-cli',
            label: 'Trigger CI Push Deploy or Promote via API · bash',
            copyLabel: 'Copy deployment API example',
            code: `# Promote verified UAT release into Prod (creates immutable rev-N+1)
curl -X POST https://ops.example.com/api/v1/control/fleet/promote \\
  -H "Authorization: Bearer $FLARELENS_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"source_env":"uat","target_env":"prod","services":["checkout-api"]}'`,
          },
        ],
      },
    ],
  },

  {
    slug: 'mesh',
    group: 'capabilities',
    kicker: 'Pillar 03 · WireGuard Networking',
    cardTitle: 'Private Mesh',
    cardDesc: 'Zero-config P2P ChaCha20-Poly1305 overlay (100.64.0.0/10), 5s MagicDNS (*.mesh), and workstation access.',
    title: 'Private Mesh',
    lead: 'Connect cloud VMs, bare-metal database hosts, and developer workstations across providers into an encrypted peer-to-peer WireGuard overlay with zero firewall port juggling and built-in split-horizon service discovery.',
    sections: [
      {
        id: 'p2p-wireguard',
        heading: 'Zero-Config Peer-to-Peer WireGuard Overlay',
        blocks: [
          {
            type: 'p',
            html: 'On enrollment, every <code>flarelensd</code> host generates an asymmetric Curve25519 keypair locally (the private key never leaves the server) and receives a deterministic CGNAT address inside <code>100.64.0.0/10</code>. The Control Plane distributes authenticated peer public keys and endpoints on the 15-second heartbeat so hosts establish direct <strong>ChaCha20-Poly1305 UDP tunnels</strong> with sub-millisecond overhead.',
          },
          {
            type: 'ul',
            items: [
              '<strong>Private-Only Databases:</strong> Keep PostgreSQL (<code>5432</code>) and Redis (<code>6379</code>) completely closed on public interfaces; expose them solely over the authenticated WireGuard interface.',
              '<strong>Cross-Node Ingress Balancing:</strong> Edge ingress nodes automatically balance HTTP traffic to healthy container slots across remote mesh peers via <code>remote_upstreams</code>.',
              '<strong>Deterministic Overlay Service Router:</strong> Local listeners forward mesh service ports across healthy local and remote container replicas automatically.',
            ],
          },
        ],
      },
      {
        id: 'magic-dns',
        heading: 'Split-Horizon MagicDNS (<service>.<env>.mesh)',
        blocks: [
          {
            type: 'p',
            html: '<code>flarelensd</code> embeds a dual-stack UDP + TCP DNS server bound to <code>&lt;overlay_ip&gt;:53</code> and injects it into managed containers via Docker <code>HostConfig.DNS</code>:',
          },
          {
            type: 'code',
            id: 'mesh-dns-example',
            label: 'Internal Service Discovery · Environment Config',
            copyLabel: 'Copy MagicDNS connection examples',
            code: `# Connect to services across any server or cloud region by logical name:
DATABASE_URL=postgres://app:secret@postgres.prod.mesh:5432/core?sslmode=require
REDIS_URL=redis://cache.prod.mesh:6379/0
BILLING_INTERNAL_URL=http://billing-api.prod.mesh:8080`,
          },
          {
            type: 'ul',
            items: [
              '<strong><code>TTL = 5s</code> Round-Robin Failover:</strong> Queries for <code>&lt;service&gt;.&lt;env&gt;.mesh</code> return shuffled A-records of healthy replicas with a 5-second TTL and <code>AAAA NODATA</code>—so cross-node blue/green cutovers propagate in seconds without restarting client pools.',
              '<strong>Split-Horizon Upstream Forwarding:</strong> Non-<code>.mesh</code> queries forward transparently to upstream resolvers (<code>1.1.1.1</code> / host DNS) over both UDP and TCP.',
              '<strong>Resilient <code>ExtraHosts</code> Fallback:</strong> Non-CGNAT fallback mappings are written to container <code>/etc/hosts</code> while stripping stale CGNAT entries so live <code>MagicDNS</code> answers always win.',
            ],
          },
        ],
      },
      {
        id: 'workstation-access',
        heading: 'Operator Workstation Access',
        blocks: [
          {
            type: 'p',
            html: 'Developers and SREs can join the private mesh temporarily from macOS or Linux laptops without SSH bastions or third-party VPN SaaS:',
          },
          {
            type: 'code',
            id: 'mesh-workstation',
            label: 'Workstation Mesh Login · bash',
            copyLabel: 'Copy workstation mesh login command',
            code: `sudo flarelens-agent login --endpoint https://ops.example.com

# Inspect internal services directly over encrypted WireGuard:
psql postgres://readonly@postgres.uat.mesh:5432/app`,
          },
        ],
      },
    ],
  },

  {
    slug: 'observability',
    group: 'capabilities',
    kicker: 'Pillar 04 · Logs, Metrics and Health',
    cardTitle: 'Observability',
    cardDesc: '15s host & container metrics, SSE live log tailing, and R2 Parquet + in-browser DuckDB-WASM SQL analytics.',
    title: 'Observability',
    lead: 'Gain real-time visibility across every host and container—combining 15-second infrastructure metrics, sub-5ms live log tailing, and a zero-egress Apache Parquet log lakehouse queryable with full SQL right inside your browser.',
    sections: [
      {
        id: 'metrics-and-health',
        heading: 'Host Metrics, Container Telemetry & Health Checks',
        blocks: [
          {
            type: 'p',
            html: 'Every 15 seconds, <code>flarelensd</code> samples host CPU load, memory pressure, swap, root/NVMe disk utilization, WireGuard peer handshakes, and per-container CPU/RAM cgroup consumption—correlating spikes directly against deployment revisions.',
          },
          {
            type: 'ul',
            items: [
              '<strong>Active Readiness &amp; Liveness Probes:</strong> Continuous HTTP probes verify container health endpoints and surface unhealthy slots immediately.',
              '<strong>Alert Cooldowns &amp; Notifications:</strong> Configurable thresholds for node offline events, disk saturation, high memory pressure, and failed deployments prevent alert storms with built-in cooldown windows.',
            ],
          },
        ],
      },
      {
        id: 'live-tail-and-parquet',
        heading: 'SSE Live Tailing & R2 Apache Parquet Lakehouse',
        blocks: [
          {
            type: 'p',
            html: 'Traditional observability SaaS platforms charge $0.50–$2.50+ per GB ingested. FlareLens splits log handling into two fast, sovereign paths:',
          },
          {
            type: 'ol',
            items: [
              '<strong>Real-Time SSE Stream:</strong> Tail stdout/stderr from any container or service across your fleet in real time with sub-5ms edge fan-out.',
              '<strong>Columnar R2 Log Lakehouse:</strong> Structured and unstructured logs are micro-batched, Snappy-compressed into Hive-partitioned <strong>Apache Parquet</strong> files (<code>logs/env=prod/dt=YYYY-MM-DD/*.parquet</code>), and written to your Cloudflare R2 bucket with <strong>$0 egress fees</strong>.',
            ],
          },
        ],
      },
      {
        id: 'duckdb-wasm-sql',
        heading: 'In-Browser DuckDB-WASM SQL Analytics',
        blocks: [
          {
            type: 'p',
            html: 'When you open the <strong>Observability → Log Explorer</strong> tab, the FlareLens console boots <strong>DuckDB-WASM</strong> locally inside your browser and executes analytical SQL queries directly against R2 Parquet partitions using HTTP range requests—scanning millions of log rows in milliseconds without running a ClickHouse or Elasticsearch cluster:',
          },
          {
            type: 'code',
            id: 'obs-duckdb-sql',
            label: 'In-Browser DuckDB-WASM Query · SQL',
            copyLabel: 'Copy DuckDB SQL log query example',
            code: `SELECT
  service,
  status_code,
  count(*) AS requests,
  approx_quantile(latency_ms, 0.99) AS p99_ms
FROM read_parquet('r2://logs/env=prod/dt=2026-11-16/*.parquet')
WHERE level IN ('WARN', 'ERROR')
GROUP BY service, status_code
ORDER BY requests DESC;`,
          },
        ],
      },
    ],
  },

  {
    slug: 'secrets-and-flags',
    group: 'capabilities',
    kicker: 'Pillar 05 · Secure Runtime Configuration',
    cardTitle: 'Secrets & Flags',
    cardDesc: 'AES-256-GCM edge Vault, zero .env files on disk, 0700 /dev/shm secret mounts, and sub-ms feature flags.',
    title: 'Secrets & Flags',
    lead: 'Eliminate plaintext .env files on server disks and decouple runtime configuration changes from container rebuilds using edge-encrypted secrets, RAM-backed tmpfs file mounts, and sub-millisecond feature flags.',
    sections: [
      {
        id: 'zero-plaintext-vault',
        heading: 'Edge AES-256-GCM Vault & Zero Disk Plaintext',
        blocks: [
          {
            type: 'p',
            html: 'Secrets are encrypted via the Web Crypto API using <strong>AES-256-GCM</strong> with per-secret random IVs before touching Workers KV, scoped per environment (<code>dev</code>, <code>uat</code>, <code>prod</code>) and per service or shared global namespace.',
          },
          {
            type: 'ul',
            items: [
              '<strong>No <code>.env</code> Files on Host Disks:</strong> During deployment, <code>flarelensd</code> receives decrypted values over authenticated TLS in memory and passes them directly to the Docker container creation API—nothing is ever written to persistent block storage.',
              '<strong>Non-Secret <code>env_vars</code> Overrides:</strong> Keep non-sensitive tunables (log levels, timeouts, public URLs) cleanly separated under <code>env_vars</code> in the service manifest.',
            ],
          },
        ],
      },
      {
        id: 'ram-tmpfs-secret-files',
        heading: 'Ephemeral RAM Secret Files (/dev/shm)',
        blocks: [
          {
            type: 'p',
            html: 'Workloads like TLS sidecars, mTLS clients, JWT signers, or init scripts often require credentials mounted as files rather than environment variables. Prefix any Vault secret key or value target with <code>__FLARELENS_FILE__/container/path</code>:',
          },
          {
            type: 'code',
            id: 'sec-ram-files',
            label: 'RAM-Only tmpfs Secret Mount · Vault Mapping',
            copyLabel: 'Copy RAM secret file mapping example',
            code: `# Vault entry mapped into an ephemeral RAM tmpfs bind-mount:
GOOGLE_APPLICATION_CREDENTIALS=__FLARELENS_FILE__/run/secrets/gcp-sa.json
TLS_CLIENT_KEY=__FLARELENS_FILE__/etc/ssl/private/client.key
TLS_CA_CERT=__FLARELENS_FILE__/etc/ssl/certs/internal-ca.crt`,
          },
          {
            type: 'p',
            html: '<code>flarelensd</code> materializes these files inside a <code>0700</code> RAM-backed <code>tmpfs</code> directory (<code>/dev/shm/flarelens-secrets/&lt;slot&gt;</code>) that vanishes immediately on power-off or container teardown—automatically applying strict <code>0600</code> permissions to private keys (<code>.key</code>, <code>.pem</code>) and readable <code>0644</code> permissions to certificates, SQL, JSON, or YAML configs consumed by non-root container UIDs.',
          },
        ],
      },
      {
        id: 'feature-flags',
        heading: 'Sub-Millisecond Runtime Feature Flags',
        blocks: [
          {
            type: 'p',
            html: 'Toggle kill-switches, percentage rollouts, and tenant/attribute targeting rules from the console without redeploying containers. Flag revisions propagate globally through Cloudflare KV and sync to enrolled hosts via the piggybacked <code>flags_version</code> heartbeat delta—allowing local evaluation in under a millisecond with zero per-request external network hops.',
          },
        ],
      },
    ],
  },

  {
    slug: 'backups',
    group: 'capabilities',
    kicker: 'Pillar 06 · R2 Streaming Storage',
    cardTitle: 'Backups',
    cardDesc: 'Zero-disk io.Pipe pg_dump | gzip streaming to R2, cron schedules, migration guardrails, and auto-restore.',
    title: 'Backups',
    lead: 'Protect stateful PostgreSQL databases with zero local disk staging, automated cron schedules, pre-migration snapshot guardrails, and verified 1-click or automatic point-in-time restores.',
    sections: [
      {
        id: 'streaming-r2-backups',
        heading: 'Zero-Disk Streaming Architecture (io.Pipe → R2)',
        blocks: [
          {
            type: 'p',
            html: 'Conventional backup scripts dump gigabytes onto local NVMe disks before uploading—risking <code>ENOSPC</code> outages on busy database hosts. <code>flarelensd</code> executes <code>pg_dump</code> inside the target PostgreSQL container, pipes stdout through streaming <code>gzip</code> compression in Go memory (<code>io.Pipe</code>), and uploads multipart chunks straight to your Cloudflare R2 <code>BACKUP_BUCKET</code> using short-lived presigned URLs.',
          },
          {
            type: 'ul',
            items: [
              '<strong>Zero Temp Files on Host Disk:</strong> Even multi-gigabyte databases stream to R2 with a constant ~16 MB memory footprint.',
              '<strong>Multi-Environment DB Resolution:</strong> Automatically resolves the right database container and credentials per environment (<code>postgres-uat</code> vs <code>postgres-prod</code>) via explicit manifest names or container labels.',
              '<strong>SHA-256 Integrity &amp; Retention Catalog:</strong> Every completed archive records byte size, duration, checksum, environment, and revision metadata in D1.',
            ],
          },
        ],
      },
      {
        id: 'migration-guardrails',
        heading: 'Pre-Migration Guardrails & Automated Rollback',
        blocks: [
          {
            type: 'p',
            html: 'Enable <code>pre_deploy_snapshot: true</code> alongside <code>run_migrations: true</code> on any stateful application service to guarantee database safety on every release:',
          },
          {
            type: 'code',
            id: 'backups-guardrail-yaml',
            label: 'Automated Migration Snapshot Guardrail · YAML',
            copyLabel: 'Copy migration backup guardrail config',
            code: `name: ledger-api
env: prod
strategy: blue_green
image: ghcr.io/acme/ledger-api:v2.1.0

pre_deploy_snapshot: true
run_migrations: true
migration_command: ["goose", "-dir", "/app/migrations", "up"]`,
          },
          {
            type: 'callout',
            html: '<strong>Automatic Failure Recovery:</strong> If <code>migration_command</code> exits non-zero or the candidate container fails readiness checks after mutating schemas, FlareLens halts the cutover, keeps the live slot untouched, and can stream-restore the pre-deploy R2 snapshot automatically.',
          },
        ],
      },
      {
        id: 'scheduled-and-manual-restore',
        heading: 'Scheduled Cron Backups & Point-in-Time Restore',
        blocks: [
          {
            type: 'p',
            html: 'Configure recurring cron backup policies (hourly, daily, weekly) per database from the <strong>Backups</strong> console tab, trigger ad-hoc snapshots before maintenance windows, or restore any historical R2 archive into a staging or production database container with live progress tracking.',
          },
        ],
      },
    ],
  },

  {
    slug: 'reference',
    group: 'reference',
    kicker: 'Specs, CLI & API',
    cardTitle: 'CLI, Schema & HTTP API',
    cardDesc: 'Complete fleet.schema.json field table, flarelensd CLI commands, GitHub OIDC workflow, and REST endpoints.',
    title: 'CLI, Schema & HTTP API Reference',
    lead: 'Canonical technical reference for declarative workload manifests, the flarelensd host daemon CLI, keyless GitHub Actions OIDC synchronization, and Control Plane HTTP endpoints.',
    sections: [
      {
        id: 'fleet-manifest-schema',
        heading: 'Declarative Manifest Schema (fleet.schema.json)',
        blocks: [
          {
            type: 'p',
            html: 'Add <code># $schema: https://flarelens.dev/schemas/fleet.schema.json</code> (YAML) or <code>"$schema": "https://flarelens.dev/schemas/fleet.schema.json"</code> (JSON) for full IDE autocompletion and validation.',
          },
          {
            type: 'table',
            caption: 'Top-level fleet manifest fields',
            headers: ['Field', 'Type', 'Description'],
            rows: [
              ['name', 'string (required)', 'Logical service identifier (e.g. checkout-api, postgres). Used in MagicDNS as <name>.<env>.mesh.'],
              ['env', '"dev" | "uat" | "prod"', 'Target environment isolation boundary for secrets, revisions, and DNS.'],
              ['strategy', '"blue_green" | "singleton"', 'Zero-downtime dual-slot swap for stateless apps, or single-instance stateful lifecycle.'],
              ['enabled', 'boolean', 'Defaults to true. Set false to stage manifests in D1 as Suspended without starting containers.'],
              ['adopt_only', 'boolean', 'Observe and enforce metrics on pre-existing host infrastructure containers without recreating them.'],
              ['image', 'string (required)', 'Full OCI image reference (tag or immutable @sha256 digest).'],
              ['domain / internal_port', 'string / integer', 'Public HTTPS hostname routed via Traefik and container listening port.'],
              ['health_path', 'string', 'HTTP readiness path polled prior to atomic Blue/Green cutover (e.g. /healthz).'],
              ['placement', 'object', '{ strategy: "spread"|"binpack"|"pinned", replicas: number, required_tags: string[], node_id?: string }.'],
              ['resources', 'object', 'Hard Linux cgroup caps: { memory_mb: integer, cpu_cores: number }.'],
              ['worker', 'object', 'Optional companion background worker process with dedicated command[] and resources override.'],
              ['pre_deploy_snapshot', 'boolean', 'Stream a gzipped pg_dump backup to R2 prior to running schema migrations.'],
              ['run_migrations / migration_command', 'boolean / string[]', 'Execute ephemeral migration container before booting candidate Blue/Green slot.'],
              ['env_vars', 'Record<string, string>', 'Non-secret runtime environment variables merged with encrypted Vault secrets.'],
            ],
          },
        ],
      },
      {
        id: 'flarelensd-cli',
        heading: 'Host Agent CLI (flarelensd)',
        blocks: [
          {
            type: 'p',
            html: 'Configuration lives in <code>/etc/flarelens/agent.toml</code> with WireGuard state stored in <code>0600</code> files under <code>/var/lib/flarelens/</code>.',
          },
          {
            type: 'code',
            id: 'ref-agent-cli',
            label: 'Common flarelensd Operations · bash',
            copyLabel: 'Copy flarelensd CLI commands',
            code: `# Check daemon status and recent reconciliation logs
sudo systemctl status flarelensd
sudo journalctl -u flarelensd -f

# Join the private WireGuard mesh from an operator laptop
sudo flarelens-agent login --endpoint https://ops.example.com

# Print agent version and Curve25519 public key
flarelensd --version`,
          },
        ],
      },
      {
        id: 'github-oidc-sync',
        heading: 'Keyless GitHub Actions OIDC Sync',
        blocks: [
          {
            type: 'p',
            html: 'If you version manifests in Git alongside dashboard operations, authorize your repository in the FlareLens console and sync via GitHub’s native OIDC provider—no static API tokens stored in GitHub Secrets:',
          },
          {
            type: 'code',
            id: 'ref-github-oidc',
            label: '.github/workflows/fleet-sync.yml · YAML',
            copyLabel: 'Copy GitHub Actions OIDC workflow',
            code: `name: Sync Fleet Manifests
on:
  push:
    branches: [main]
    paths: ["fleet/**"]

permissions:
  id-token: write
  contents: read

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Exchange GitHub OIDC & Sync Fleet
        run: |
          OIDC_TOKEN=$(curl -sLS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=flarelens" | jq -r .value)
          jq -s '{ manifests: . }' fleet/prod/*.json | \\
            curl -fsSL -X POST https://ops.example.com/api/v1/control/fleet/sync \\
              -H "Authorization: Bearer $OIDC_TOKEN" \\
              -H "Content-Type: application/json" \\
              -d @-`,
          },
        ],
      },
      {
        id: 'http-api-endpoints',
        heading: 'Control Plane HTTP API',
        blocks: [
          {
            type: 'table',
            caption: 'Primary Control Plane REST endpoints',
            headers: ['Endpoint', 'Auth', 'Purpose'],
            rows: [
              ['POST /api/v1/ingest', 'INGEST_SECRET', '15s host heartbeat; returns piggybacked commands, mesh_peers, cluster_endpoints & flags_version.'],
              ['POST /api/v1/control/fleet/sync', 'Bearer / GitHub OIDC', 'Validate and commit declarative service manifests into an immutable rev-N snapshot.'],
              ['POST /api/v1/control/fleet/promote', 'Operator / API Token', 'Promote service digests and config across environments (e.g. uat → prod).'],
              ['POST /api/v1/control/fleet/rollback', 'Operator / API Token', 'Restore fleet desired state to any historical rev-N snapshot in D1 + R2.'],
              ['POST /api/v1/control/nodes/:id/drain', 'Operator / API Token', 'Cordon host, reschedule stateless replicas, and fence local singleton volumes.'],
              ['POST /api/v1/control/nodes/:id/uncordon', 'Operator / API Token', 'Return a drained host back to active placement scheduling.'],
              ['POST /api/v1/control/nodes/:id/prune-images', 'Operator / API Token', 'Queue two-pass Docker image garbage collection (dangling >24h, unused >72h).'],
              ['POST /api/v1/control/agent/releases', 'Operator / API Token', 'Register SHA-256 verified flarelensd binary release for fleet-wide OTA upgrades.'],
            ],
          },
          {
            type: 'callout',
            html: '<strong>AI Coding Agents:</strong> Point Cursor, Claude Code, Antigravity, or Codex directly at <a href="/llms-full.txt"><code>https://flarelens.dev/llms-full.txt</code></a> to load this entire documentation suite plus the complete <code>fleet.schema.json</code> in one file.',
          },
        ],
      },
    ],
  },
];
