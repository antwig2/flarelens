import type { DeployRequestPayload } from '../types';
import { resolveVaultSecrets } from './vault';

export interface ParsedWebhookDeploy {
  service: string;
  image: string;
  ref?: string;
  commit_sha?: string;
  author?: string;
  message?: string;
  node_id?: string;
  env?: string;
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
  pre_deploy_snapshot?: boolean;
  run_migrations?: boolean;
  migration_cmd?: string;
  is_preview?: boolean;
  pr_number?: number;
  domain?: string;
  canary_weight?: number;
  canary_duration?: number;
  action?: 'deploy' | 'teardown';
  secrets?: Record<string, string>;
}

/**
 * Validates GitHub X-Hub-Signature-256 HMAC header against the secret using Web Crypto API.
 */
export async function verifyGitHubSignature(
  secret: string,
  signatureHeader: string | null,
  bodyText: string
): Promise<boolean> {
  if (!secret) return true; // If no webhook secret configured, allow (dev mode)
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const signatureHex = signatureHeader.substring(7);
  const enc = new TextEncoder();

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const match = signatureHex.match(/.{1,2}/g);
    if (!match) return false;
    const sigBytes = new Uint8Array(match.map((byte) => parseInt(byte, 16)));

    return await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      enc.encode(bodyText)
    );
  } catch (e) {
    return false;
  }
}

/**
 * Normalizes different CI/CD webhook payloads (GitHub Push, GHCR package, PR events, or direct JSON)
 */
export function parseDeployWebhook(
  body: any,
  githubEvent?: string | null
): ParsedWebhookDeploy | null {
  if (!body) return null;

  // 1. Direct explicit JSON deploy / teardown payload (from GitHub Actions curl or custom CI)
  if (body.service && (body.image || body.action === 'teardown')) {
    return {
      service: body.service,
      image: body.image || '',
      ref: body.ref || 'refs/heads/main',
      commit_sha: body.commit_sha || body.sha,
      author: body.author || 'CI/CD Webhook',
      message: body.message || 'Automated deployment via CI/CD webhook',
      node_id: body.node_id || 'auto',
      env: body.env || (body.is_preview ? 'preview' : 'production'),
      container_port: body.container_port ? Number(body.container_port) : undefined,
      host_port_blue: body.host_port_blue ? Number(body.host_port_blue) : undefined,
      host_port_green: body.host_port_green ? Number(body.host_port_green) : undefined,
      health_path: body.health_path,
      command: Array.isArray(body.command) ? body.command : undefined,
      entrypoint: Array.isArray(body.entrypoint) ? body.entrypoint : undefined,
      networks: Array.isArray(body.networks) ? body.networks : undefined,
      volumes: Array.isArray(body.volumes) ? body.volumes : undefined,
      workers: Array.isArray(body.workers) ? body.workers : undefined,
      timeout_seconds: body.timeout_seconds ? Number(body.timeout_seconds) : undefined,
      drain_seconds: body.drain_seconds ? Number(body.drain_seconds) : undefined,
      pre_deploy_snapshot: body.pre_deploy_snapshot !== undefined ? Boolean(body.pre_deploy_snapshot) : undefined,
      run_migrations: body.run_migrations !== undefined ? Boolean(body.run_migrations) : undefined,
      migration_cmd: body.migration_cmd,
      is_preview: Boolean(body.is_preview),
      pr_number: body.pr_number ? Number(body.pr_number) : undefined,
      domain: body.domain,
      canary_weight: body.canary_weight ? Number(body.canary_weight) : undefined,
      canary_duration: body.canary_duration ? Number(body.canary_duration) : undefined,
      action: body.action === 'teardown' ? 'teardown' : 'deploy',
      secrets: body.secrets && typeof body.secrets === 'object' ? body.secrets : undefined,
    };
  }

  // 2. GitHub Pull Request Event (Automated Ephemeral PR Preview Environments)
  if (githubEvent === 'pull_request' || (body.pull_request && body.action)) {
    const pr = body.pull_request;
    const prNumber = body.number || pr?.number;
    const repoName: string = (body.repository?.name || 'app').toLowerCase();
    const repoFull: string = (body.repository?.full_name || '').toLowerCase();
    const action = body.action; // 'opened', 'synchronize', 'reopened', 'closed'

    if (action === 'closed') {
      return {
        service: repoName,
        image: '',
        ref: pr?.head?.ref || `refs/pull/${prNumber}/head`,
        commit_sha: pr?.head?.sha || 'closed',
        author: pr?.user?.login || body.sender?.login || 'GitHub PR',
        message: `PR #${prNumber} closed. Tearing down ephemeral preview environment.`,
        node_id: 'all',
        env: 'preview',
        is_preview: true,
        pr_number: prNumber,
        domain: `pr-${prNumber}-${repoName}.example.com`,
        action: 'teardown',
      };
    }

    if (['opened', 'synchronize', 'reopened'].includes(action)) {
      const commitSha = pr?.head?.sha || 'latest';
      const shortSha = commitSha.substring(0, 7);
      const image = `ghcr.io/${repoFull || repoName}:pr-${prNumber}-${shortSha}`;

      return {
        service: repoName,
        image,
        ref: pr?.head?.ref || `refs/pull/${prNumber}/head`,
        commit_sha: commitSha,
        author: pr?.user?.login || body.sender?.login || 'GitHub PR',
        message: `PR #${prNumber} (${action}): ${pr?.title || 'Ephemeral preview'}`,
        node_id: 'all',
        env: 'preview',
        is_preview: true,
        pr_number: prNumber,
        domain: `pr-${prNumber}-${repoName}.example.com`,
        action: 'deploy',
      };
    }
  }

  // 3. GitHub Push Event (refs/heads/main or refs/tags/v*)
  if (body.ref && body.repository) {
    const repoName: string = body.repository.name || '';
    const repoFull: string = body.repository.full_name || '';
    const commitSha: string = body.after || (body.head_commit && body.head_commit.id) || 'latest';
    const shortSha = commitSha.substring(0, 7);
    const author = body.head_commit?.author?.username || body.pusher?.name || 'GitHub';
    const message = body.head_commit?.message || 'Push event';

    let tag = '';
    if (body.ref.startsWith('refs/tags/')) {
      tag = body.ref.replace('refs/tags/', '');
    }

    // Default container image naming convention: ghcr.io/<org>/<repo>:<tag or short-sha>
    const imageTag = tag || shortSha;
    const image = `ghcr.io/${repoFull.toLowerCase()}:${imageTag}`;

    return {
      service: repoName.toLowerCase(),
      image,
      ref: body.ref,
      commit_sha: commitSha,
      author,
      message,
      node_id: 'all-prod',
      env: tag.includes('beta') || tag.includes('rc') ? 'staging' : 'production',
      action: 'deploy',
    };
  }

  // 4. GitHub Package Event (GHCR container published)
  if (body.package && body.package_version) {
    const pkgName: string = body.package.name || '';
    const tag: string = body.package_version.version || 'latest';
    const repoFull: string = body.repository?.full_name || '';

    return {
      service: pkgName.toLowerCase(),
      image: `ghcr.io/${repoFull.toLowerCase()}/${pkgName.toLowerCase()}:${tag}`,
      commit_sha: body.package_version.source_url?.split('/')?.pop() || 'latest',
      author: body.sender?.login || 'GHCR',
      message: `New container package published: ${pkgName}:${tag}`,
      node_id: 'all-prod',
      env: 'production',
      action: 'deploy',
    };
  }

  return null;
}

/**
 * Optional: reports deployment status back to GitHub Commit Status API
 */
export async function reportGitHubStatus(
  repoFullName: string,
  commitSha: string,
  token: string | undefined,
  state: 'pending' | 'success' | 'failure' | 'error',
  targetUrl: string,
  description: string
): Promise<void> {
  if (!token || !repoFullName || !commitSha || commitSha === 'latest') return;

  try {
    const url = `https://api.github.com/repos/${repoFullName}/statuses/${commitSha}`;
    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'User-Agent': 'FlareLens-GitOps-Edge',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state,
        target_url: targetUrl,
        description: description.substring(0, 140),
        context: 'flarelens/gitops-deploy',
      }),
    });
  } catch (err) {
    console.warn('Failed to report commit status to GitHub:', err);
  }
}

export interface ServiceDeclarativeDefaults {
  container_port?: number;
  host_port_blue?: number;
  host_port_green?: number;
  health_path?: string;
  domain?: string;
  command?: string[];
  entrypoint?: string[];
  migration_cmd?: string;
  networks?: string[];
  workers?: Array<{
    name: string;
    command?: string[];
    entrypoint?: string[];
    volumes?: string[];
    networks?: string[];
  }>;
  timeout_seconds?: number;
  drain_seconds?: number;
  pre_deploy_snapshot?: boolean;
}

/**
 * Resolves declarative profile defaults for known microservices
 * matching the server agent's profiles and fleet manifests.
 */
export function getServiceDeclarativeDefaults(service: string, envName: string = 'uat'): ServiceDeclarativeDefaults {
  // Sensible declarative defaults for standard 12-factor containerized services
  return {
    container_port: 8080,
    health_path: "/health",
    timeout_seconds: 60,
    drain_seconds: 15,
  };
}

/**
 * Resolves zero-plaintext secrets from Vault and combines them with
 * declarative Blue/Green configuration for guaranteed safe agent dispatch.
 */
export async function resolveWebhookDeployPayload(
  parsed: ParsedWebhookDeploy,
  kv?: any,
  masterKey?: string
): Promise<DeployRequestPayload> {
  const envName = parsed.env || (parsed.is_preview ? 'preview' : 'production');
  const defaults = getServiceDeclarativeDefaults(parsed.service, envName);

  // 1. In-memory zero-plaintext secret resolution
  let resolvedSecrets = parsed.secrets;
  if (!resolvedSecrets && kv) {
    const vaultRes = await resolveVaultSecrets(kv, parsed.service, envName, masterKey);
    if (vaultRes?.secrets) {
      resolvedSecrets = vaultRes.secrets;
    }
  }

  // 2. Assemble complete deployment request payload
  const deployReq: DeployRequestPayload = {
    service: parsed.service,
    image: parsed.image,
    env: envName,
    node_id: parsed.node_id || 'all-prod',
    domain: parsed.domain || defaults.domain,
    container_port: parsed.container_port || defaults.container_port,
    host_port_blue: parsed.host_port_blue || defaults.host_port_blue,
    host_port_green: parsed.host_port_green || defaults.host_port_green,
    health_path: parsed.health_path || defaults.health_path,
    command: parsed.command || defaults.command,
    entrypoint: parsed.entrypoint || defaults.entrypoint,
    networks: parsed.networks || defaults.networks,
    volumes: parsed.volumes,
    workers: parsed.workers || defaults.workers,
    timeout_seconds: parsed.timeout_seconds || defaults.timeout_seconds,
    drain_seconds: parsed.drain_seconds || defaults.drain_seconds,
    pre_deploy_snapshot: parsed.pre_deploy_snapshot !== undefined ? parsed.pre_deploy_snapshot : defaults.pre_deploy_snapshot,
    run_migrations: parsed.run_migrations,
    migration_cmd: parsed.migration_cmd || defaults.migration_cmd,
    canary_weight: parsed.canary_weight,
    canary_duration: parsed.canary_duration,
    is_preview: parsed.is_preview,
    pr_number: parsed.pr_number,
    secrets: resolvedSecrets,
  };

  return deployReq;
}
