/**
 * `admin db` — database overview and the destructive reset.
 *
 *   pnpm cli stats          # row counts across core tables + health
 *   pnpm cli db reset       # TRUNCATE every table (type the db name to confirm)
 *   pnpm cli db baseline    # adopt an existing database: record the migration
 *                           # chain (core + enabled extensions) as applied
 */

import chalk from 'chalk';
import { sql } from 'drizzle-orm';
import { readCoreMigrations } from '@greenhouse/db';
import { DRIZZLE_DIR } from '../../paths.js';
import { extensionMigrationSources } from '../../extensions/boot.js';
import {
  openDb,
  parseFlags,
  flagBool,
  confirmExact,
  splitSub,
  table,
  kvBlock,
  heading,
  dim,
  dbName,
  redactDbUrl,
} from './shared.js';

/** Core tables surfaced in the overview (missing tables render as n/a). */
const STAT_TABLES = [
  'users',
  'sessions',
  'messages',
  'projects',
  'tasks',
  'knowledge_base',
  'custom_profiles',
  'api_clients',
  'scheduled_tasks',
  'feature_requests',
];

export async function run(args: string[]): Promise<number> {
  const { sub, rest } = splitSub(args, 'stats');
  if (sub === 'stats' || sub === 'overview') return stats(rest);
  if (sub === 'reset') return reset(rest);
  if (sub === 'baseline') return baseline(rest);
  console.error(chalk.red(`Unknown db subcommand: ${sub} (expected: stats | reset | baseline)`));
  return 1;
}

/**
 * Adopt a database that already has the schema: record the core chain and every
 * enabled extension's migrations as applied, without executing any of them.
 *
 * This is the one-time step when an existing instance moves onto this codebase.
 * It asserts nothing about the real schema — run `--dry-run` first, compare with
 * `drizzle-kit generate` output, and only then commit.
 */
async function baseline(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const dryRun = flagBool(flags, 'dry-run');
  const db = await openDb();

  const core = readCoreMigrations(DRIZZLE_DIR);
  const coreState = await db.coreMigrationBaseline.status(core);
  const corePending = coreState.filter((entry) => !entry.recorded);

  const sources = extensionMigrationSources();
  const extensionState = await db.extensionMigrations.status(sources);
  const extensionPending = extensionState.filter((entry) => !entry.applied);
  const drifted = extensionState.filter((entry) => entry.drifted);

  heading('Migration baseline');
  console.log(
    kvBlock([
      ['Database', redactDbUrl()],
      ['Core chain', `${core.length} file(s), ${corePending.length} to record`],
      ['Extensions', sources.length === 0 ? dim('none enabled') : sources.map((s) => s.extensionId).join(', ')],
      ['Extension chain', `${extensionState.length} file(s), ${extensionPending.length} to record`],
    ]),
  );
  if (corePending.length > 0) console.log(dim(`  core:      ${corePending.map((e) => e.tag).join(', ')}`));
  if (extensionPending.length > 0) {
    console.log(dim(`  extension: ${extensionPending.map((e) => `${e.extensionId}/${e.name}`).join(', ')}`));
  }
  if (drifted.length > 0) {
    console.error(
      chalk.red(`\n${drifted.length} extension migration(s) changed after they were applied — fix those first:`),
    );
    for (const entry of drifted) console.error(`  ${entry.extensionId}/${entry.name}`);
    return 1;
  }
  if (corePending.length === 0 && extensionPending.length === 0) {
    console.log(chalk.green('\nNothing to record — this database is already in step with the chain.'));
    return 0;
  }
  if (dryRun) {
    console.log(dim('\n--dry-run: nothing written.'));
    return 0;
  }
  if (!(await confirmExact(dbName(), `Type the database name to record these as applied (${dbName()}): `))) {
    console.log(dim('Aborted.'));
    return 1;
  }

  const coreResult = await db.coreMigrationBaseline.apply(core);
  const extensionResult = await db.extensionMigrations.baseline(sources);
  console.log(
    chalk.green(
      `\nRecorded ${coreResult.recorded.length} core and ${extensionResult.recorded.length} extension migration(s).`,
    ),
  );
  console.log(dim('Verify with `pnpm drizzle-kit migrate` — it should now be a no-op.'));
  return 0;
}

async function stats(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const db = await openDb();
  const health = await db.healthCheck();

  const counts: Record<string, number | null> = {};
  for (const t of STAT_TABLES) {
    try {
      const rows = await db.executeRaw(sql.raw(`SELECT COUNT(*)::int AS c FROM ${t}`));
      counts[t] = Number((rows[0] as { c: number } | undefined)?.c ?? 0);
    } catch {
      counts[t] = null; // table not present in this deployment
    }
  }

  if (flagBool(flags, 'json')) {
    console.log(JSON.stringify({ database: dbName(), health, counts }, null, 2));
    return 0;
  }

  console.log(heading(`${dbName()} — overview`));
  console.log(
    kvBlock([
      ['Connection', redactDbUrl()],
      ['Health', health.ok ? chalk.green(`ok (${health.latencyMs}ms)`) : chalk.red('unreachable')],
    ]),
  );
  console.log(heading('Row counts'));
  console.log(
    table(
      ['Table', 'Rows'],
      STAT_TABLES.map((t) => [t, counts[t] === null ? dim('n/a') : String(counts[t])]),
    ),
  );
  return 0;
}

async function reset(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const db = await openDb();
  const userCount = await db.users.count().catch(() => 0);

  console.log(chalk.red.bold(`\n⚠ DESTRUCTIVE — this truncates ALL tables in "${dbName()}".`));
  console.log(dim(`  Current: ${userCount} user(s).  Connection: ${redactDbUrl()}`));

  if (!flagBool(flags, 'yes')) {
    const ok = await confirmExact(`\nType the database name "${chalk.bold(dbName())}" to confirm: `, dbName());
    if (!ok) {
      console.log('Cancelled.');
      return 1;
    }
  }

  await db.resetSchema();
  console.log(chalk.green(`✓ Database "${dbName()}" reset — all rows removed.`));
  console.log(dim('  Restore data from a backup or re-run your import scripts.'));
  return 0;
}
