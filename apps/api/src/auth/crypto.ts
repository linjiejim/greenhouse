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

/**
 * Encrypt a plaintext string for DB storage. `aad` binds the ciphertext to
 * where it lives (e.g. `mcp:<server>:<user>:access`): copied into another row
 * or field it fails to decrypt. Decrypt with the same `aad`.
 */
export function encryptToken(plaintext: string, aad?: string): string {
  return encrypt(plaintext, getKey(), aad);
}

/** Decrypt a ciphertext string from DB (pass the `aad` it was encrypted with, if any). */
export function decryptToken(ciphertext: string, aad?: string): string {
  return decrypt(ciphertext, getKey(), aad);
}

/** Check if the encryption key is configured. */
export function isEncryptionConfigured(): boolean {
  return !!process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
}
