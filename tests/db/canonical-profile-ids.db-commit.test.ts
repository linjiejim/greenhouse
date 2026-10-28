/**
 * @db-commit-reason The 3.x → 4.0 upgrade runs on a whole database through the
 * real migration entrypoint; one rollback transaction cannot hold a bridge.
 *
 * Retired profile ids stored by 1.x–3.x come out of `pnpm db:migrate` as their
 * canonical successors (sprouty / desktop), current ids and custom references
 * are left alone, and running the statements again changes nothing.
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
import { normalizeProfileId } from '../../apps/api/src/profiles/profile.js';

const root = resolve(import.meta.dirname, '../..');
const fixture = (name: string) => readFileSync(join(root, 'tests/fixtures', name), 'utf8');
const migration = readFileSync(join(root, 'packages/db/migrations/0003_canonical_profile_ids.sql'), 'utf8');

/** Every retired id the API edge still maps; the migration must rewrite the same set. */
const RETIRED = [
  'sprouty-quick',
  'sprouty-deep',
  'sprouty-k3',
  'sprouty-workflows',
  'workflow-planner',
  'sprouty-agents',
  'sprouty-mission',
  'eval-judge',
  'team',
  'default',
  'researcher',
  'writer',
  'project-assistant',
  'cs-quality',
  'ops-analyst',
  'cc-analyzer',
  'crm',
  'local-dev',
  'local-pi',
];
const CURRENT = ['sprouty', 'desktop', 'custom:rpf_1@2', 'system'];

const json = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
const list = (ids: string[], row: (id: string, i: number) => string) => ids.map(row).join(',\n  ');
const NOTIFY = { webhook: null, email: false, wecom: false, feishu: false };
const task = (profileId: string) => ({
  id: 't',
  user_id: 'upgrade-user',
  name: 'Daily',
  profile_id: profileId,
  notify: NOTIFY,
});

const SEED = `
INSERT INTO conversations (id, user_id, profile_id) VALUES
  ${list([...RETIRED, ...CURRENT], (id, i) => `('c${i}', 'upgrade-user', '${id}')`)};
INSERT INTO automations (id, user_id, name, profile_id, task_prompt, schedule) VALUES
  ${list([...RETIRED, ...CURRENT], (id, i) => `('a${i}', 'upgrade-user', 'Task', '${id}', 'Go', '0 9 * * *')`)};
INSERT INTO usage_events (id, kind, profile_id) VALUES
  ${list([...RETIRED, ...CURRENT], (id, i) => `('u${i}', 'model', '${id}')`)},
  ('u-null', 'model', NULL);
INSERT INTO run_profiles (id, slug, user_id, name, system_prompt, base_profile_id) VALUES
  ('legacy-base', 'legacy-base', 'upgrade-user', 'Legacy base', 'Help.', 'team'),
  ('desktop-base', 'desktop-base', 'upgrade-user', 'Desktop base', 'Help.', 'local-dev'),
  ('current-base', 'current-base', 'upgrade-user', 'Current base', 'Help.', 'sprouty');
INSERT INTO runs (id, kind, status, owner_user_id, initiated_by_user_id, root_run_id, source_kind, source_id, input) VALUES
  ('legacy-auto', 'automation', 'succeeded', 'upgrade-user', 'upgrade-user', 'legacy-auto', 'scheduled_task:t', 's1',
   ${json({ task_id: 't', task: task('team'), session_id: 'c8' })}),
  ('current-auto', 'automation', 'succeeded', 'upgrade-user', 'upgrade-user', 'current-auto', 'scheduled_task:t', 's2',
   ${json({ task_id: 't', task: task('custom:rpf_1@2'), session_id: 'c21' })}),
  ('legacy-chat', 'chat', 'succeeded', 'upgrade-user', 'upgrade-user', 'legacy-chat', 'chat_turn', 'm1',
   ${json({ profile_id: 'sprouty-quick' })}),
  ('chat-task-key', 'chat', 'succeeded', 'upgrade-user', 'upgrade-user', 'chat-task-key', 'chat_turn', 'm2',
   ${json({ task: { profile_id: 'team' } })});
INSERT INTO run_steps (id, run_id, step_key, kind, input) VALUES
  ('legacy-step', 'legacy-auto', 'agent', 'automation_agent_turn', ${json({ task_id: 't', profile_id: 'team' })}),
  ('desktop-step', 'legacy-chat', 'chat_turn', 'chat_turn', ${json({ profile_id: 'local-pi' })}),
  ('current-step', 'current-auto', 'agent', 'automation_agent_turn', ${json({ task_id: 't', profile_id: 'custom:rpf_1@2' })});
`;

async function withDatabase<T>(run: (url: string) => Promise<T>): Promise<T> {
  const name = `gh4_profiles_${randomBytes(4).toString('hex')}_test`;
  const url = await recreateDatabase(TEST_DATABASE_URL, name);
  try {
    return await run(url);
  } finally {
    await dropDatabase(TEST_DATABASE_URL, name);
  }
}

async function ids(url: string, table: string, column: string): Promise<Record<string, unknown>> {
  const rows = await queryRows(url, `SELECT id, ${column} AS v FROM ${table} ORDER BY id`);
  return Object.fromEntries(rows.map((row) => [row.id, row.v]));
}

async function snapshot(url: string) {
  return queryRows(
    url,
    `SELECT 'conversations' AS t, id, to_jsonb(profile_id) AS v FROM conversations
     UNION ALL SELECT 'automations', id, to_jsonb(profile_id) FROM automations
     UNION ALL SELECT 'usage_events', id, to_jsonb(profile_id) FROM usage_events
     UNION ALL SELECT 'run_profiles', id, to_jsonb(base_profile_id) FROM run_profiles
     UNION ALL SELECT 'runs', id, input FROM runs
     UNION ALL SELECT 'run_steps', id, input FROM run_steps
     ORDER BY 1, 2`,
  );
}

describe('stored profile ids on a bridged 3.x install', () => {
  it('the retired list is exactly what the API edge still maps', () => {
    for (const id of RETIRED) expect(normalizeProfileId(id)).not.toBe(id);
    for (const id of CURRENT) expect(normalizeProfileId(id)).toBe(id);
  });

  it('come out of db:migrate canonical, and a rerun changes nothing', async () => {
    await withDatabase(async (url) => {
      await buildV3Database(url);
      await queryRows(url, fixture('plugin-upgrade-v3.sql'));
      await queryRows(url, SEED);

      const result = await applyAllMigrations(url);
      expect(result.generation.kind).toBe('v3');

      const expected = (prefix: string) =>
        Object.fromEntries(
          [...RETIRED, ...CURRENT].map((id, i) => [
            `${prefix}${i}`,
            RETIRED.includes(id) ? normalizeProfileId(id) : id,
          ]),
        );
      const conversations = await ids(url, 'conversations', 'profile_id');
      expect(Object.fromEntries(Object.entries(conversations).filter(([id]) => /^c\d+$/.test(id)))).toEqual(
        expected('c'),
      );
      expect(await ids(url, 'automations', 'profile_id')).toEqual(expected('a'));
      expect(await ids(url, 'usage_events', 'profile_id')).toEqual({ ...expected('u'), 'u-null': null });
      expect(await ids(url, 'run_profiles', 'base_profile_id')).toEqual({
        'current-base': 'sprouty',
        'desktop-base': 'sprouty',
        'legacy-base': 'sprouty',
      });
      expect(await ids(url, 'runs', 'input')).toEqual({
        'legacy-auto': { task_id: 't', task: task('sprouty'), session_id: 'c8' },
        'current-auto': { task_id: 't', task: task('custom:rpf_1@2'), session_id: 'c21' },
        'legacy-chat': { profile_id: 'sprouty' },
        // Only automation snapshots carry a task copy.
        'chat-task-key': { task: { profile_id: 'team' } },
      });
      expect(await ids(url, 'run_steps', 'input')).toEqual({
        'legacy-step': { task_id: 't', profile_id: 'sprouty' },
        'desktop-step': { profile_id: 'desktop' },
        'current-step': { task_id: 't', profile_id: 'custom:rpf_1@2' },
      });

      // New rows default to the canonical id.
      await queryRows(url, `INSERT INTO conversations (id, user_id) VALUES ('fresh', 'upgrade-user')`);
      expect((await ids(url, 'conversations', 'profile_id')).fresh).toBe('sprouty');

      const migrated = await snapshot(url);
      await queryRows(url, migration);
      expect(await snapshot(url)).toEqual(migrated);
    });
  }, 60_000);
});
