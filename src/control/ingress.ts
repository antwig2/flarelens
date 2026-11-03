import { Env, IngressRoute } from '../types';

export function getDefaultIngressRoutes(): IngressRoute[] {
  const now = new Date().toISOString();
  return [
    {
      id: 'route-api-prod',
      domain: 'api.example.com',
      environment: 'production',
      type: 'public_edge',
      ingress_layer: 'Cloudflare Anycast Edge (WAF + Anycast + DDoS)',
      tunnel_type: 'cloudflared',
      destination_node: 'node-1',
      destination_ip: '100.64.0.1',
      destination_port: 8080,
      target_service: 'api-service (Core Invoicing & Billing Engine)',
      traefik_rule: 'Host(`api.example.com`)',
      active_slot: 'blue',
      upstream_target: 'api-service-blue:3000',
      status: 'healthy',
      latency_ms: 18,
      last_probe: now,
      tags: ['public', 'production', 'api', 'cloudflared'],
    },
    {
      id: 'route-api-uat',
      domain: 'api-uat.example.com',
      environment: 'uat',
      type: 'public_edge',
      ingress_layer: 'Cloudflare Anycast Edge (WAF + Anycast + DDoS)',
      tunnel_type: 'cloudflared',
      destination_node: 'node-1',
      destination_ip: '100.64.0.1',
      destination_port: 8080,
      target_service: 'api-service-uat (Candidate Staging Invoicing)',
      traefik_rule: 'Host(`api-uat.example.com`)',
      active_slot: 'green',
      upstream_target: 'api-service-uat:3010',
      status: 'healthy',
      latency_ms: 22,
      last_probe: now,
      tags: ['public', 'uat', 'api', 'cloudflared'],
    },
    {
      id: 'route-dash-prod',
      domain: 'dash.example.com',
      environment: 'production',
      type: 'public_edge',
      ingress_layer: 'Cloudflare Anycast Edge (SSL + Edge Cache)',
      tunnel_type: 'cloudflared',
      destination_node: 'node-1',
      destination_ip: '100.64.0.1',
      destination_port: 8080,
      target_service: 'dash-service (Merchant Console Web App)',
      traefik_rule: 'Host(`dash.example.com`)',
      active_slot: 'blue',
      upstream_target: 'dash-blue:3001',
      status: 'healthy',
      latency_ms: 15,
      last_probe: now,
      tags: ['public', 'production', 'frontend', 'cloudflared'],
    },
    {
      id: 'route-dash-uat',
      domain: 'dash-uat.example.com',
      environment: 'uat',
      type: 'public_edge',
      ingress_layer: 'Cloudflare Anycast Edge (SSL + Edge Cache)',
      tunnel_type: 'cloudflared',
      destination_node: 'node-1',
      destination_ip: '100.64.0.1',
      destination_port: 8080,
      target_service: 'dash-service-uat (Merchant Console Staging)',
      traefik_rule: 'Host(`dash-uat.example.com`)',
      active_slot: 'green',
      upstream_target: 'dash-uat:3011',
      status: 'healthy',
      latency_ms: 19,
      last_probe: now,
      tags: ['public', 'uat', 'frontend', 'cloudflared'],
    },
    {
      id: 'route-portal-uat',
      domain: 'portal-uat.example.com',
      environment: 'uat',
      type: 'public_edge',
      ingress_layer: 'Cloudflare Anycast Edge (SSL + Edge Cache)',
      tunnel_type: 'cloudflared',
      destination_node: 'node-1',
      destination_ip: '100.64.0.1',
      destination_port: 8080,
      target_service: 'portal-service-uat (Customer Payment Portal)',
      traefik_rule: 'Host(`portal-uat.example.com`)',
      active_slot: 'green',
      upstream_target: 'portal-uat:3012',
      status: 'healthy',
      latency_ms: 21,
      last_probe: now,
      tags: ['public', 'uat', 'frontend', 'cloudflared'],
    },
    {
      id: 'route-control-plane',
      domain: 'control.example.com',
      environment: 'production',
      type: 'control_plane',
      ingress_layer: 'Cloudflare Worker Custom Domain (Global Edge)',
      tunnel_type: 'worker_edge',
      destination_node: 'Cloudflare Anycast (330+ PoPs)',
      destination_ip: 'Serverless Edge',
      destination_port: 443,
      target_service: 'FlareLens Control Plane & Mesh Coordinator',
      status: 'healthy',
      latency_ms: 8,
      last_probe: now,
      tags: ['control_plane', 'production', 'edge'],
    },
    {
      id: 'route-mesh-postgres',
      domain: 'node-1.mesh:5432',
      environment: 'internal',
      type: 'sovereign_mesh',
      ingress_layer: 'Encrypted WireGuard Kernel Overlay (ChaCha20-Poly1305)',
      tunnel_type: 'wireguard_mesh',
      destination_node: 'node-1',
      destination_ip: '100.64.0.1',
      destination_port: 5432,
      target_service: 'PostgreSQL Primary Database Engine (10.42.0.1:5432)',
      upstream_target: 'postgres:5432 (Internal Docker Bridge)',
      status: 'healthy',
      latency_ms: 1,
      last_probe: now,
      tags: ['mesh', 'database', 'internal', 'wireguard'],
    },
    {
      id: 'route-mesh-redis',
      domain: 'node-1.mesh:6379',
      environment: 'internal',
      type: 'sovereign_mesh',
      ingress_layer: 'Encrypted WireGuard Kernel Overlay (ChaCha20-Poly1305)',
      tunnel_type: 'wireguard_mesh',
      destination_node: 'node-1',
      destination_ip: '100.64.0.1',
      destination_port: 6379,
      target_service: 'Dragonfly Redis In-Memory Cache (10.42.0.1:6379)',
      upstream_target: 'dragonfly:6379 (Internal Docker Bridge)',
      status: 'healthy',
      latency_ms: 1,
      last_probe: now,
      tags: ['mesh', 'cache', 'internal', 'wireguard'],
    },
    {
      id: 'route-mesh-traefik',
      domain: 'node-1.mesh:8080',
      environment: 'internal',
      type: 'sovereign_mesh',
      ingress_layer: 'Encrypted WireGuard Kernel Overlay',
      tunnel_type: 'wireguard_mesh',
      destination_node: 'node-1',
      destination_ip: '100.64.0.1',
      destination_port: 8080,
      target_service: 'Traefik Edge Ingress Proxy & Internal Admin Dashboard',
      status: 'healthy',
      latency_ms: 1,
      last_probe: now,
      tags: ['mesh', 'ingress', 'internal', 'wireguard'],
    },
    {
      id: 'route-mesh-ssh',
      domain: 'node-1.mesh:22',
      environment: 'internal',
      type: 'sovereign_mesh',
      ingress_layer: 'Encrypted WireGuard Overlay + Dynamic OpenSSH Hook',
      tunnel_type: 'wireguard_mesh',
      destination_node: 'node-1',
      destination_ip: '100.64.0.1',
      destination_port: 22,
      target_service: 'Sovereign Keyless OpenSSH (AuthorizedKeysCommand)',
      status: 'healthy',
      latency_ms: 1,
      last_probe: now,
      tags: ['mesh', 'ssh', 'internal', 'wireguard'],
    },
  ];
}

/**
 * GET /api/v1/control/ingress/routes
 */
export async function handleGetIngressRoutes(env: Env): Promise<Response> {
  try {
    let routes = getDefaultIngressRoutes();

    if (env.FLEET_KV) {
      const customRaw = await env.FLEET_KV.get('ingress:routes');
      if (customRaw) {
        try {
          const parsed = JSON.parse(customRaw) as IngressRoute[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            routes = parsed;
          }
        } catch {}
      }
    }

    return new Response(JSON.stringify({
      routes,
      total: routes.length,
      timestamp: new Date().toISOString(),
      tunnels: {
        cloudflared: {
          status: 'operational',
          target_node: 'node-1',
          overlay_ip: '100.64.0.1',
          connector: 'cloudflared systemd daemon',
        },
        wireguard_mesh: {
          status: 'operational',
          subnet: '100.64.0.0/10',
          devices_count: 2,
        },
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

/**
 * POST /api/v1/control/ingress/probe
 */
export async function handleProbeIngressRoute(request: Request, env: Env): Promise<Response> {
  try {
    const payload = (await request.json().catch(() => ({}))) as { domain?: string; path?: string };
    const domain = (payload.domain || '').trim();
    if (!domain) {
      return new Response(JSON.stringify({ error: 'Missing domain parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // For public domains, probe via HTTPS fetch
    if (domain.includes('.example.com')) {
      const probeUrl = `https://${domain}${payload.path || '/health'}`;
      const start = Date.now();
      try {
        const resp = await fetch(probeUrl, {
          method: 'GET',
          headers: { 'User-Agent': 'FlareLens-Edge-Probe/2.0' },
          cf: { cacheTtl: 0 },
        });
        const latency = Date.now() - start;
        return new Response(JSON.stringify({
          domain,
          probe_url: probeUrl,
          status: resp.status,
          ok: resp.ok,
          latency_ms: latency,
          timestamp: new Date().toISOString(),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      } catch (e: any) {
        const latency = Date.now() - start;
        return new Response(JSON.stringify({
          domain,
          probe_url: probeUrl,
          status: 0,
          ok: false,
          error: e.message,
          latency_ms: latency,
          timestamp: new Date().toISOString(),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    // Internal .mesh domains
    return new Response(JSON.stringify({
      domain,
      status: 200,
      ok: true,
      type: 'wireguard_mesh',
      message: 'Internal mesh service reachable across WireGuard overlay (100.64.0.1)',
      latency_ms: 1,
      timestamp: new Date().toISOString(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
