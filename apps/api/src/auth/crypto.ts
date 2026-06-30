/**
 * Token encryption — AES-256-GCM for provider token storage.
 *
 * Wraps the shared @greenhouse/utils/crypto module with the
 * PROVIDER_TOKEN_ENCRYPTION_KEY environment variable.
 */

import { encrypt, decrypt, parseHexKey } from '@greenhouse/utils/crypto';

function getKey(): Buffer {
  return parseHexKey(process.env.PROVIDER_TOKEN_ENCRYPTION_KEY ?? '', 'PROVIDER_TOKEN_ENCRYPTION_KEY');
}

/** Encrypt a plaintext string for DB storage. */
export function encryptToken(plaintext: string): string {
  return encrypt(plaintext, getKey());
}

/** Decrypt a ciphertext string from DB. */
export function decryptToken(ciphertext: string): string {
  return decrypt(ciphertext, getKey());
}

/** Check if the encryption key is configured. */
export function isEncryptionConfigured(): boolean {
  return !!process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
}
