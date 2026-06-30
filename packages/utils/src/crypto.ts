/**
 * AES-256-GCM encryption — shared module for all credential encryption needs.
 *
 * Encrypt/decrypt arbitrary strings using AES-256-GCM with:
 * - 12-byte random IV (per-operation)
 * - 16-byte authentication tag (integrity check)
 * - Caller-provided 32-byte key
 *
 * Output format: base64(IV + ciphertext + authTag)
 *
 * Usage:
 *   const key = getKeyFromEnv('MY_ENCRYPTION_KEY');
 *   const encrypted = encrypt('secret', key);
 *   const decrypted = decrypt(encrypted, key);
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Validate and parse a hex-encoded 32-byte key from a string.
 * @throws if the key is not 64 hex characters
 */
export function parseHexKey(keyHex: string, envVarName?: string): Buffer {
  if (!keyHex) {
    const label = envVarName ? `${envVarName} env var` : 'Encryption key';
    throw new Error(
      `${label} is required. ` +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  if (keyHex.length !== 64) {
    const label = envVarName || 'Encryption key';
    throw new Error(`${label} must be 64 hex chars (32 bytes), got ${keyHex.length} chars`);
  }
  return Buffer.from(keyHex, 'hex');
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * @returns base64-encoded string containing iv + ciphertext + authTag
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

/**
 * Decrypt a base64-encoded ciphertext string.
 * @returns the original plaintext
 * @throws if the key is wrong, data is tampered, or format is invalid
 */
export function decrypt(ciphertext: string, key: Buffer): string {
  const packed = Buffer.from(ciphertext, 'base64');

  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted data: too short');
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(packed.length - AUTH_TAG_LENGTH);
  const encrypted = packed.subarray(IV_LENGTH, packed.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
