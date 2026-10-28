/**
 * @db-commit-reason The 3.x → 4.0 upgrade runs on a whole database through the
 * real migration entrypoint; one rollback transaction cannot hold a bridge.
 *
 * Retired plugin tool ids that custom Agents and saved prompts stored come out
 * of `pnpm db:migrate` as their successors, listed once; lists without a
 * retired id and Automation grants are left alone; a rerun changes nothing.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyAllMigrations } from '@greenhouse/db';
import {
  TEST_DATABASE_URL,
  buildV3Database,
  dropDatabase,
  queryRows,
  recreateDatabase,
} from '@greenhouse/db/test-config';

const root = resolve(import.meta.dirname, '../..');
const fixture = (name: string) => readFileSync(join(root, 'tests/fixtures', name), 'utf8');
const migration = readFileSync(join(root, 'packages/db/migrations/0004_retired_tool_aliases.sql'), 'utf8');

const json = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;

const AGENTS: Record<string, { stored: string[]; migrated: string[] }> = {
  'all-aliases': {
    stored: ['team_knowledge', 'files_query', 'personal_knowledge', 'knowledge_query', 'project_manager'],
    migrated: ['knowledge_query', 'files_query', 'project_query', 'project_mutation'],
  },
  'successor-first': {
    stored: ['project_query', 'project_manager', 'example_notes_legacy'],
    migrated: ['project_query', 'project_mutation', 'example_notes_query'],
  },
  'other-duplicates': {
    // Only successors are de-duplicated; the rest of the list is as the author left it.
    stored: ['personal_knowledge', 'files_query', 'files_query'],
    migrated: ['knowledge_query', 'files_query', 'files_query'],
  },
  'current-agent': {
    stored: ['knowledge_query', 'files_query', 'files_query'],
    migrated: ['knowledge_query', 'files_query', 'files_query'],
  },
  'empty-agent': { stored: [], migrated: [] },
};

const SEED = `
INSERT INTO run_profiles (id, slug, user_id, name, system_prompt, tools) VALUES
  ${Object.entries(AGENTS)
    .map(([id, { stored }]) => `('${id}', '${id}', 'upgrade-user', '${id}', 'Help.', ${json(stored)})`)
    .join(',\n  ')};
INSERT INTO prompts (id, user_id, title, content, expected_tools) VALUES
  ('legacy-prompt', 'upgrade-user', 'Legacy', 'Go', ${json(['team_knowledge', 'project_manager'])}),
  ('current-prompt', 'upgrade-user', 'Current', 'Go', ${json(['knowledge_query'])});
INSERT INTO automations (id, user_id, name, task_prompt, schedule, unattended_tools) VALUES
  ('grant-auto', 'upgrade-user', 'Grant', 'Go', '0 9 * * *', ${json(['project_manager', 'team_knowledge'])});
`;

async function withDatabase<T>(run: (url: string) => Promise<T>): Promise<T> {
  const name = `gh4_aliases_${randomBytes(4).toString('hex')}_test`;
  const url = await recreateDatabase(TEST_DATABASE_URL, name);
  try {
    return await run(url);
  } finally {
    await dropDatabase(TEST_DATABASE_URL, name);
  }
}

async function column(url: string, table: string, name: string): Promise<Record<string, unknown>> {
  const rows = await queryRows(url, `SELECT id, ${name} AS v FROM ${table} ORDER BY id`);
  return Object.fromEntries(rows.map((row) => [row.id, row.v]));
}

async function snapshot(url: string) {
  return {
    agents: await column(url, 'run_profiles', 'tools'),
    prompts: await column(url, 'prompts', 'expected_tools'),
    automations: await column(url, 'automations', 'unattended_tools'),
  };
}

describe('retired plugin tool ids on a bridged 3.x install', () => {
  it('come out of db:migrate as their successors, and a rerun changes nothing', async () => {
    await withDatabase(async (url) => {
      await buildV3Database(url);
      await queryRows(url, fixture('plugin-upgrade-v3.sql'));
      await queryRows(url, SEED);

      const result = await applyAllMigrations(url);
      expect(result.generation.kind).toBe('v3');

      const migrated = await snapshot(url);
      expect(migrated.agents).toEqual(
        Object.fromEntries(Object.entries(AGENTS).map(([id, { migrated: tools }]) => [id, tools])),
      );
      expect(migrated.prompts).toEqual({
        'current-prompt': ['knowledge_query'],
        'legacy-prompt': ['knowledge_query', 'project_query', 'project_mutation'],
      });
      // An explicit unattended grant is never widened onto a write successor.
      expect(migrated.automations['grant-auto']).toEqual(['project_manager', 'team_knowledge']);

      await queryRows(url, migration);
      expect(await snapshot(url)).toEqual(migrated);
    });
  }, 60_000);
});
