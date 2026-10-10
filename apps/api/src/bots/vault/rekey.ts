/**
 * Re-encrypt every member's vault under the current key (`pnpm cli vault rekey`).
 *
 * A field already written with the current key is skipped, so a rerun only does
 * what is left. Each row is swapped only while it still holds what was read
 * (`replaceCiphertext`) — an edit its member made meanwhile is never undone; that
 * row is counted as changed and picked up by the next run. A row no known key can
 * read is reported and left as it is (its member re-enters it).
 */

import type { DatabaseProvider, VaultCipherColumn, VaultCipherSwap } from '@greenhouse/db';
import { decryptVaultField, encryptVaultField, isCurrentVaultCiphertext, type VaultField } from './crypto.js';

const FIELDS: Array<[VaultField, VaultCipherColumn]> = [
  ['username', 'username_enc'],
  ['password', 'password_enc'],
  ['totp', 'totp_enc'],
];

export interface RekeyResult {
  entries: number;
  rekeyed: number;
  /** Edited while this ran — left for the next run. */
  changed: number;
  unreadable: Array<{ id: string; user_id: string }>;
}

export async function rekeyVault(
  db: Pick<DatabaseProvider, 'vault'>,
  opts: { dryRun?: boolean } = {},
): Promise<RekeyResult> {
  const result: RekeyResult = { entries: 0, rekeyed: 0, changed: 0, unreadable: [] };
  for (const row of await db.vault.listAll()) {
    result.entries++;
    const swap: VaultCipherSwap = {};
    try {
      for (const [field, column] of FIELDS) {
        const stored = row[column];
        if (!stored || isCurrentVaultCiphertext(stored)) continue;
        const secret = decryptVaultField(row.user_id, row.id, field, stored);
        swap[column] = { from: stored, to: encryptVaultField(row.user_id, row.id, field, secret) };
      }
    } catch {
      result.unreadable.push({ id: row.id, user_id: row.user_id });
      continue;
    }
    if (Object.keys(swap).length === 0) continue;
    if (opts.dryRun || (await db.vault.replaceCiphertext(row.user_id, row.id, swap))) result.rekeyed++;
    else result.changed++;
  }
  return result;
}
