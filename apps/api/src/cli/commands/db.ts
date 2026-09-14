/**
 * `admin db` — database overview and the destructive reset.
 *
 *   pnpm cli stats          # row counts across core tables + health
 *   pnpm cli db reset       # TRUNCATE every table (type the db name to confirm)
 *   pnpm cli db baseline    # adopt an existing database: record the migration
 *                           # chain (core + enabled extensions) as applied
 *                           # (--dry-run to preview, --yes for automation,
 *                           #  --through to stop short of the end of a chain,
 *                           #  --force to record tables the database lacks)
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
/**
 * `--through` — the last entry of a chain the database already reflects.
 *
 * Comma-separated; a bare value names a core tag, `<extension>/<file>` names an
 * extension file. Anything after it stays pending and applies normally, which
 * is how an adopted database gets the migration written specifically to bring
 * it the rest of the way.
 */
function parseThrough(raw: string | undefined): { core?: string; extensions: Record<string, string> } {
  const result: { core?: string; extensions: Record<string, string> } = { extensions: {} };
  for (const spec of (raw ?? '').split(',').map((s) => s.trim())) {
    if (!spec) continue;
    const slash = spec.indexOf('/');
    if (slash === -1) result.core = spec;
    else result.extensions[spec.slice(0, slash)] = spec.slice(slash + 1);
  }
  return result;
}

async function baseline(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const dryRun = flagBool(flags, 'dry-run');
  const through = parseThrough(typeof flags.through === 'string' ? flags.through : undefined);
  const db = await openDb();

  const allCore = readCoreMigrations(DRIZZLE_DIR);
  let core = allCore;
  if (through.core !== undefined) {
    const index = allCore.findIndex((file) => file.tag === through.core);
    if (index === -1) {
      console.error(chalk.red(`--through: no core migration tagged "${through.core}"`));
      return 1;
    }
    core = allCore.slice(0, index + 1);
  }
  const coreState = await db.coreMigrationBaseline.status(core);
  const corePending = coreState.filter((entry) => !entry.recorded);

  const sources = extensionMigrationSources();
  for (const extensionId of Object.keys(through.extensions)) {
    if (!sources.some((source) => source.extensionId === extensionId)) {
      console.error(chalk.red(`--through: extension "${extensionId}" is not enabled`));
      return 1;
    }
  }
  const extensionState = await db.extensionMigrations.status(sources);
  // What baseline would record: pending files, minus anything past a --through.
  const pastThrough = new Set<string>();
  const seenThrough = new Set<string>();
  for (const entry of extensionState) {
    const key = `${entry.extensionId}/${entry.name}`;
    if (seenThrough.has(entry.extensionId)) pastThrough.add(key);
    if (through.extensions[entry.extensionId] === entry.name) seenThrough.add(entry.extensionId);
  }
  const extensionPending = extensionState.filter(
    (entry) => !entry.applied && !pastThrough.has(`${entry.extensionId}/${entry.name}`),
  );
  const leftPending = extensionState.filter(
    (entry) => !entry.applied && pastThrough.has(`${entry.extensionId}/${entry.name}`),
  );
  const drifted = extensionState.filter((entry) => entry.drifted);

  heading('Migration baseline');
  console.log(
    kvBlock([
      ['Database', redactDbUrl()],
      ['Core chain', `${core.length} of ${allCore.length} file(s), ${corePending.length} to record`],
      ['Extensions', sources.length === 0 ? dim('none enabled') : sources.map((s) => s.extensionId).join(', ')],
      ['Extension chain', `${extensionState.length} file(s), ${extensionPending.length} to record`],
    ]),
  );
  if (corePending.length > 0) console.log(dim(`  core:      ${corePending.map((e) => e.tag).join(', ')}`));
  if (extensionPending.length > 0) {
    console.log(dim(`  extension: ${extensionPending.map((e) => `${e.extensionId}/${e.name}`).join(', ')}`));
  }
  if (leftPending.length > 0) {
    console.log(dim(`  left to apply at boot: ${leftPending.map((e) => `${e.extensionId}/${e.name}`).join(', ')}`));
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
  // Baseline asserts the database already has what these files would create.
  // Recording a migration whose tables are absent is the quiet way to end up
  // with a schema that boots and then fails on the first query, so check.
  // Net across the chain in order: a table created in one file and dropped in a
  // later one is not something the database should still have.
  const expected = new Set<string>();
  for (const entry of [...corePending, ...extensionPending]) {
    for (const t of entry.createsTables) expected.add(t);
    for (const t of entry.dropsTables) expected.delete(t);
  }
  const absent: string[] = [];
  for (const name of [...expected].sort()) {
    const rows = (await db.executeRaw(sql`SELECT to_regclass(${'public.' + name}) IS NOT NULL AS present`)) as Array<{
      present: boolean;
    }>;
    if (!rows[0]?.present) absent.push(name);
  }
  if (absent.length > 0) {
    console.error(chalk.red(`\n${absent.length} table(s) these migrations create are NOT in this database:`));
    console.error(`  ${absent.join(', ')}`);
    console.error(
      dim(
        'Recording them as applied would leave the schema permanently short of them.\n' +
          'Use --through to baseline only the part the database really has, and let the rest apply;\n' +
          'or --force if you know these tables are meant to be absent.',
      ),
    );
    if (!flagBool(flags, 'force')) return 1;
    console.log(chalk.yellow('\n--force: recording them anyway.'));
  }

  if (dryRun) {
    console.log(dim('\n--dry-run: nothing written.'));
    return 0;
  }
  if (
    !flagBool(flags, 'yes') &&
    !(await confirmExact(`Type the database name "${chalk.bold(dbName())}" to record these as applied: `, dbName()))
  ) {
    console.log(dim('Aborted.'));
    return 1;
  }

  const coreResult = await db.coreMigrationBaseline.apply(core);
  const extensionResult = await db.extensionMigrations.baseline(sources, { through: through.extensions });
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
