/**
 * `admin seed` — load the example dataset in `data/examples/`.
 *
 *   pnpm cli seed              # empty DB: load. non-empty DB: refuse & explain.
 *   pnpm cli seed --reset      # wipe ALL data first, then load (double-confirm)
 *   pnpm cli seed --keep       # load on top of existing rows (may clash)
 *   pnpm cli seed --password p # override the shared demo password (default: greenhouse)
 *   pnpm cli seed --reset --yes  # skip the confirmation (scripts/CI)
 *
 * Each file in `data/examples/` is named after a table and holds JSONL — one JSON
 * object per line, loaded in a fixed FK-safe order (LOAD_ORDER). Rows may use
 * native arrays/objects for JSON-as-text columns; they are stringified on the way
 * in. `users.json` rows carry a plaintext `password`; it is scrypt-hashed here so
 * every demo account shares one known password. Runs through the same provider
 * the app uses (`resetSchema` + `executeRaw`), so it stays in lockstep with the
 * migration chain — run `npx drizzle-kit migrate` first on a fresh database.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import chalk from 'chalk';
import { DATA_DIR } from '../../paths.js';
import { hashPassword } from '../../auth/password.js';
import { markdownToTiptapJson } from '@greenhouse/knowledge-editor/markdown';
import { PRODUCT_NAME } from '@greenhouse/utils/brand';
import { openDb, parseFlags, flagStr, flagBool, confirmExact, heading, dim, dbName } from './shared.js';

const EXAMPLES_DIR = resolve(DATA_DIR, 'examples');

/**
 * FK-safe load order. Parents before children; self-referential tables
 * (`tasks`, `sessions`) rely on rows being authored parent-first within the file.
 * A table listed here whose file is missing is simply skipped.
 */
const LOAD_ORDER = [
  'users',
  'user_profiles',
  'user_groups',
  'group_members',
  'knowledge_base',
  'knowledge_base_versions',
  'knowledge_base_shares',
  'projects',
  'project_members',
  'tasks',
  'task_comments',
  'project_activities',
  'sessions',
  'messages',
  'session_groups',
  'session_group_members',
  'session_tags',
  'session_tag_links',
  'session_shares',
  'session_share_reads',
  'user_prompts',
  'user_memories',
  'scheduled_tasks',
  'feature_requests',
  'custom_profiles',
  'user_features',
];

/** (table, column) pairs that are real jsonb — pass a cast JSON literal, not text. */
const JSONB_COLUMNS = new Set(['custom_profiles.data']);

type Row = Record<string, unknown>;

function readJsonl(file: string): Row[] {
  const raw = readFileSync(file, 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .map((l, i) => {
      try {
        return JSON.parse(l) as Row;
      } catch (err) {
        throw new Error(`${file}: invalid JSON on line ${i + 1}: ${(err as Error).message}`);
      }
    });
}

/** Build one parameterized INSERT via the provider's raw-SQL escape hatch. */
function buildInsert(table: string, row: Row) {
  const cols = Object.keys(row);
  const idents = cols.map((c) => sql.identifier(c));
  const values = cols.map((c) => {
    const v = row[c];
    if (JSONB_COLUMNS.has(`${table}.${c}`)) {
      return sql`${JSON.stringify(v)}::jsonb`;
    }
    // JSON-as-text columns are authored as native arrays/objects — stringify them.
    if (v !== null && typeof v === 'object') {
      return sql`${JSON.stringify(v)}`;
    }
    return sql`${v}`;
  });
  return sql`INSERT INTO ${sql.identifier(table)} (${sql.join(idents, sql`, `)}) VALUES (${sql.join(values, sql`, `)})`;
}

export async function run(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const keep = flagBool(flags, 'keep');
  const reset = flagBool(flags, 'reset');
  const yes = flagBool(flags, 'yes');
  const demoPassword = flagStr(flags, 'password') ?? 'greenhouse';

  if (!existsSync(EXAMPLES_DIR)) {
    console.error(chalk.red(`No example dataset found at ${EXAMPLES_DIR}`));
    return 1;
  }

  const db = await openDb();
  await db.initSchema(); // fail fast if the schema hasn't been migrated

  // Guard: a non-empty database needs an explicit strategy.
  const userCount = await db.users.count();
  if (userCount > 0 && !keep && !reset) {
    console.log(chalk.yellow(`⚠ Database "${dbName()}" already has data (${userCount} user(s)).`));
    console.log('  Re-run with one of:');
    console.log(`    ${chalk.bold('--reset')}  wipe ALL data first, then seed  ${chalk.red('(destructive)')}`);
    console.log(`    ${chalk.bold('--keep')}   load example rows on top ${dim('(may hit unique clashes)')}`);
    return 1;
  }

  if (reset && userCount > 0 && !yes) {
    console.log(
      chalk.red.bold(`\n⚠ This PERMANENTLY DELETES all data in "${dbName()}" (${userCount} users) before seeding.`),
    );
    const ok = await confirmExact(`Type the database name "${chalk.bold(dbName())}" to confirm: `, dbName());
    if (!ok) {
      console.log('Cancelled.');
      return 1;
    }
  }

  console.log(heading(`${PRODUCT_NAME} — seeding from ${EXAMPLES_DIR}`));
  const passwordHash = await hashPassword(demoPassword);

  if (!keep) {
    console.log(dim('• wiping existing rows (resetSchema)…'));
    await db.resetSchema();
  }

  let totalRows = 0;
  for (const table of LOAD_ORDER) {
    const file = resolve(EXAMPLES_DIR, `${table}.json`);
    if (!existsSync(file)) continue;

    const rows = readJsonl(file);
    if (rows.length === 0) {
      console.log(dim(`• ${table}: (empty)`));
      continue;
    }

    let hasNumericId = false;
    for (const row of rows) {
      // users carry a plaintext `password`; convert to the stored hash.
      if (table === 'users' && 'password' in row) {
        row.password_hash = passwordHash;
        delete row.password;
      }
      // KB docs are authored as canonical Markdown only; derive the Tiptap
      // editor state the same way the knowledge_mutation tool does at runtime.
      if (table === 'knowledge_base' && !row.content_json && typeof row.content === 'string') {
        row.content_json = markdownToTiptapJson(row.content);
      }
      if (typeof row.id === 'number') hasNumericId = true;
      await db.executeRaw(buildInsert(table, row));
    }

    // Realign the serial sequence so future app inserts don't collide with ours.
    if (hasNumericId) {
      await db.executeRaw(
        sql.raw(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT MAX(id) FROM ${table}), true)`),
      );
    }

    totalRows += rows.length;
    console.log(`• ${table}: ${rows.length} rows`);
  }

  console.log(chalk.green(`\n✓ seeded ${totalRows} rows across ${LOAD_ORDER.length} tables.`));
  console.log(dim(`  Demo login password for every seeded user: "${demoPassword}"`));
  console.log(dim('  Try: super admin → maya@greenhouse.example'));
  return 0;
}
