/**
 * GitHub Actions Machine-to-Machine (M2M) OIDC Authentication Engine
 *
 * Implements Workload Identity Federation for CI/CD deployments.
 * Eliminates static webhook secrets, long-lived API tokens, and passwords
 * by cryptographically verifying short-lived OIDC JWTs issued by GitHub Actions.
 */

export interface GitHubOidcClaims {
  jti?: string;
  sub: string;
  aud: string | string[];
  iss: string;
  nbf?: number;
  exp: number;
  iat?: number;
  repository: string;
  repository_owner: string;
  repository_owner_id?: string;
  actor?: string;
  actor_id?: string;
  workflow?: string;
  ref: string;
  ref_type?: string;
  sha?: string;
  run_id?: string;
  run_number?: string;
  run_attempt?: string;
  event_name?: string;
  job_workflow_ref?: string;
}

export interface VerifyOidcOptions {
  expectedAudience?: string | string[];
  allowedOwners?: string[]; // e.g. ['my-github-org']
  allowedRepositories?: string[]; // e.g. ['my-github-org/my-service']
  jwksUri?: string;
  expectedIssuer?: string;
  clockToleranceSeconds?: number;
  mockJwks?: JWKKey[]; // For automated unit testing
}

export interface JWKKey {
  kty: string;
  alg?: string;
  use?: string;
  kid?: string;
  n: string;
  e: string;
}

export interface OidcVerificationResult {
  valid: boolean;
  claims?: GitHubOidcClaims;
  error?: string;
}

const DEFAULT_ISSUER = 'https://token.actions.githubusercontent.com';
const DEFAULT_JWKS_URI = 'https://token.actions.githubusercontent.com/.well-known/jwks';
const DEFAULT_ALLOWED_OWNERS: string[] = [];
const DEFAULT_AUDIENCES: string[] = [];

let jwksCache: { keys: JWKKey[]; fetchedAt: number } | null = null;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return atob(base64);
}

function base64UrlToUint8Array(str: string): Uint8Array {
  const binary = base64UrlDecode(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Checks if a bearer token is an unverified GitHub Actions OIDC token
 */
export function isGitHubOidcToken(token: string): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.trim().split('.');
  if (parts.length !== 3) return false;

  try {
    const payloadJson = JSON.parse(base64UrlDecode(parts[1]));
    return payloadJson?.iss === DEFAULT_ISSUER;
  } catch {
    return false;
  }
}

/**
 * Fetches and caches the GitHub Actions OIDC public key set (JWKS)
 */
export async function getGitHubJwks(jwksUri = DEFAULT_JWKS_URI, forceRefresh = false): Promise<JWKKey[]> {
  const now = Date.now();
  if (!forceRefresh && jwksCache && now - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys;
  }

  const response = await fetch(jwksUri, {
    headers: { 'User-Agent': 'FlareLens-Edge-Gateway/2.0' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub OIDC JWKS: HTTP ${response.status}`);
  }

  const data = (await response.json()) as { keys?: JWKKey[] };
  if (!Array.isArray(data.keys) || data.keys.length === 0) {
    throw new Error('Invalid or empty JWKS response from GitHub');
  }

  jwksCache = { keys: data.keys, fetchedAt: now };
  return data.keys;
}

/**
 * Cryptographically verifies a GitHub Actions M2M OIDC ID token
 */
export async function verifyGitHubOidcToken(
  token: string,
  options: VerifyOidcOptions = {}
): Promise<OidcVerificationResult> {
  try {
    const trimmed = (token || '').trim();
    const parts = trimmed.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Malformed JWT: must consist of 3 parts' };
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // 1. Decode Header
    let header: { alg?: string; kid?: string; typ?: string };
    try {
      header = JSON.parse(base64UrlDecode(headerB64));
    } catch {
      return { valid: false, error: 'Failed to decode JWT header' };
    }

    if (header.alg !== 'RS256') {
      return { valid: false, error: `Unsupported signing algorithm: ${header.alg} (expected RS256)` };
    }

    if (!header.kid) {
      return { valid: false, error: 'JWT header is missing key ID (kid)' };
    }

    // 2. Decode Claims Payload
    let claims: GitHubOidcClaims;
    try {
      claims = JSON.parse(base64UrlDecode(payloadB64));
    } catch {
      return { valid: false, error: 'Failed to decode JWT claims payload' };
    }

    // 3. Resolve Public Signing Key
    let keys = options.mockJwks;
    if (!keys) {
      keys = await getGitHubJwks(options.jwksUri || DEFAULT_JWKS_URI);
    }

    let matchingKey = keys.find((k) => k.kid === header.kid);
    if (!matchingKey && !options.mockJwks) {
      // Key may have rotated; try fresh fetch
      keys = await getGitHubJwks(options.jwksUri || DEFAULT_JWKS_URI, true);
      matchingKey = keys.find((k) => k.kid === header.kid);
    }

    if (!matchingKey) {
      return { valid: false, error: `No matching public key found for kid: ${header.kid}` };
    }

    // 4. Verify Cryptographic Signature with Web Crypto API
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      matchingKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signatureBytes = base64UrlToUint8Array(signatureB64);

    const signatureValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signatureBytes,
      signedData
    );

    if (!signatureValid) {
      return { valid: false, error: 'Cryptographic signature verification failed' };
    }

    // 5. Validate Standard Claims
    const clockTolerance = options.clockToleranceSeconds ?? 60;
    const nowSeconds = Math.floor(Date.now() / 1000);

    const expectedIssuer = options.expectedIssuer || DEFAULT_ISSUER;
    if (claims.iss !== expectedIssuer) {
      return { valid: false, error: `Invalid issuer: ${claims.iss} (expected ${expectedIssuer})` };
    }

    if (typeof claims.exp !== 'number' || claims.exp + clockTolerance < nowSeconds) {
      return { valid: false, error: `Token expired at ${new Date(claims.exp * 1000).toISOString()}` };
    }

    if (claims.nbf && claims.nbf - clockTolerance > nowSeconds) {
      return { valid: false, error: `Token not valid before ${new Date(claims.nbf * 1000).toISOString()}` };
    }

    // 6. Validate Audience
    const allowedAudiences = Array.isArray(options.expectedAudience)
      ? options.expectedAudience
      : options.expectedAudience
      ? [options.expectedAudience]
      : DEFAULT_AUDIENCES;

    const tokenAudiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const audienceMatched = allowedAudiences.some((expected) => tokenAudiences.includes(expected));

    if (!audienceMatched) {
      return {
        valid: false,
        error: `Audience mismatch: token audience [${tokenAudiences.join(', ')}] does not match accepted audiences [${allowedAudiences.join(', ')}]`,
      };
    }

    // 7. Validate Workload Identity Claims (Repository Owner & Repo)
    const allowedOwners = (options.allowedOwners || DEFAULT_ALLOWED_OWNERS).map((o) => o.toLowerCase());
    const tokenOwner = (claims.repository_owner || '').toLowerCase();

    if (!allowedOwners.includes(tokenOwner)) {
      return {
        valid: false,
        error: `Repository owner '${claims.repository_owner}' is not in allowed owners: [${allowedOwners.join(', ')}]`,
      };
    }

    if (options.allowedRepositories && options.allowedRepositories.length > 0) {
      const allowedRepos = options.allowedRepositories.map((r) => r.toLowerCase());
      const tokenRepo = (claims.repository || '').toLowerCase();
      if (!allowedRepos.includes(tokenRepo)) {
        return {
          valid: false,
          error: `Repository '${claims.repository}' is not authorized to trigger deployments`,
        };
      }
    }

    return {
      valid: true,
      claims,
    };
  } catch (err: any) {
    return {
      valid: false,
      error: `OIDC verification exception: ${err?.message || String(err)}`,
    };
  }
}
