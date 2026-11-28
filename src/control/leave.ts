import type { MeshPeerRecord } from '../types';

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Extracts the raw 32-byte Ed25519 public key from an OpenSSH authorized_keys line:
 * `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... [comment]`
 */
export function parseOpenSSHEd25519PublicKey(authorizedLine: string): Uint8Array | null {
  const parts = String(authorizedLine || '').trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== 'ssh-ed25519') {
    return null;
  }
  try {
    const blob = decodeBase64(parts[1]);
    if (blob.byteLength < 51) return null;
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const algLen = view.getUint32(0, false);
    if (algLen !== 11 || 4 + algLen + 4 > blob.byteLength) return null;
    const alg = new TextDecoder().decode(blob.subarray(4, 4 + algLen));
    if (alg !== 'ssh-ed25519') return null;
    const keyLen = view.getUint32(4 + algLen, false);
    const keyStart = 4 + algLen + 4;
    if (keyLen !== 32 || keyStart + keyLen > blob.byteLength) return null;
    return blob.subarray(keyStart, keyStart + 32);
  } catch {
    return null;
  }
}

/**
 * Verifies a keyless workstation mesh leave proof signed with the peer's registered Ed25519 SSH key:
 * message = `flarelens-mesh-leave:<public_key>:<timestamp>`
 */
export async function verifyMeshLeaveSignature(
  peer: MeshPeerRecord,
  publicKey: string,
  timestamp: string,
  signatureBase64: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  if (!peer.ssh_public_key || !publicKey || !timestamp || !signatureBase64) {
    return false;
  }
  if (peer.public_key && peer.public_key !== publicKey) {
    return false;
  }
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > 300) {
    return false;
  }
  const rawPub = parseOpenSSHEd25519PublicKey(peer.ssh_public_key);
  if (!rawPub) return false;

  try {
    const sigBytes = decodeBase64(signatureBase64);
    if (sigBytes.byteLength !== 64) return false;
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      rawPub,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const msgBytes = new TextEncoder().encode(`flarelens-mesh-leave:${publicKey}:${timestamp}`);
    return await crypto.subtle.verify({ name: 'Ed25519' }, cryptoKey, sigBytes, msgBytes);
  } catch {
    return false;
  }
}

/**
 * Verifies a keyless workstation tunnel lifecycle proof signed with the peer's registered Ed25519 SSH key:
 * message = `flarelens-mesh-tunnel:<action>:<public_key>:<timestamp>`
 */
export async function verifyMeshTunnelSignature(
  peer: MeshPeerRecord,
  action: 'open' | 'renew' | 'close',
  publicKey: string,
  timestamp: string,
  signatureBase64: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  if (!peer.ssh_public_key || !action || !publicKey || !timestamp || !signatureBase64) {
    return false;
  }
  if (peer.public_key && peer.public_key !== publicKey) {
    return false;
  }
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > 300) {
    return false;
  }
  const rawPub = parseOpenSSHEd25519PublicKey(peer.ssh_public_key);
  if (!rawPub) return false;

  try {
    const sigBytes = decodeBase64(signatureBase64);
    if (sigBytes.byteLength !== 64) return false;
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      rawPub,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const msgBytes = new TextEncoder().encode(`flarelens-mesh-tunnel:${action}:${publicKey}:${timestamp}`);
    return await crypto.subtle.verify({ name: 'Ed25519' }, cryptoKey, sigBytes, msgBytes);
  } catch {
    return false;
  }
}
