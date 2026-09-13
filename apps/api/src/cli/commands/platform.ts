/**
 * Platform Kernel maintenance commands.
 *
 * `bootstrap` is safe to repeat. `create-app` writes a fail-closed application
 * boundary without editing bootstrap/runtime files behind the developer's back.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import chalk from 'chalk';
import { bootstrapPlatform } from '../../platform/bootstrap.js';
import { buildPlatformAppScaffold } from '../../platform/scaffold.js';
import { REPO_ROOT } from '../../paths.js';
import { flagBool, flagStr, heading, openDb, parseFlags, splitSub } from './shared.js';

async function createApp(rest: string[]): Promise<number> {
  const parsed = parseFlags(rest);
  const appId = parsed.positionals[0];
  if (!appId) {
    console.error(chalk.red('Application ID is required — use: platform create-app <appId> [--title "Title"]'));
    return 1;
  }

  const scaffold = buildPlatformAppScaffold({
    appId,
    title: flagStr(parsed.flags, 'title'),
  });
  const output = flagStr(parsed.flags, 'output') ?? `apps/api/src/platform/${scaffold.appId}`;
  const target = resolve(REPO_ROOT, output);
  if (target !== REPO_ROOT && !target.startsWith(`${REPO_ROOT}${sep}`)) {
    console.error(chalk.red('Output directory must remain inside the repository'));
    return 1;
  }

  const dryRun = flagBool(parsed.flags, 'dry-run');
  if (!dryRun) {
    try {
      await mkdir(dirname(target), { recursive: true });
      await mkdir(target);
      for (const file of scaffold.files) {
        await writeFile(resolve(target, file.path), file.content, {
          encoding: 'utf8',
          flag: 'wx',
        });
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'EEXIST') {
        console.error(
          chalk.red(`Refusing to overwrite existing application directory: ${relative(REPO_ROOT, target)}`),
        );
        return 1;
      }
      throw error;
    }
  }

  const result = {
    appId: scaffold.appId,
    output: relative(REPO_ROOT, target),
    dryRun,
    files: scaffold.files.map((file) => file.path),
    nextSteps: scaffold.nextSteps,
  };
  if (flagBool(parsed.flags, 'json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(heading(`${dryRun ? 'Previewed' : 'Created'} Platform application: ${scaffold.title}`));
    console.log(chalk.green(`${dryRun ? '✓ would write' : '✓'} ${result.output}`));
    for (const step of scaffold.nextSteps) console.log(`  • ${step}`);
  }
  return 0;
}

export async function run(args: string[]): Promise<number> {
  const { sub, rest } = splitSub(args, 'bootstrap');
  if (sub === 'create-app') return createApp(rest);
  if (sub !== 'bootstrap') {
    console.error(chalk.red(`Unknown platform subcommand: ${sub} — use: platform bootstrap | platform create-app`));
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
