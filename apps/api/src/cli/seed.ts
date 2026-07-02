/**
 * CLI: Seed the database with the example dataset in `data/examples/`.
 *
 * Usage:
 *   pnpm seed                 # wipe + load the full example dataset
 *   pnpm seed --keep          # load without wiping first (may hit unique clashes)
 *   pnpm seed --password foo  # override the shared demo password (default: greenhouse)
 *
 * Each file in `data/examples/` is named after a table and holds JSONL — one JSON
 * object per line. Files load in a fixed FK-safe order (see LOAD_ORDER). Rows may
 * use native arrays/objects for JSON-as-text columns; they are stringified on the
 * way in. `users.json` rows carry a plaintext `password` (not `password_hash`);
 * it is scrypt-hashed here so every demo account shares one known password.
 *
 * The importer talks to Postgres through the same `@greenhouse/db` provider the
 * app uses (`resetSchema` + `executeRaw`), so it stays in lockstep with the
 * migration chain — run `npx drizzle-kit migrate` first on a fresh database.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { DATA_DIR, ENV_FILE } from '../paths.js';

config({ path: ENV_FILE });

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse';

import { initDatabase } from '@greenhouse/db';
import { hashPassword } from '../auth/password.js';
import { markdownToTiptapJson } from '@greenhouse/knowledge-editor/markdown';
import { PRODUCT_NAME } from '@greenhouse/utils/brand';

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

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes('--keep');
  const pwIdx = args.indexOf('--password');
  const demoPassword = pwIdx >= 0 ? (args[pwIdx + 1] ?? 'greenhouse') : 'greenhouse';

  if (!existsSync(EXAMPLES_DIR)) {
    console.error(`No example dataset found at ${EXAMPLES_DIR}`);
    process.exit(1);
  }

  console.log(`\n🌱 ${PRODUCT_NAME} — seeding from ${EXAMPLES_DIR}\n`);

  const db = await initDatabase({ type: 'pg', pgConnectionString: DATABASE_URL });
  // Fail fast if the schema hasn't been migrated yet.
  await db.initSchema();

  const passwordHash = await hashPassword(demoPassword);

  if (!keep) {
    console.log('• wiping existing rows (resetSchema)…');
    await db.resetSchema();
  }

  let totalRows = 0;
  for (const table of LOAD_ORDER) {
    const file = resolve(EXAMPLES_DIR, `${table}.json`);
    if (!existsSync(file)) continue;

    const rows = readJsonl(file);
    if (rows.length === 0) {
      console.log(`• ${table}: (empty)`);
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

    // Realign the serial sequence so future app inserts don't collide with our
    // explicit ids.
    if (hasNumericId) {
      await db.executeRaw(
        sql.raw(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT MAX(id) FROM ${table}), true)`),
      );
    }

    totalRows += rows.length;
    console.log(`• ${table}: ${rows.length} rows`);
  }

  console.log(`\n✅ seeded ${totalRows} rows across ${LOAD_ORDER.length} tables.`);
  console.log(`   Demo login password for every seeded user: "${demoPassword}"`);
  console.log(`   Try: super admin → maya@greenhouse.example\n`);

  await db.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
