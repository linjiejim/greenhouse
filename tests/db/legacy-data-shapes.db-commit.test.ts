/**
 * @db-commit-reason The 3.x → 4.0 upgrade runs on a whole database through the
 * real migration entrypoint; one rollback transaction cannot hold a bridge.
 *
 * Rows that 1.x wrote and a 3.x install carried verbatim come out of
 * `pnpm db:migrate` in the shapes 4.0 reads, and rows already in those shapes
 * are left alone.
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
import { parseTaskVariables } from '@greenhouse/types/tasks';
import { isRowId } from '@greenhouse/utils/id';
import { parseAutomationResultNotificationPayload } from '../../apps/api/src/scheduler/notify.js';

const root = resolve(import.meta.dirname, '../..');
const fixture = (name: string) => readFileSync(join(root, 'tests/fixtures', name), 'utf8');
const migration = readFileSync(join(root, 'packages/db/migrations/0001_drop_legacy_data_shapes.sql'), 'utf8');

const OUTBOX_ENVELOPE = {
  event_id: 'legacy-event',
  run_id: 'legacy-run-automation',
  seq: 1,
  type: 'run.succeeded',
  created_at: '2026-09-01T00:00:00.000Z',
};

const LEGACY_TASK = {
  id: 42,
  user_id: 'upgrade-user',
  name: 'Daily report',
  profile_id: 'team',
  task_prompt: 'Summarize today',
  schedule: '0 18 * * *',
  timezone: 'UTC',
  enabled: true,
  max_steps: 15,
  notify_webhook: 'https://hooks.example.test/daily',
  notify_email: true,
  notify_wecom: false,
  unattended_tools: '["memory"]',
};

const CURRENT_TASK = {
  id: '43',
  user_id: 'upgrade-user',
  name: 'Weekly report',
  profile_id: 'team',
  task_prompt: 'Summarize the week',
  schedule: '0 18 * * 5',
  timezone: 'UTC',
  enabled: true,
  max_steps: 15,
  notify: { webhook: null, email: false, wecom: true, feishu: false },
  unattended_tools: ['memory'],
};

const json = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;

/** Rows in 1.x shapes, each next to a row already in the 4.0 shape. */
const SEED = `
INSERT INTO notifications (id, user_id, kind, title, body, payload, dedupe_key) VALUES
  ('legacy-ntf', 'upgrade-user', 'runtime_completed', 'Daily report', 'All good',
   ${json({ schema: 1, type: 'automation_result', task_id: 42, task_name: 'Daily report', session_id: 'session-42', status: 'completed', summary: 'All good' })},
   'automation-result:42'),
  ('current-ntf', 'upgrade-user', 'runtime_completed', 'Weekly report', 'All good',
   ${json({ schema: 1, type: 'automation_result', task_id: '43', task_name: 'Weekly report', session_id: 'session-43', status: 'completed', summary: 'All good' })},
   'automation-result:43'),
  ('other-ntf', 'upgrade-user', 'system', 'Hello', 'Hello', ${json({ task_id: 7 })}, 'system:7');
INSERT INTO runs (id, kind, status, owner_user_id, initiated_by_user_id, root_run_id, source_kind, source_id, input) VALUES
  ('legacy-run-automation', 'automation', 'succeeded', 'upgrade-user', 'upgrade-user', 'legacy-run-automation',
   'scheduled_task:42', 'scheduled:2026-09-01T00:00:00.000Z',
   ${json({ schema: 1, task_id: 42, task: LEGACY_TASK, session_id: 'session-42', scheduled_for: '2026-09-01T00:00:00.000Z' })}),
  ('legacy-run-broken-tools', 'automation', 'succeeded', 'upgrade-user', 'upgrade-user', 'legacy-run-broken-tools',
   'scheduled_task:44', 'scheduled:2026-09-01T00:00:00.000Z',
   ${json({ schema: 1, task_id: '44', task: { ...CURRENT_TASK, id: '44', unattended_tools: 'not json' }, session_id: 'session-44', scheduled_for: '2026-09-01T00:00:00.000Z' })}),
  ('current-run-automation', 'automation', 'succeeded', 'upgrade-user', 'upgrade-user', 'current-run-automation',
   'scheduled_task:43', 'scheduled:2026-09-01T00:00:00.000Z',
   ${json({ schema: 1, task_id: '43', task: CURRENT_TASK, session_id: 'session-43', scheduled_for: '2026-09-01T00:00:00.000Z' })}),
  ('chat-run', 'chat', 'succeeded', 'upgrade-user', 'upgrade-user', 'chat-run', 'session', 'upgrade-session',
   ${json({ task_id: 9, task: { id: 9 } })});
INSERT INTO run_events (id, run_id, seq, type) VALUES
  ('legacy-event', 'legacy-run-automation', 1, 'run.succeeded'),
  ('broken-event', 'legacy-run-automation', 2, 'run.succeeded'),
  ('current-event', 'legacy-run-automation', 3, 'run.succeeded');
INSERT INTO run_outbox (id, event_id, topic, payload, available_at) VALUES
  ('legacy-outbox', 'legacy-event', 'runtime', to_jsonb(${json(OUTBOX_ENVELOPE)}::text), now()),
  ('broken-outbox', 'broken-event', 'runtime', to_jsonb('{not json'::text), now()),
  ('current-outbox', 'current-event', 'runtime', ${json(OUTBOX_ENVELOPE)}, now());
INSERT INTO run_profiles (id, slug, user_id, name, tools, system_prompt) VALUES
  ('legacy-agent', 'legacy-agent', 'upgrade-user', 'Legacy agent',
   ${json(['session_history', 'files_query', 'session_query', 'files_query'])}, 'Help.'),
  ('current-agent', 'current-agent', 'upgrade-user', 'Current agent', ${json(['session_query', 'files_query'])}, 'Help.');
INSERT INTO prompts (id, user_id, title, content, variables, expected_tools) VALUES
  ('legacy-prompt', 'upgrade-user', 'Monthly', 'Report {{month}}',
   to_jsonb('[{"key":"month","label":"Month"}]'::text), to_jsonb('["files_query"]'::text)),
  ('broken-prompt', 'upgrade-user', 'Broken', 'Report', to_jsonb('not json'::text), to_jsonb('{"a":1}'::text)),
  ('current-prompt', 'upgrade-user', 'Current', 'Report {{month}}',
   ${json([{ key: 'month', label: 'Month' }])}, ${json(['files_query'])});
`;

async function withDatabase<T>(run: (url: string) => Promise<T>): Promise<T> {
  const name = `gh4_shapes_${randomBytes(4).toString('hex')}_test`;
  const url = await recreateDatabase(TEST_DATABASE_URL, name);
  try {
    return await run(url);
  } finally {
    await dropDatabase(TEST_DATABASE_URL, name);
  }
}

async function value(url: string, query: string): Promise<unknown> {
  const [row] = await queryRows(url, query);
  return row ? Object.values(row)[0] : undefined;
}

async function snapshot(url: string) {
  return queryRows(
    url,
    `SELECT 'notifications' AS t, id, payload AS v FROM notifications
     UNION ALL SELECT 'runs', id, input FROM runs
     UNION ALL SELECT 'run_outbox', id, payload FROM run_outbox
     UNION ALL SELECT 'run_profiles', id, tools FROM run_profiles
     UNION ALL SELECT 'prompts', id, jsonb_build_array(variables, expected_tools) FROM prompts
     ORDER BY 1, 2`,
  );
}

describe('legacy data shapes on a bridged 3.x install', () => {
  it('come out of db:migrate in the shapes 4.0 reads', async () => {
    await withDatabase(async (url) => {
      await buildV3Database(url);
      await queryRows(url, fixture('plugin-upgrade-v3.sql'));
      await queryRows(url, SEED);
      const untouched = await queryRows(
        url,
        `SELECT id, payload AS v FROM notifications WHERE id IN ('current-ntf', 'other-ntf')
         UNION ALL SELECT id, input FROM runs WHERE id IN ('current-run-automation', 'chat-run')
         UNION ALL SELECT id, payload FROM run_outbox WHERE id IN ('current-outbox', 'broken-outbox')
         UNION ALL SELECT id, tools FROM run_profiles WHERE id = 'current-agent'
         UNION ALL SELECT id, jsonb_build_array(variables, expected_tools) FROM prompts WHERE id = 'current-prompt'
         ORDER BY 1`,
      );

      const result = await applyAllMigrations(url);
      expect(result.generation.kind).toBe('v3');

      // Notifications: the delivery transports' reader accepts the carried payload.
      const notification = parseAutomationResultNotificationPayload(
        await value(url, `SELECT payload FROM notifications WHERE id = 'legacy-ntf'`),
      );
      expect(notification?.task_id).toBe('42');

      // Outbox: the envelope is a JSON object; unparseable text stays for the worker to dead-letter.
      expect(await value(url, `SELECT payload FROM run_outbox WHERE id = 'legacy-outbox'`)).toEqual(OUTBOX_ENVELOPE);

      // Automation runs: the snapshot has the current row shape.
      const input = (await value(url, `SELECT input FROM runs WHERE id = 'legacy-run-automation'`)) as {
        task_id: unknown;
        task: Record<string, unknown>;
      };
      expect(isRowId(input.task_id)).toBe(true);
      expect(input.task_id).toBe('42');
      expect(input.task).toEqual({
        id: '42',
        user_id: 'upgrade-user',
        name: 'Daily report',
        profile_id: 'team',
        task_prompt: 'Summarize today',
        schedule: '0 18 * * *',
        timezone: 'UTC',
        enabled: true,
        max_steps: 15,
        notify: { webhook: 'https://hooks.example.test/daily', email: true, wecom: false, feishu: false },
        unattended_tools: ['memory'],
      });
      expect(
        await value(url, `SELECT input #> '{task,unattended_tools}' FROM runs WHERE id = 'legacy-run-broken-tools'`),
      ).toEqual([]);

      // Custom Agents: the retired tool id is rewritten to its successor, listed once.
      expect(await value(url, `SELECT tools FROM run_profiles WHERE id = 'legacy-agent'`)).toEqual([
        'session_query',
        'files_query',
        'files_query',
      ]);

      // Prompts: the stored lists are arrays the readers understand.
      const [prompt] = await queryRows(url, `SELECT variables, expected_tools FROM prompts WHERE id = 'legacy-prompt'`);
      expect(parseTaskVariables(prompt!.variables)).toEqual([{ key: 'month', label: 'Month' }]);
      expect(prompt!.expected_tools).toEqual(['files_query']);
      expect(await queryRows(url, `SELECT variables, expected_tools FROM prompts WHERE id = 'broken-prompt'`)).toEqual([
        { variables: [], expected_tools: [] },
      ]);

      // Rows already in the 4.0 shapes, and rows the readers never see, are unchanged.
      expect(
        await queryRows(
          url,
          `SELECT id, payload AS v FROM notifications WHERE id IN ('current-ntf', 'other-ntf')
           UNION ALL SELECT id, input FROM runs WHERE id IN ('current-run-automation', 'chat-run')
           UNION ALL SELECT id, payload FROM run_outbox WHERE id IN ('current-outbox', 'broken-outbox')
           UNION ALL SELECT id, tools FROM run_profiles WHERE id = 'current-agent'
           UNION ALL SELECT id, jsonb_build_array(variables, expected_tools) FROM prompts WHERE id = 'current-prompt'
           ORDER BY 1`,
        ),
      ).toEqual(untouched);

      // Running the statements again changes nothing.
      const migrated = await snapshot(url);
      await queryRows(url, migration);
      expect(await snapshot(url)).toEqual(migrated);
    });
  }, 60_000);
});
