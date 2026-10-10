/**
 * Vault field encryption — AES-256-GCM per field, bound to its row.
 *
 * Each secret field is encrypted on its own with AAD `vault:<uid>:<itemId>:<field>`,
 * so a ciphertext copied into another member's row, another item or another
 * field fails authentication instead of decrypting (a DB-level swap can never
 * make the server fill user A's password on user B's behalf).
 *
 * The key is VAULT_ENCRYPTION_KEY — its own, so the vault's key can be rotated
 * without touching provider tokens — or, while that is not set, the deployment's
 * PROVIDER_TOKEN_ENCRYPTION_KEY (auth/crypto.ts). Unlike token storage, a
 * missing or malformed key does not throw a configuration error at the caller:
 * the vault is simply unavailable (`vault_unavailable`), and every surface says so.
 *
 * Stored format: `gv1.<key id>.<base64(IV ‖ ciphertext ‖ tag)>` — the key id
 * (8 hex of the key's own hash) says which key wrote it, so a rotation can read
 * entries written with VAULT_ENCRYPTION_KEY_PREVIOUS (or the provider key) while
 * `pnpm cli vault rekey` rewrites them with the current one. Entries from before
 * the version prefix are bare base64 under PROVIDER_TOKEN_ENCRYPTION_KEY.
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §8.
 */

import { createHash } from 'node:crypto';
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
/** `gv1.<key id>.<payload>`. */
const VERSIONED = /^gv1\.([0-9a-f]{8})\.(.+)$/s;

/**
 * A key from the environment, or null when it is absent or not 64 hex chars.
 * `parseHexKey` only checks the length, and `Buffer.from(…, 'hex')` silently stops
 * at the first non-hex char — a typo'd key would encrypt with a short, weak key.
 */
function parseKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim() ?? '';
  return KEY_PATTERN.test(value) ? Buffer.from(value, 'hex') : null;
}

/**
 * The key new entries are written with. A VAULT_ENCRYPTION_KEY that is set but
 * malformed makes the vault unavailable rather than quietly writing with the
 * provider key — the administrator meant the vault to have its own.
 */
function currentKey(): Buffer | null {
  if (process.env.VAULT_ENCRYPTION_KEY?.trim()) return parseKey(process.env.VAULT_ENCRYPTION_KEY);
  return parseKey(process.env.PROVIDER_TOKEN_ENCRYPTION_KEY);
}

/** Every key a stored entry may have been written with. */
function knownKeys(): Buffer[] {
  return [
    process.env.VAULT_ENCRYPTION_KEY,
    process.env.VAULT_ENCRYPTION_KEY_PREVIOUS,
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY,
  ]
    .map(parseKey)
    .filter((key): key is Buffer => key !== null);
}

/** Which key wrote an entry: 8 hex of the key's own (domain-separated) hash — nothing usable about the key. */
export function vaultKeyId(key: Buffer): string {
  return createHash('sha256').update('greenhouse-vault-key\0').update(key).digest('hex').slice(0, 8);
}

/** Whether the vault can store and fill secrets on this deployment. */
export function isVaultAvailable(): boolean {
  return currentKey() !== null;
}

function requireKey(): Buffer {
  const key = currentKey();
  if (!key) {
    throw new VaultError(
      'vault_unavailable',
      'The password vault is not available: the administrator has not configured VAULT_ENCRYPTION_KEY (or PROVIDER_TOKEN_ENCRYPTION_KEY).',
    );
  }
  return key;
}

export function vaultAad(userId: string, itemId: string, field: VaultField): string {
  return `vault:${userId}:${itemId}:${field}`;
}

export function encryptVaultField(userId: string, itemId: string, field: VaultField, plaintext: string): string {
  const key = requireKey();
  return `gv1.${vaultKeyId(key)}.${encrypt(plaintext, key, vaultAad(userId, itemId, field))}`;
}

/** Whether a stored field was written with the current key (`vault rekey` rewrites the others). */
export function isCurrentVaultCiphertext(ciphertext: string): boolean {
  const key = currentKey();
  const match = VERSIONED.exec(ciphertext);
  return key !== null && match !== null && match[1] === vaultKeyId(key);
}

/**
 * Decrypt one field. A failed authentication (wrong row, tampered data, key
 * rotated without re-encryption) is reported as unavailable rather than
 * leaking crypto details to the model.
 */
export function decryptVaultField(userId: string, itemId: string, field: VaultField, ciphertext: string): string {
  requireKey();
  const aad = vaultAad(userId, itemId, field);
  try {
    const match = VERSIONED.exec(ciphertext);
    if (match) {
      const key = knownKeys().find((known) => vaultKeyId(known) === match[1]);
      if (!key) throw new Error('written with a key this deployment no longer has');
      return decrypt(match[2]!, key, aad);
    }
    // Written before the version prefix: always under the provider key.
    const legacy = parseKey(process.env.PROVIDER_TOKEN_ENCRYPTION_KEY);
    if (!legacy) throw new Error('no PROVIDER_TOKEN_ENCRYPTION_KEY for an entry from before VAULT_ENCRYPTION_KEY');
    return decrypt(ciphertext, legacy, aad);
  } catch {
    throw new VaultError('vault_unavailable', 'This vault entry can no longer be decrypted; re-enter it in Passwords.');
  }
}
