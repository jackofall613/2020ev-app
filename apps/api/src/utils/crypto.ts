import crypto from 'crypto';

/**
 * AES-256-GCM encryption for per-building secrets at rest (ChargePoint API
 * credentials). The master key comes from env `CP_CRED_KEY` — 64 hex chars
 * (32 bytes). Stored format is `iv:tag:ciphertext` (all hex).
 *
 * The key lives ONLY in the Railway env, never in git. Plaintext credentials
 * must never be logged. Callers should treat a missing/invalid key as "encryption
 * unavailable" (see `credEncryptionAvailable`) rather than crashing the process.
 */

const KEY_HEX = process.env.CP_CRED_KEY || '';
const KEY_RE = /^[0-9a-fA-F]{64}$/;

function getKey(): Buffer {
  if (!KEY_RE.test(KEY_HEX)) {
    throw new Error('CP_CRED_KEY must be 64 hex chars (32 bytes) to encrypt/decrypt credentials');
  }
  return Buffer.from(KEY_HEX, 'hex');
}

/** True when a usable master key is configured. */
export function credEncryptionAvailable(): boolean {
  return KEY_RE.test(KEY_HEX);
}

/** Encrypt a UTF-8 secret. Returns `iv:tag:ciphertext` (hex). */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

/** Decrypt a value produced by `encryptSecret`. Throws on tamper/format errors. */
export function decryptSecret(payload: string): string {
  const key = getKey();
  const [ivHex, tagHex, dataHex] = (payload || '').split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Malformed encrypted secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
