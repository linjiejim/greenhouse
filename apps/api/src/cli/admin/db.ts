/**
 * `admin db` — database overview and the destructive reset.
 *
 *   pnpm admin stats          # row counts across core tables + health
 *   pnpm admin db reset       # TRUNCATE every table (type the db name to confirm)
 */

import chalk from 'chalk';
import { sql } from 'drizzle-orm';
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
  console.error(chalk.red(`Unknown db subcommand: ${sub} (expected: stats | reset)`));
  return 1;
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
  console.log(dim('  Re-seed with: pnpm admin seed'));
  return 0;
}
