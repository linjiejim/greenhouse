/**
 * Platform Kernel maintenance commands. `bootstrap` is safe to repeat.
 * New plugins start from plugins/example (EXTENDING.md), not from a generator.
 */

import chalk from 'chalk';
import { bootstrapPlatform } from '../../plugin-host/bootstrap.js';
import { flagBool, heading, openDb, parseFlags, splitSub } from './shared.js';

export async function run(args: string[]): Promise<number> {
  const { sub, rest } = splitSub(args, 'bootstrap');
  if (sub !== 'bootstrap') {
    console.error(chalk.red(`Unknown platform subcommand: ${sub} — use: platform bootstrap`));
    return 1;
  }
  const parsed = parseFlags(rest);
  const db = await openDb();
  const result = await bootstrapPlatform(db);
  if (flagBool(parsed.flags, 'json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(heading('Platform Kernel bootstrap'));
    console.log(chalk.green('✓ Manifest releases, system roles, policies, and legacy bindings are synchronized'));
    console.log(JSON.stringify(result, null, 2));
  }
  return 0;
}
