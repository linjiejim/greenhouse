/**
 * `pnpm cli vault rekey` — put every member's password vault, and the key of every Bot
 * computer backup, under the current key.
 *
 * Rotating the vault's key (bots/vault/crypto.ts): set VAULT_ENCRYPTION_KEY to the new
 * key and VAULT_ENCRYPTION_KEY_PREVIOUS to the old one (the first time the vault gets
 * its own key, the old one is PROVIDER_TOKEN_ENCRYPTION_KEY, which stays anyway),
 * restart, run this, then drop the previous key. Entries keep working throughout:
 * every known key reads, only the current one writes.
 */

import chalk from 'chalk';
import { isVaultAvailable } from '../../bots/vault/crypto.js';
import { rekeyVault } from '../../bots/vault/rekey.js';
import { rekeyBackupKeys } from '../../bots/computer/backups.js';
import { openDb, parseFlags, flagBool, splitSub, dim } from './shared.js';

export async function run(args: string[]): Promise<number> {
  const { sub, rest } = splitSub(args, 'help');
  if (sub !== 'rekey') {
    console.log('Usage: pnpm cli vault rekey [--dry-run]   Re-encrypt every vault entry under the current key');
    return sub === 'help' ? 0 : 1;
  }
  if (!isVaultAvailable()) {
    console.error(
      chalk.red('No usable vault key: set VAULT_ENCRYPTION_KEY (or PROVIDER_TOKEN_ENCRYPTION_KEY), 64 hex chars.'),
    );
    return 1;
  }
  const dryRun = flagBool(parseFlags(rest).flags, 'dry-run');
  const db = await openDb();
  const result = await rekeyVault(db, { dryRun });
  const done = dryRun ? 'would be re-encrypted' : 're-encrypted';
  console.log(`${result.entries} entries: ${result.rekeyed} ${done} under the current key.`);
  const backupKeys = await rekeyBackupKeys(db.botComputers, { dryRun });
  console.log(
    `${backupKeys.keys} computer backup keys: ${backupKeys.rekeyed} ${dryRun ? 'would be re-sealed' : 're-sealed'}.`,
  );
  if (backupKeys.unreadable.length > 0) {
    console.log(
      chalk.yellow(
        `${backupKeys.unreadable.length} backup keys no known key can open (those backups cannot be restored):`,
      ),
    );
    for (const id of backupKeys.unreadable) console.log(dim(`  ${id}`));
  }
  if (result.changed > 0)
    console.log(chalk.yellow(`${result.changed} were edited while this ran — run it again for those.`));
  if (result.unreadable.length > 0) {
    console.log(
      chalk.yellow(
        `${result.unreadable.length} no known key can read — left as they are; their members re-enter them:`,
      ),
    );
    for (const entry of result.unreadable) console.log(dim(`  ${entry.id} (member ${entry.user_id})`));
  }
  return result.changed > 0 || result.unreadable.length > 0 || backupKeys.unreadable.length > 0 ? 1 : 0;
}
