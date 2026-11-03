import { MeshPeerRecord, MeshRegisterPayload, MeshCreateClientPayload, PreAuthKeyRecord, Env } from '../types';

export const MESH_SUBNET = '100.64.0.0/10';
export const MESH_PREFIX = '100.64.0.';
export const COORDINATOR_URL = 'https://control.flarelens.dev';
export const MAGIC_DNS_SUFFIX = '.mesh';

export interface DERPRegion {
  id: number;
  code: string;
  name: string;
  stun_port: number;
  relay_url: string;
  status: 'operational' | 'degraded';
}

export const DERP_REGIONS: DERPRegion[] = [
  {
    id: 1,
    code: 'global',
    name: 'Global Anycast Primary Relay',
    stun_port: 51820,
    relay_url: 'https://control.flarelens.dev',
    status: 'operational',
  },
];

/**
 * Encodes Uint8Array to base64
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decodes base64 to Uint8Array
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Compact Montgomery curve25519 scalar multiplication for WireGuard keys.
 * Matches RFC 7748 curve25519(scalar, base_point).
 */
export function curve25519ScalarMult(scalarBytes: Uint8Array, pointBytes?: Uint8Array): Uint8Array {
  const p = (1n << 255n) - 19n;
  const a24 = 121665n;

  // Clamping
  const k = new Uint8Array(scalarBytes);
  k[0] &= 248;
  k[31] = (k[31] & 127) | 64;

  let s = 0n;
  for (let i = 31; i >= 0; i--) {
    s = (s << 8n) | BigInt(k[i]);
  }

  let u = 9n;
  if (pointBytes) {
    u = 0n;
    for (let i = 31; i >= 0; i--) {
      u = (u << 8n) | BigInt(pointBytes[i]);
    }
    u = u % p;
  }

  function mod(n: bigint): bigint {
    return ((n % p) + p) % p;
  }

  function modInverse(n: bigint): bigint {
    let result = 1n;
    let base = mod(n);
    let exp = p - 2n;
    while (exp > 0n) {
      if (exp & 1n) result = mod(result * base);
      base = mod(base * base);
      exp >>= 1n;
    }
    return result;
  }

  let x1 = u;
  let x2 = 1n, z2 = 0n;
  let x3 = u, z3 = 1n;
  let swap = 0n;

  for (let t = 254; t >= 0; t--) {
    const kt = (s >> BigInt(t)) & 1n;
    swap ^= kt;
    if (swap) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = kt;

    const A = mod(x2 + z2);
    const AA = mod(A * A);
    const B = mod(x2 - z2);
    const BB = mod(B * B);
    const E = mod(AA - BB);
    const C = mod(x3 + z3);
    const D = mod(x3 - z3);
    const DA = mod(D * A);
    const CB = mod(C * B);

    x3 = mod(mod(DA + CB) * mod(DA + CB));
    z3 = mod(x1 * mod(mod(DA - CB) * mod(DA - CB)));
    x2 = mod(AA * BB);
    z2 = mod(E * mod(AA + mod(a24 * E)));
  }

  if (swap) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }

  const resultVal = mod(x2 * modInverse(z2));
  const resultBytes = new Uint8Array(32);
  let temp = resultVal;
  for (let i = 0; i < 32; i++) {
    resultBytes[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return resultBytes;
}

/**
 * Generates a valid Curve25519 WireGuard keypair.
 */
export function generateWireGuardKeypair(): { privateKey: string; publicKey: string } {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  priv[0] &= 248;
  priv[31] = (priv[31] & 127) | 64;

  const pub = curve25519ScalarMult(priv);

  return {
    privateKey: bytesToBase64(priv),
    publicKey: bytesToBase64(pub),
  };
}

/**
 * Allocates the next sequential IP address in the 100.64.0.0/10 CGNAT subnet.
 */
export function allocateMeshIP(existingPeers: MeshPeerRecord[], type: 'node' | 'client' | 'gateway' | 'router'): string {
  const usedOctets = new Set<number>();
  for (const peer of existingPeers) {
    const ip = peer.tailscale_ip || peer.overlay_ip;
    if (ip && ip.startsWith(MESH_PREFIX)) {
      const last = parseInt(ip.substring(MESH_PREFIX.length), 10);
      if (!isNaN(last)) usedOctets.add(last);
    }
  }

  // Nodes & Routers get 1..99; Clients & Operators get 100..254
  const start = (type === 'node' || type === 'router' || type === 'gateway') ? 1 : 100;
  const end = (type === 'node' || type === 'router' || type === 'gateway') ? 99 : 254;

  for (let i = start; i <= end; i++) {
    if (!usedOctets.has(i)) {
      return `${MESH_PREFIX}${i}`;
    }
  }

  // Fallback to random in range
  return `${MESH_PREFIX}${Math.floor(Math.random() * (end - start + 1)) + start}`;
}

/**
 * Generates a high-entropy enrollment token for automated machine provisioning against the Cloudflare Edge Coordinator.
 */
export function generatePreAuthKey(options?: {
  user?: string;
  reusable?: boolean;
  ephemeral?: boolean;
  expiresDays?: number;
  tags?: string[];
}): PreAuthKeyRecord {
  const randomBytes = crypto.getRandomValues(new Uint8Array(24));
  let hex = '';
  for (let i = 0; i < randomBytes.length; i++) {
    hex += randomBytes[i].toString(16).padStart(2, '0');
  }

  const now = new Date();
  const expiresDays = options?.expiresDays || 90;
  const expiresAt = new Date(now.getTime() + expiresDays * 86400 * 1000).toISOString();

  return {
    id: `key_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    key: `flarelens_auth_${hex}`,
    user: options?.user || 'default',
    reusable: options?.reusable ?? true,
    ephemeral: options?.ephemeral ?? false,
    used: false,
    created_at: now.toISOString(),
    expires_at: expiresAt,
    tags: options?.tags || ['tag:fleet'],
  };
}

/**
 * Builds the native FlareLens Agent login command for interactive browser SSO onboarding.
 */
export function buildAgentConnectCommand(authKey?: string, options?: { hostname?: string }): string {
  const hostFlag = options?.hostname ? ` --name=${options.hostname}` : '';
  const tokenFlag = authKey ? ` --token="${authKey}"` : '';
  return `sudo flarelens-agent login --control=${COORDINATOR_URL}${tokenFlag}${hostFlag}`;
}

/**
 * Builds device connection command (alias to native flarelens-agent login).
 */
export function buildTailscaleConnectCommand(authKey: string, options?: {
  hostname?: string;
  isSubnetRouter?: boolean;
  advertisedRoutes?: string;
}): string {
  return buildAgentConnectCommand(authKey, options);
}

/**
 * Generates MikroTik RouterOS v7 configuration commands for standard WireGuard peer.
 */
export function buildMikroTikConfig(authKey: string, nodeName: string, overlayIp: string, endpointIp?: string): string {
  const gatewayIp = endpointIp || '<gateway-endpoint-ip>';
  return [
    '# ========================================================',
    `# FlareLens Sovereign Mesh: MikroTik RouterOS v7`,
    `# Node: ${nodeName} | Mesh CGNAT: ${overlayIp}/10`,
    '# ========================================================',
    '',
    '# 1. Create WireGuard Interface',
    `/interface/wireguard/add name=flarelens-mesh listen-port=51820 mtu=1420`,
    `/ip/address/add address=${overlayIp}/10 interface=flarelens-mesh network=100.64.0.0`,
    '',
    '# 2. Add Primary Server Peer (Coordinator VPS)',
    `/interface/wireguard/peers/add interface=flarelens-mesh endpoint-address=${gatewayIp} endpoint-port=51820 allowed-address=100.64.0.0/10 persistent-keepalive=25s`,
    '',
    '# 3. DNS Configuration',
    `/ip/dns/set servers=1.1.1.1,8.8.8.8`,
  ].join('\n');
}

/**
 * Formats a standard WireGuard (.conf) configuration file for legacy client operators
 */
export function buildWireGuardClientConfig(
  clientPeer: MeshPeerRecord,
  clientPrivateKey: string,
  nodePeers: MeshPeerRecord[]
): string {
  const ip = clientPeer.tailscale_ip || clientPeer.overlay_ip;
  const lines: string[] = [
    '# ========================================================',
    `# FlareLens Sovereign Zero-Trust Client Profile: ${clientPeer.name}`,
    `# Allocated Mesh IP: ${ip}/10 (Carrier Grade NAT)`,
    `# Mesh Coordinator: ${COORDINATOR_URL}`,
    '# ========================================================',
    '[Interface]',
    `PrivateKey = ${clientPrivateKey}`,
    `Address = ${ip}/10`,
    'DNS = 100.64.0.1, 1.1.1.1',
    '',
  ];

  for (const node of nodePeers) {
    if (node.type !== 'node' && node.type !== 'gateway') continue;
    const nodeIp = node.tailscale_ip || node.overlay_ip;

    lines.push(`# Peer Node: ${node.name} (${node.id}) - ${node.magic_dns || node.hostname || ''}`);
    lines.push('[Peer]');
    lines.push(`PublicKey = ${node.public_key || node.node_key || ''}`);
    if (node.endpoint) {
      lines.push(`Endpoint = ${node.endpoint}`);
    }
    // Route traffic for that node's mesh IP through this peer
    lines.push(`AllowedIPs = ${nodeIp}/32`);
    lines.push('PersistentKeepalive = 25');
    lines.push('');
  }

  return lines.join('\n');
}

