import { Env, MeshPeerRecord, MeshAccessPolicy } from '../types';
import { allocateMeshIP, MESH_SUBNET, MAGIC_DNS_SUFFIX } from './mesh';

interface DeviceCodePayload {
  public_key: string;
  ssh_public_key?: string;
  hostname?: string;
  os?: string;
  name?: string;
}

interface DeviceRequestRecord {
  device_code: string;
  user_code: string;
  public_key: string;
  ssh_public_key?: string;
  hostname: string;
  os: string;
  name: string;
  status: 'pending' | 'approved' | 'denied';
  created_at: string;
  expires_at: number;
  approved_by?: string;
  peer?: MeshPeerRecord;
  peers?: MeshPeerRecord[];
}

function generateUserCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let res = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) res += '-';
    res += chars[Math.floor(Math.random() * chars.length)];
  }
  return res;
}

/**
 * Initiates the OAuth 2.0 Device Flow (RFC 8628) from flarelens-agent
 * POST /api/v1/auth/device/code
 */
export async function handleDeviceCode(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const payload = (await request.json().catch(() => ({}))) as DeviceCodePayload;
    if (!payload.public_key) {
      return new Response(JSON.stringify({ error: 'Missing public_key in request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const deviceCode = `devcode_${crypto.randomUUID().replace(/-/g, '')}`;
    const userCode = generateUserCode();
    const now = Date.now();
    const ttlSeconds = 600; // 10 minutes
    const expiresAt = now + ttlSeconds * 1000;

    const record: DeviceRequestRecord = {
      device_code: deviceCode,
      user_code: userCode,
      public_key: payload.public_key,
      ssh_public_key: payload.ssh_public_key || '',
      hostname: payload.hostname || 'workstation',
      os: payload.os || 'unknown',
      name: payload.name || payload.hostname || 'laptop',
      status: 'pending',
      created_at: new Date(now).toISOString(),
      expires_at: expiresAt,
    };

    if (env.FLEET_KV) {
      ctx.waitUntil(env.FLEET_KV.put(`device_flow:${deviceCode}`, JSON.stringify(record), { expirationTtl: ttlSeconds }));
      ctx.waitUntil(env.FLEET_KV.put(`device_user_code:${userCode}`, deviceCode, { expirationTtl: ttlSeconds }));
    }

    const origin = new URL(request.url).origin;
    return new Response(JSON.stringify({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${origin}/auth/device`,
      verification_uri_complete: `${origin}/auth/device?code=${userCode}`,
      expires_in: ttlSeconds,
      interval: 2,
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

/**
 * Polls for device approval from flarelens-agent
 * POST /api/v1/auth/device/token
 */
export async function handleDeviceToken(request: Request, env: Env): Promise<Response> {
  try {
    const payload = (await request.json().catch(() => ({}))) as { device_code?: string };
    if (!payload.device_code) {
      return new Response(JSON.stringify({ error: 'Missing device_code' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (!env.FLEET_KV) {
      return new Response(JSON.stringify({ error: 'FLEET_KV not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const raw = await env.FLEET_KV.get(`device_flow:${payload.device_code}`);
    if (!raw) {
      return new Response(JSON.stringify({ error: 'expired_token' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const record = JSON.parse(raw) as DeviceRequestRecord;
    if (record.status === 'pending') {
      return new Response(JSON.stringify({ status: 'pending' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (record.status === 'denied') {
      return new Response(JSON.stringify({ error: 'access_denied', message: 'Device was rejected by admin' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    return new Response(JSON.stringify({
      status: 'approved',
      approved_by: record.approved_by,
      peer: record.peer,
      peers: record.peers,
      subnet: MESH_SUBNET,
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

/**
 * Web UI: Approves or Denies device authorization
 * GET /auth/device
 */
export async function handleDeviceApprovePage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').toUpperCase().trim();
  const cfUser = request.headers.get('cf-access-authenticated-user-email') || env.DASHBOARD_USERNAME || 'Authenticated Operator';

  let deviceDetails: DeviceRequestRecord | null = null;
  if (code && env.FLEET_KV) {
    const devCode = await env.FLEET_KV.get(`device_user_code:${code}`);
    if (devCode) {
      const raw = await env.FLEET_KV.get(`device_flow:${devCode}`);
      if (raw) deviceDetails = JSON.parse(raw);
    }
  }

  // Load Mesh Access Policy
  let policy: MeshAccessPolicy = {
    allowed_domains: [],
    allowed_emails: [],
    auto_approve_known_domains: true,
  };
  if (env.FLEET_KV) {
    const pRaw = await env.FLEET_KV.get('mesh:access_policy');
    if (pRaw) {
      try { policy = JSON.parse(pRaw); } catch {}
    }
  }

  const userEmailLower = cfUser.toLowerCase().trim();
  const userDomain = userEmailLower.includes('@') ? userEmailLower.split('@')[1] : '';
  const isDomainAllowed = policy.allowed_domains && policy.allowed_domains.length > 0
    ? policy.allowed_domains.map(d => d.toLowerCase().trim().replace(/^@/, '')).includes(userDomain)
    : false;
  const isEmailAllowed = policy.allowed_emails && policy.allowed_emails.length > 0
    ? policy.allowed_emails.map(e => e.toLowerCase().trim()).includes(userEmailLower)
    : false;
  const hasRestrictions = (policy.allowed_domains?.length > 0) || (policy.allowed_emails?.length > 0);
  const isAuthorized = !hasRestrictions || isDomainAllowed || isEmailAllowed || (!request.headers.get('cf-access-authenticated-user-email') && (userEmailLower === 'admin' || userEmailLower === 'operator' || userEmailLower === (env.DASHBOARD_USERNAME || '').toLowerCase()));

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize Device | FlareLens Sovereign Mesh</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --border: #1f2937;
      --primary: #0284c7;
      --primary-hover: #0369a1;
      --text: #f9fafb;
      --text-muted: #9ca3af;
      --accent: #38bdf8;
      --success: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1.5rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 2.2rem;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
      text-align: center;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: rgba(14, 165, 233, 0.12);
      border: 1px solid rgba(14, 165, 233, 0.3);
      color: var(--accent);
      padding: 0.3rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-bottom: 1.2rem;
    }
    h1 { font-size: 1.45rem; font-weight: 700; margin-bottom: 0.5rem; }
    p.desc { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1.5rem; line-height: 1.5; }
    .code-input {
      width: 100%;
      background: #05080e;
      border: 2px solid var(--border);
      border-radius: 8px;
      padding: 0.75rem;
      font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace;
      font-size: 1.2rem;
      text-align: center;
      color: #fff;
      letter-spacing: 2px;
      margin-bottom: 1.2rem;
      text-transform: uppercase;
      outline: none;
      transition: border-color 0.2s;
    }
    .code-input:focus { border-color: var(--primary); }
    .device-info {
      background: #07090e;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1.5rem;
      text-align: left;
      font-size: 0.8rem;
    }
    .device-info div { display: flex; justify-content: space-between; margin-bottom: 0.4rem; }
    .device-info div:last-child { margin-bottom: 0; }
    .device-info span.label { color: var(--text-muted); }
    .device-info span.val { color: #fff; font-family: monospace; font-weight: 600; }
    .btn {
      width: 100%;
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 8px;
      padding: 0.85rem;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .status-msg { margin-top: 1rem; font-size: 0.85rem; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">🛡️ Cloudflare Zero Trust Verified</div>
    <h1>Authorize Device</h1>
    <p class="desc">Approving this request grants this device encrypted peer-to-peer WireGuard access to the Sovereign Mesh.</p>
    
    <div class="device-info">
      <div><span class="label">Approved As:</span> <span class="val" style="color:var(--accent); font-family:inherit;">${cfUser}</span></div>
      <div><span class="label">Access Status:</span> <span class="val" style="color:${isAuthorized ? 'var(--success)' : '#ef4444'}; font-family:inherit;">${isAuthorized ? '✓ Authorized' + (isDomainAllowed ? ' (@' + userDomain + ')' : '') : '⚠️ Domain Not Allowed'}</span></div>
      ${deviceDetails ? `
        <div><span class="label">Device Name:</span> <span class="val">${deviceDetails.hostname}</span></div>
        <div><span class="label">Platform OS:</span> <span class="val">${deviceDetails.os}</span></div>
        <div><span class="label">Public Key:</span> <span class="val">${deviceDetails.public_key.substring(0, 16)}...</span></div>
      ` : ''}
    </div>

    ${!isAuthorized ? `
      <div style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:0.8rem; margin-bottom:1.2rem; text-align:left; font-size:0.8rem; color:#fca5a5;">
        <strong>Policy Warning:</strong> Your email <code>${cfUser}</code> is not in the allowed domains/emails list for this Sovereign Mesh. Allowed: <code>${policy.allowed_domains.join(', ') || 'configured in dashboard'}</code>.
      </div>
    ` : ''}

    <form id="authForm">
      <input type="text" id="userCodeInput" class="code-input" placeholder="XXXX-XXXX" value="${code}" maxlength="9" required />
      <button type="submit" class="btn" id="btnApprove">Approve Device</button>
    </form>

    <div id="statusMsg" class="status-msg"></div>
  </div>

  <script>
    const form = document.getElementById('authForm');
    const input = document.getElementById('userCodeInput');
    const btn = document.getElementById('btnApprove');
    const statusMsg = document.getElementById('statusMsg');

    input.addEventListener('input', (e) => {
      let val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (val.length > 4) val = val.substring(0, 4) + '-' + val.substring(4, 8);
      e.target.value = val;
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const userCode = input.value.trim().toUpperCase();
      if (!userCode) return;

      btn.disabled = true;
      btn.textContent = 'Approving...';
      statusMsg.style.display = 'none';

      try {
        const resp = await fetch('/api/v1/auth/device/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_code: userCode, action: 'approve' }),
        });

        const data = await resp.json();
        if (resp.ok) {
          form.style.display = 'none';
          statusMsg.style.display = 'block';
          statusMsg.style.color = '#10b981';
          statusMsg.innerHTML = '<strong style="font-size:1.1rem; display:block; margin-bottom:0.5rem;">🎉 Device Approved!</strong>You can now return to your terminal. The connection is active.';
        } else {
          statusMsg.style.display = 'block';
          statusMsg.style.color = '#ef4444';
          statusMsg.textContent = '❌ ' + (data.error || 'Authorization failed');
          btn.disabled = false;
          btn.textContent = 'Approve Device';
        }
      } catch (err) {
        statusMsg.style.display = 'block';
        statusMsg.style.color = '#ef4444';
        statusMsg.textContent = '❌ Network error: ' + err.message;
        btn.disabled = false;
        btn.textContent = 'Approve Device';
      }
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Handles device approval action from Web UI
 * POST /api/v1/auth/device/approve
 */
export async function handleDeviceApproveAction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  loadPeersFn: (env: Env) => Promise<MeshPeerRecord[]>
): Promise<Response> {
  try {
    const payload = (await request.json().catch(() => ({}))) as { user_code?: string; action?: 'approve' | 'deny' };
    const userCode = payload.user_code?.toUpperCase().trim();
    if (!userCode) {
      return new Response(JSON.stringify({ error: 'Missing user_code' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (!env.FLEET_KV) {
      return new Response(JSON.stringify({ error: 'FLEET_KV not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const deviceCode = await env.FLEET_KV.get(`device_user_code:${userCode}`);
    if (!deviceCode) {
      return new Response(JSON.stringify({ error: 'Invalid or expired user_code' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const raw = await env.FLEET_KV.get(`device_flow:${deviceCode}`);
    if (!raw) {
      return new Response(JSON.stringify({ error: 'Expired device request' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const record = JSON.parse(raw) as DeviceRequestRecord;
    const cfUser = request.headers.get('cf-access-authenticated-user-email') || env.DASHBOARD_USERNAME || 'operator';

    if (payload.action === 'deny') {
      record.status = 'denied';
      ctx.waitUntil(env.FLEET_KV.put(`device_flow:${deviceCode}`, JSON.stringify(record), { expirationTtl: 600 }));
      return new Response(JSON.stringify({ status: 'denied' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Enforce Mesh Access & OIDC Policy
    let policy: MeshAccessPolicy = {
      allowed_domains: [],
      allowed_emails: [],
      auto_approve_known_domains: true,
    };
    if (env.FLEET_KV) {
      const pRaw = await env.FLEET_KV.get('mesh:access_policy');
      if (pRaw) {
        try { policy = JSON.parse(pRaw); } catch {}
      }
    }

    const userEmailLower = cfUser.toLowerCase().trim();
    const userDomain = userEmailLower.includes('@') ? userEmailLower.split('@')[1] : '';
    const isDomainAllowed = policy.allowed_domains && policy.allowed_domains.length > 0
      ? policy.allowed_domains.map(d => d.toLowerCase().trim().replace(/^@/, '')).includes(userDomain)
      : false;
    const isEmailAllowed = policy.allowed_emails && policy.allowed_emails.length > 0
      ? policy.allowed_emails.map(e => e.toLowerCase().trim()).includes(userEmailLower)
      : false;
    const hasRestrictions = (policy.allowed_domains?.length > 0) || (policy.allowed_emails?.length > 0);
    const isAuthorized = !hasRestrictions || isDomainAllowed || isEmailAllowed || (!request.headers.get('cf-access-authenticated-user-email') && (userEmailLower === 'admin' || userEmailLower === 'operator' || userEmailLower === (env.DASHBOARD_USERNAME || '').toLowerCase()));

    if (!isAuthorized) {
      return new Response(JSON.stringify({
        error: `Access Denied: Account '${cfUser}' is not permitted by the Mesh Access Policy. Allowed domains: [${policy.allowed_domains.join(', ')}]`,
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Approve: Allocate CGNAT IP and enroll peer
    const allPeers = await loadPeersFn(env);
    const cleanName = (record.hostname || record.name || 'laptop').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const overlayIp = allocateMeshIP(allPeers, 'client');
    const nowIso = new Date().toISOString();
    const clientId = `client-${cleanName}`;

    let clientPeer: MeshPeerRecord = {
      id: clientId,
      name: record.name || cleanName,
      hostname: cleanName,
      magic_dns: `${cleanName}${MAGIC_DNS_SUFFIX}`,
      tailscale_ip: overlayIp,
      overlay_ip: overlayIp,
      public_key: record.public_key,
      ssh_public_key: record.ssh_public_key || '',
      connection_type: 'direct_p2p',
      type: 'client',
      created_by: cfUser,
      os: record.os,
      client_version: 'flarelens-agent/v1.0',
      created_at: nowIso,
      updated_at: nowIso,
      last_seen: nowIso,
      online: true,
      tags: ['laptop', 'sso_approved'],
    };

    allPeers.push(clientPeer);

    // Save peer in KV
    ctx.waitUntil(env.FLEET_KV.put(`mesh:peer:${clientPeer.id}`, JSON.stringify(clientPeer)));
    const idList = allPeers.map((p) => p.id);
    ctx.waitUntil(env.FLEET_KV.put('mesh:peers', JSON.stringify(idList)));

    // Update device flow record with approved status & peer details
    record.status = 'approved';
    record.approved_by = cfUser;
    record.peer = clientPeer;
    record.peers = allPeers;

    ctx.waitUntil(env.FLEET_KV.put(`device_flow:${deviceCode}`, JSON.stringify(record), { expirationTtl: 600 }));

    return new Response(JSON.stringify({
      status: 'approved',
      approved_by: cfUser,
      peer: clientPeer,
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

/**
 * Retrieve current Mesh Access & OIDC Policy
 * GET /api/v1/control/mesh/access-policy
 */
export async function handleGetAccessPolicy(env: Env): Promise<Response> {
  let policy: MeshAccessPolicy = {
    allowed_domains: [],
    allowed_emails: [],
    auto_approve_known_domains: true,
  };
  if (env.FLEET_KV) {
    const raw = await env.FLEET_KV.get('mesh:access_policy');
    if (raw) {
      try {
        policy = JSON.parse(raw);
      } catch {}
    }
  }
  return new Response(JSON.stringify(policy), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

/**
 * Update Mesh Access & OIDC Policy from Web UI
 * POST /api/v1/control/mesh/access-policy
 */
export async function handleSaveAccessPolicy(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as Partial<MeshAccessPolicy>;
    if (!env.FLEET_KV) {
      return new Response(JSON.stringify({ error: 'FLEET_KV not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const cfUser = request.headers.get('cf-access-authenticated-user-email') || env.DASHBOARD_USERNAME || 'admin';

    // Parse & sanitize domains
    let allowedDomains: string[] = [];
    if (Array.isArray(body.allowed_domains)) {
      allowedDomains = body.allowed_domains
        .map((d) => String(d).trim().toLowerCase().replace(/^@/, ''))
        .filter((d) => d.length > 0 && d.includes('.'));
    }

    // Parse & sanitize emails
    let allowedEmails: string[] = [];
    if (Array.isArray(body.allowed_emails)) {
      allowedEmails = body.allowed_emails
        .map((e) => String(e).trim().toLowerCase())
        .filter((e) => e.length > 0 && e.includes('@'));
    }

    const updatedPolicy: MeshAccessPolicy = {
      allowed_domains: allowedDomains,
      allowed_emails: allowedEmails,
      auto_approve_known_domains: body.auto_approve_known_domains !== false,
      updated_at: new Date().toISOString(),
      updated_by: cfUser,
    };

    ctx.waitUntil(env.FLEET_KV.put('mesh:access_policy', JSON.stringify(updatedPolicy)));

    return new Response(JSON.stringify({
      success: true,
      message: 'Access policy saved successfully',
      policy: updatedPolicy,
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
