/**
 * FlareLens Encrypted Secrets Vault (AES-256-GCM)
 * Uses native Web Crypto API for zero-dependency edge encryption.
 */

import { EncryptedVaultPayload, VaultMetadata } from '../types';

/**
 * Derives a 256-bit AES-GCM CryptoKey from a secret passphrase using SHA-256
 */
async function getCryptoKey(masterKey: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyBytes = enc.encode(masterKey);
  const hash = await crypto.subtle.digest('SHA-256', keyBytes);

  return crypto.subtle.importKey(
    'raw',
    hash,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts an arbitrary key-value secrets dictionary into AES-256-GCM
 */
export async function encryptSecrets(
  service: string,
  secrets: Record<string, string>,
  masterKey: string,
  env: string = 'production'
): Promise<EncryptedVaultPayload> {
  const cryptoKey = await getCryptoKey(masterKey);
  const enc = new TextEncoder();

  // 12-byte random IV as recommended for AES-GCM
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = enc.encode(JSON.stringify(secrets));

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    plaintext
  );

  const ivBase64 = btoa(String.fromCharCode(...iv));
  const ciphertextBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertextBuf)));

  return {
    service,
    env,
    iv: ivBase64,
    ciphertext: ciphertextBase64,
    updated_at: new Date().toISOString(),
    keys_count: Object.keys(secrets).length,
  };
}

/**
 * Decrypts an AES-256-GCM payload into a key-value secrets dictionary
 */
export async function decryptSecrets(
  payload: EncryptedVaultPayload,
  masterKey: string
): Promise<Record<string, string>> {
  const cryptoKey = await getCryptoKey(masterKey);

  const ivBinary = atob(payload.iv);
  const iv = new Uint8Array(ivBinary.length);
  for (let i = 0; i < ivBinary.length; i++) {
    iv[i] = ivBinary.charCodeAt(i);
  }

  const cipherBinary = atob(payload.ciphertext);
  const ciphertext = new Uint8Array(cipherBinary.length);
  for (let i = 0; i < cipherBinary.length; i++) {
    ciphertext[i] = cipherBinary.charCodeAt(i);
  }

  const decryptedBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext
  );

  const dec = new TextDecoder();
  const jsonStr = dec.decode(decryptedBuf);
  return JSON.parse(jsonStr);
}

/**
 * Parses raw .env content into key-value pairs
 */
export function parseEnvContent(envContent: string): Record<string, string> {
  const lines = envContent.split('\n');
  const result: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;

    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();

    // Strip surrounding quotes if present
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    if (key) {
      result[key] = val;
    }
  }

  return result;
}

/**
 * Resolves candidate KV keys for looking up service secrets in Vault.
 * Handles conventions where secrets are saved under <service>-<env> (e.g. app-prod, app-staging)
 * while deployments pass service "app" with env "staging" or "production".
 */
export function getVaultLookupKeys(service: string, envName?: string): string[] {
  const s = service.trim().toLowerCase();
  const clean = s.replace(/-(uat|prod|production|dev|staging|preview|infra|infrastructure)$/, '');
  const env = (envName || 'production').trim().toLowerCase();
  const envSuffix = (env === 'production' || env === 'prod') ? 'prod' : env;

  const keys: string[] = [];

  // 1. Most specific: clean service name + short environment suffix (e.g. vault:app-prod)
  keys.push(`vault:${clean}-${envSuffix}`);

  // 2. Clean service name + full environment name if different (e.g. vault:app-production)
  if (envSuffix !== env) {
    keys.push(`vault:${clean}-${env}`);
  }

  // 3. Exact service name as provided
  if (!keys.includes(`vault:${s}`)) {
    keys.push(`vault:${s}`);
  }

  // 4. Clean service name (e.g. vault:app)
  if (!keys.includes(`vault:${clean}`)) {
    keys.push(`vault:${clean}`);
  }

  return keys;
}

/**
 * Resolves and decrypts zero-plaintext secrets directly from Cloudflare KV.
 * Searches candidate vault lookup keys in priority order.
 */
export async function resolveVaultSecrets(
  kv: any,
  service: string,
  envName: string = 'production',
  masterKey?: string
): Promise<{ secrets: Record<string, string>; matchedKey: string } | null> {
  if (!kv || typeof kv.get !== 'function') return null;

  const lookupKeys = getVaultLookupKeys(service, envName);
  let raw: string | null = null;
  let matchedKey = '';

  for (const k of lookupKeys) {
    try {
      raw = await kv.get(k);
      if (raw) {
        matchedKey = k;
        break;
      }
    } catch {}
  }

  if (!raw) return null;

  try {
    const encPayload = JSON.parse(raw) as EncryptedVaultPayload;
    const keyToUse = masterKey || 'flarelens-default-vault-key';
    const decrypted = await decryptSecrets(encPayload, keyToUse);
    return { secrets: decrypted, matchedKey };
  } catch (err) {
    console.error(`Failed to decrypt vault secrets for ${service}:`, err);
    return null;
  }
}
