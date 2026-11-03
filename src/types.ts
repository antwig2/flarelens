export interface LogRecord {
  id?: string;
  timestamp: string;
  time_iso?: string;
  level: string;
  service: string;
  message: string;
  environment?: string;
  env?: string;
  trace_id?: string;
  span_id?: string;
  request_id?: string;
  correlation_id?: string;
  parent_span_id?: string;
  duration_ms?: number;
  status?: number;
  attributes?: Record<string, any>;
  [key: string]: any;
}

export interface NodeSpecs {
  cpus: number;
  ram_total_bytes: number;
  disk_total_bytes: number;
  os: string;
  arch: string;
  kernel?: string;
}

export interface ContainerSummary {
  id: string;
  names: string[];
  image: string;
  status: string;
  state: string;
  created: number;
}

export interface MetricsSnapshot {
  timestamp: string;
  cpu_usage_pct: number;
  ram_used_bytes: number;
  ram_total_bytes: number;
  ram_usage_pct: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  disk_usage_pct: number;
  load_avg_1: number;
  load_avg_5: number;
  load_avg_15: number;
  uptime_seconds: number;
}

export interface NodeRegistrationPayload {
  node_id: string;
  hostname: string;
  provider: string;
  region: string;
  tags: string[];
  specs: NodeSpecs;
  status: string;
  version: string;
  last_heartbeat: number;
}

export interface NodeTelemetryHeartbeat {
  timestamp: string;
  node_id: string;
  status: string;
  docker_healthy: boolean;
  metrics: MetricsSnapshot;
  containers: ContainerSummary[];
}

export interface DeployRequestPayload {
  deployment_id?: string;
  service: string;
  image: string;
  env?: string;
  domain?: string;
  container_port?: number;
  host_port_blue?: number;
  host_port_green?: number;
  health_path?: string;
  command?: string[];
  entrypoint?: string[];
  networks?: string[];
  volumes?: string[];
  workers?: Array<{
    name: string;
    command?: string[];
    entrypoint?: string[];
    volumes?: string[];
    networks?: string[];
  }>;
  timeout_seconds?: number;
  drain_seconds?: number;
  secrets?: Record<string, string>;
  network?: string;
  node_id: string;
  pre_deploy_snapshot?: boolean;
  run_migrations?: boolean;
  migration_cmd?: string;
  canary_weight?: number;
  canary_duration?: number;
  is_preview?: boolean;
  pr_number?: number;
}

export interface PreviewTeardownPayload {
  service: string;
  pr_number: number;
  node_id?: string;
}

export interface DeploymentRecord {
  deployment_id: string;
  service: string;
  image: string;
  node_id: string;
  env: string;
  status: 'initiated' | 'in_progress' | 'success' | 'failed' | 'rolled_back' | 'destroyed';
  active_slot?: string;
  active_port?: number;
  message?: string;
  created_at: string;
  updated_at: string;
  duration_ms?: number;
  is_preview?: boolean;
  pr_number?: number;
  canary_weight?: number;
  canary_duration?: number;
}

export interface NodeRecord extends NodeRegistrationPayload {
  enrolled_at: string;
  updated_at: string;
  latest_telemetry?: NodeTelemetryHeartbeat;
  mesh?: {
    tailscale_ip: string;
    magic_dns: string;
    connection_type: 'direct_p2p' | 'derp_relay';
    status: 'connected' | 'offline';
  };
}

export interface BackupRecord {
  key: string;
  bucket: string;
  timestamp: string;
  tag: string;
  node_id: string;
  service?: string;
  size?: number;
  status: 'initiated' | 'completed' | 'failed';
  error?: string;
}

export interface BackupRequestPayload {
  node_id: string;
  tag?: string;
}

export interface RestoreRequestPayload {
  node_id: string;
  key: string;
  target_db?: string;
}

export interface EncryptedVaultPayload {
  service: string;
  env?: string;
  iv: string; // Base64 encoded 12-byte initialization vector
  ciphertext: string; // Base64 encoded AES-GCM ciphertext
  updated_at: string;
  keys_count: number;
}

export interface VaultMetadata {
  service: string;
  env: string;
  updated_at: string;
  keys_count: number;
}

export interface Env {
  LOGS_BUCKET: R2Bucket;
  BACKUP_BUCKET?: R2Bucket;
  FLEET_KV?: KVNamespace;
  DEPLOY_QUEUE?: Queue<any>;
  ASSETS?: Fetcher;
  ENVIRONMENT?: string;
  DASHBOARD_TITLE?: string;
  ALERT_COOLDOWN_SECONDS?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  SLACK_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
  // Meta WhatsApp Cloud API
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_TO?: string;
  // Twilio WhatsApp (Alternative)
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_WHATSAPP_FROM?: string;
  TWILIO_WHATSAPP_TO?: string;
  // Uptime Synthetics (Cron)
  HEALTHCHECK_URLS?: string;
  // Authentication & Security
  INGEST_SECRET?: string;
  ENROLL_TOKEN?: string;
  DASHBOARD_USERNAME?: string;
  DASHBOARD_PASSWORD?: string;
  WEBHOOK_SECRET?: string;
  GITHUB_TOKEN?: string;
  VAULT_MASTER_KEY?: string;
}

export { ParsedWebhookDeploy } from './control/webhook';

export interface AlertRule {
  id: string;
  name: string;
  severity: 'critical' | 'warning' | 'info';
  trigger: (log: LogRecord) => boolean;
}

export interface MeshPeerRecord {
  id: string;
  name: string;
  hostname?: string;
  magic_dns?: string;
  tailscale_ip?: string;
  overlay_ip: string;
  public_key?: string;
  node_key?: string;
  endpoint?: string;
  listen_port?: number;
  connection_type?: 'direct_p2p' | 'derp_relay';
  derp_region?: string;
  os?: string;
  client_version?: string;
  type: 'node' | 'client' | 'gateway' | 'router';
  created_by?: string;
  created_at: string;
  updated_at: string;
  last_handshake?: string;
  last_seen?: string;
  rx_bytes?: number;
  tx_bytes?: number;
  tags?: string[];
  online?: boolean;
  ssh_public_key?: string;
}

export interface PreAuthKeyRecord {
  id: string;
  key: string;
  user: string;
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  expires_at: string;
  created_at: string;
  tags?: string[];
}

export interface MeshAccessPolicy {
  allowed_domains: string[];
  allowed_emails: string[];
  auto_approve_known_domains: boolean;
  updated_at?: string;
  updated_by?: string;
}

export interface MeshRegisterPayload {
  node_id: string;
  name: string;
  hostname?: string;
  public_key?: string;
  ssh_public_key?: string;
  node_key?: string;
  endpoint?: string;
  listen_port?: number;
  os?: string;
  client_version?: string;
  auth_key?: string;
  connection_type?: 'direct_p2p' | 'derp_relay';
}

export interface MeshCreateClientPayload {
  name: string;
  hostname?: string;
  public_key?: string;
  ssh_public_key?: string;
  reusable?: boolean;
  ephemeral?: boolean;
  tags?: string[];
  device_type?: 'node' | 'client' | 'gateway' | 'router';
}

export interface IngressRoute {
  id: string;
  domain: string;
  environment: 'production' | 'uat' | 'internal';
  type: 'public_edge' | 'sovereign_mesh' | 'control_plane';
  ingress_layer: string;
  tunnel_type: 'cloudflared' | 'wireguard_mesh' | 'worker_edge';
  destination_node: string;
  destination_ip: string;
  destination_port: number;
  target_service: string;
  traefik_rule?: string;
  active_slot?: 'blue' | 'green' | 'single';
  upstream_target?: string;
  status: 'healthy' | 'degraded' | 'offline';
  latency_ms?: number;
  last_probe?: string;
  tags?: string[];
}
