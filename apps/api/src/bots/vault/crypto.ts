/**
 * Vault field encryption — AES-256-GCM per field, bound to its row.
 *
 * Each secret field is encrypted on its own with AAD `vault:<uid>:<itemId>:<field>`,
 * so a ciphertext copied into another member's row, another item or another
 * field fails authentication instead of decrypting (a DB-level swap can never
 * make the server fill user A's password on user B's behalf).
 *
 * The key is the deployment's PROVIDER_TOKEN_ENCRYPTION_KEY (same key as
 * provider tokens, see auth/crypto.ts). Unlike token storage, a missing or
 * malformed key does not throw a configuration error at the caller: the vault
 * is simply unavailable (`vault_unavailable`), and every surface says so.
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §8.
 */

import { decrypt, encrypt } from '@greenhouse/utils/crypto';

export type VaultField = 'username' | 'password' | 'totp';

export type VaultErrorCode =
  | 'vault_unavailable'
  | 'origin_invalid'
  | 'origin_forbidden'
  | 'label_invalid'
  | 'totp_invalid'
  | 'invalid'
  | 'not_found';

/** A vault failure with a stable code; `message` is user-facing and never carries a secret. */
export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

const KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * The key, or null when it is absent or not 64 hex chars. `parseHexKey` only
 * checks the length, and `Buffer.from(…, 'hex')` silently stops at the first
 * non-hex char — a typo'd key would encrypt with a short, weak key. Validate
 * the format here instead.
 */
function vaultKey(): Buffer | null {
  const raw = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY?.trim() ?? '';
  if (!KEY_PATTERN.test(raw)) return null;
  return Buffer.from(raw, 'hex');
}

/** Whether the vault can store and fill secrets on this deployment. */
export function isVaultAvailable(): boolean {
  return vaultKey() !== null;
}

function requireKey(): Buffer {
  const key = vaultKey();
  if (!key) {
    throw new VaultError(
      'vault_unavailable',
      'The password vault is not available: the administrator has not configured PROVIDER_TOKEN_ENCRYPTION_KEY.',
    );
  }
  return key;
}

export function vaultAad(userId: string, itemId: string, field: VaultField): string {
  return `vault:${userId}:${itemId}:${field}`;
}

export function encryptVaultField(userId: string, itemId: string, field: VaultField, plaintext: string): string {
  return encrypt(plaintext, requireKey(), vaultAad(userId, itemId, field));
}

/**
 * Decrypt one field. A failed authentication (wrong row, tampered data, key
 * rotated without re-encryption) is reported as unavailable rather than
 * leaking crypto details to the model.
 */
export function decryptVaultField(userId: string, itemId: string, field: VaultField, ciphertext: string): string {
  const key = requireKey();
  try {
    return decrypt(ciphertext, key, vaultAad(userId, itemId, field));
  } catch {
    throw new VaultError('vault_unavailable', 'This vault entry can no longer be decrypted; re-enter it in Passwords.');
  }
}
