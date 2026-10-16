/**
 * Vault values are sealed one column at a time with AES-256-GCM under VAULT_ENCRYPTION_KEY, its
 * own key, and bound (AAD) to the table, the row, the column and the member: a value copied into
 * another row, column or member's item fails to open instead of being typed somewhere else.
 * `k1:` names the key generation. Errors never carry a value.
 */

import { decrypt, encrypt } from '@greenhouse/utils/crypto';
import { ApiError } from '../../http/errors.js';

export type VaultColumn = 'username_enc' | 'password_enc' | 'totp_enc';

const PREFIX = 'k1:';

export const vaultAad = (memberId: string, itemId: string, column: VaultColumn) =>
  `vault_items:${itemId}:${column}:${memberId}`;

export const vaultUnavailable = () =>
  new ApiError(503, 'vault_unavailable', 'The password vault is not set up on this server (VAULT_ENCRYPTION_KEY).');

export function createVaultCrypto(keyHex: string | null) {
  const key = keyHex ? Buffer.from(keyHex, 'hex') : null;
  return {
    available: key !== null,

    seal(memberId: string, itemId: string, column: VaultColumn, value: string): string {
      if (!key) throw vaultUnavailable();
      return PREFIX + encrypt(value, key, vaultAad(memberId, itemId, column));
    },

    /** Opens a sealed value; anything that does not open under this row's binding fails the same way. */
    open(memberId: string, itemId: string, column: VaultColumn, sealed: string): string {
      if (!key) throw vaultUnavailable();
      try {
        if (!sealed.startsWith(PREFIX)) throw new Error('unknown key generation');
        return decrypt(sealed.slice(PREFIX.length), key, vaultAad(memberId, itemId, column));
      } catch {
        throw new ApiError(409, 'vault_unreadable', 'This login can no longer be opened. Enter it again in the vault.');
      }
    },
  };
}

export type VaultCrypto = ReturnType<typeof createVaultCrypto>;
