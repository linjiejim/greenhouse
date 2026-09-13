/**
 * Automation run history (`listTaskRuns`).
 *
 * The spine is the `channel='task'` session — every run, including pre-Runtime
 * history and enqueue failures, leaves one — and the durable Runtime run is
 * joined on where it exists. The interesting rules: legacy sessions appear
 * with `run: null` instead of vanishing, manual triggers are told apart from
 * scheduled ones by source id, and scoping matches the rest of the task
 * center (own for members, any only for a super console actor).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider, ScheduledTaskRow, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';
import { listTaskRuns } from '../../apps/api/src/scheduler/task-center.js';

let db: DatabaseProvider;
let owner: UserRow;
let task: ScheduledTaskRow;

async function taskSession(taskId: number, title: string): Promise<string> {
  const session = await db.sessions.create(title, 'team', owner.id, undefined, 'task', undefined, {
    metadata: JSON.stringify({ task_id: taskId, task_name: title }),
  });
  return session.id;
}

describe('automation run history', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `auto-history-${Date.now()}-${Math.random()}@test.local` });
    task = await db.scheduledTasks.create({
      user_id: owner.id,
      name: 'History fixture',
      profile_id: 'team',
      task_prompt: 'Summarise the day for the history fixture.',
      schedule: '0 9 * * *',
      timezone: 'UTC',
      max_steps: 10,
      enabled: true,
      notify_webhook: null,
      notify_email: false,
      notify_wecom: false,
    });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('joins Runtime runs onto task sessions and keeps legacy sessions visible', async () => {
    const legacySessionId = await taskSession(task.id, '[History fixture] legacy');
    const scheduledSessionId = await taskSession(task.id, '[History fixture] scheduled');
    const manualSessionId = await taskSession(task.id, '[History fixture] manual');

    await db.runtime.createRun({
      kind: 'automation',
      owner_user_id: owner.id,
      initiated_by_user_id: owner.id,
      session_id: scheduledSessionId,
      source_kind: `scheduled_task:${task.id}`,
      source_id: 'scheduled:2026-08-14T01:00:00.000Z',
      input: { task_id: task.id },
    });
    const manualRun = await db.runtime.createRun({
      kind: 'automation',
      owner_user_id: owner.id,
      initiated_by_user_id: owner.id,
      session_id: manualSessionId,
      source_kind: `scheduled_task:${task.id}`,
      source_id: 'manual:00000000-0000-4000-8000-000000000001',
      input: { task_id: task.id },
    });

    const result = await listTaskRuns(db, { userId: owner.id, role: 'team', scope: 'own' }, task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bySession = new Map(result.entries.map((entry) => [entry.session_id, entry]));
    expect(bySession.get(legacySessionId)?.run).toBeNull();
    expect(bySession.get(scheduledSessionId)?.run).toMatchObject({ trigger: 'scheduled', status: 'queued' });
    expect(bySession.get(manualSessionId)?.run).toMatchObject({ id: manualRun.id, trigger: 'manual' });
  });

  it('does not leak another task history into the entries', async () => {
    const other = await db.scheduledTasks.create({
      user_id: owner.id,
      name: 'Other fixture',
      profile_id: 'team',
      task_prompt: 'A different automation entirely.',
      schedule: '0 10 * * *',
      timezone: 'UTC',
      max_steps: 10,
      enabled: true,
      notify_webhook: null,
      notify_email: false,
      notify_wecom: false,
    });
    const mine = await taskSession(task.id, '[History fixture] mine');
    const foreign = await taskSession(other.id, '[Other fixture] foreign');

    const result = await listTaskRuns(db, { userId: owner.id, role: 'team', scope: 'own' }, task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.entries.map((entry) => entry.session_id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(foreign);
  });

  it('scopes access like the rest of the task center', async () => {
    const outsider = await createInternalTestUser(db, {
      email: `auto-history-outsider-${Date.now()}-${Math.random()}@test.local`,
    });
    const superUser = await createInternalTestUser(db, {
      email: `auto-history-super-${Date.now()}-${Math.random()}@test.local`,
      role: 'super',
    });

    const denied = await listTaskRuns(db, { userId: outsider.id, role: 'team', scope: 'own' }, task.id);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('forbidden');

    // A super through the tools surface (scope 'own') is denied too…
    const superOwn = await listTaskRuns(db, { userId: superUser.id, role: 'super', scope: 'own' }, task.id);
    expect(superOwn.ok).toBe(false);

    // …and reaches it only through the admin console (scope 'any').
    const superAny = await listTaskRuns(db, { userId: superUser.id, role: 'super', scope: 'any' }, task.id);
    expect(superAny.ok).toBe(true);
  });
});
