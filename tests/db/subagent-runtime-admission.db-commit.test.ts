/**
 * Subagent Runtime cross-connection admission and cancellation races.
 *
 * @db-commit-reason Session/admission row locks and a heartbeat racing a
 * cancellation poll require independently committed PostgreSQL connections;
 * a rollback-wrapped transaction cannot expose those ordering guarantees.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { cleanupRuntimeTestRun, TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import {
  createSubagentRuntimeDriver,
  requestSubagentRuntimeCancellation,
} from '../../apps/api/src/runtime/subagent-driver.js';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
const createdRunIds: string[] = [];
const createdSessionIds: string[] = [];
const createdUserIds: string[] = [];

/** Committed fixtures outlive this file, so every row it commits is cleaned up by id. */
async function seedUser(email: string) {
  const user = await createInternalTestUser(db, { email });
  createdUserIds.push(user.id);
  return user;
}

describe('Subagent Runtime database admission', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    for (const runId of createdRunIds.splice(0)) await cleanupRuntimeTestRun(db, runId);
    for (const sessionId of createdSessionIds.splice(0)) await db.sessions.delete(sessionId);
    for (const userId of createdUserIds.splice(0)) await db.users.delete(userId);
    await db.close();
    _resetProvider();
  });

  it('serializes concurrent child creation and admits at most five active Runs per parent', async () => {
    const user = await seedUser(`subagent-admission-${randomUUID()}@test.local`);
    const parent = await db.sessions.create('Concurrent Subagent parent', 'team', user.id, undefined, 'web');
    createdSessionIds.push(parent.id);
    const childSessionIds = Array.from({ length: 6 }, () => randomUUID());
    const attempts = await Promise.allSettled(
      childSessionIds.map(async (childSessionId) => {
        const admitted = await db.runtime.admitSubagent({
          child_session_id: childSessionId,
          seed_message_id: randomUUID(),
          owner_user_id: user.id,
          initiated_by_user_id: user.id,
          parent_session_id: parent.id,
          profile_id: 'sprouty',
          title: '[spawn-session] Concurrent child',
          metadata: { spawn_depth: 1, parent_session_id: parent.id, spawned_by: 'spawn_session' },
          prompt: `Concurrent admission ${childSessionId}`,
          depth: 1,
          max_steps: 5,
          mode: 'async',
          timeout_ms: 60_000,
          workspace_id: null,
          active_limit: 5,
          actor_user_id: user.id,
        });
        createdRunIds.push(admitted.run.id);
        createdSessionIds.unshift(admitted.session.id);
        return admitted;
      }),
    );

    const fulfilled = attempts.filter((result) => result.status === 'fulfilled');
    const rejected = attempts.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({ code: 'runtime_invalid_transition' }),
    });
    expect(await db.runtime.countActiveSubagentRuns(parent.id, user.id)).toBe(5);

    const rejectedChildId = childSessionIds.find((_childSessionId, index) => attempts[index]?.status === 'rejected');
    expect(rejectedChildId).toBeDefined();
    expect(await db.sessions.getById(rejectedChildId!)).toBeUndefined();
  });

  it('serializes an idempotent replay against deleting its existing child session', async () => {
    const user = await seedUser(`subagent-delete-race-${randomUUID()}@test.local`);
    const parent = await db.sessions.create('Subagent replay parent', 'team', user.id, undefined, 'web');
    createdSessionIds.push(parent.id);
    const childSessionId = randomUUID();
    const request = {
      child_session_id: childSessionId,
      seed_message_id: randomUUID(),
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      parent_session_id: parent.id,
      profile_id: 'sprouty',
      title: '[spawn-session] Replay delete race',
      metadata: { spawn_depth: 1, parent_session_id: parent.id, spawned_by: 'spawn_session' },
      prompt: 'Durable replay delete race',
      depth: 1,
      max_steps: 5,
      mode: 'async' as const,
      timeout_ms: 60_000,
      workspace_id: null,
      active_limit: 5,
      actor_user_id: user.id,
    };
    const first = await db.runtime.admitSubagent(request);
    createdRunIds.push(first.run.id);
    createdSessionIds.unshift(first.session.id);

    // Both paths lock the same session row. Regardless of ordering, delete
    // cannot remove the source while its active Runtime exists, and a replay
    // resolves to the original durable identity.
    const [replay, deletion] = await Promise.allSettled([
      db.runtime.admitSubagent(request),
      db.sessions.delete(childSessionId),
    ]);
    expect(replay).toMatchObject({
      status: 'fulfilled',
      value: { idempotent: true, run: { id: first.run.id }, session: { id: childSessionId } },
    });
    expect(deletion).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ name: 'SessionActiveRuntimeError' }),
    });
    expect(await db.sessions.getById(childSessionId)).toBeDefined();
  });

  it('settles cancel when a racing heartbeat observes desired_state before the cancel poll', async () => {
    const user = await seedUser(`subagent-heartbeat-cancel-${randomUUID()}@test.local`);
    const parent = await db.sessions.create('Heartbeat cancel parent', 'team', user.id, undefined, 'web');
    createdSessionIds.push(parent.id);
    const parentRun = await db.runtime.createRun({
      kind: 'chat',
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      session_id: parent.id,
      source_kind: 'chat_turn',
      source_id: randomUUID(),
      input: { prompt: 'parent' },
    });
    createdRunIds.push(parentRun.id);
    const parentWorkerId = `subagent-parent-${randomUUID()}`;
    const claimedParent = await db.runtime.claimNextRun({
      run_id: parentRun.id,
      worker_id: parentWorkerId,
      lease_ms: 60_000,
    });
    expect(claimedParent?.id).toBe(parentRun.id);
    await db.runtime.transitionRun({
      id: parentRun.id,
      expected_version: claimedParent!.version,
      to_status: 'running',
      idempotency_key: `subagent-parent-running-${parentRun.id}`,
      worker_id: parentWorkerId,
      lease_ms: 60_000,
    });
    const admitted = await db.runtime.admitSubagent({
      child_session_id: randomUUID(),
      seed_message_id: randomUUID(),
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      parent_session_id: parent.id,
      parent_run_id: parentRun.id,
      profile_id: 'team',
      title: '[spawn-session] Heartbeat cancel',
      metadata: { spawn_depth: 1, parent_session_id: parent.id, spawned_by: 'spawn_session' },
      prompt: 'Wait until canceled',
      depth: 1,
      max_steps: 5,
      mode: 'sync',
      timeout_ms: 60_000,
      workspace_id: null,
      actor_user_id: user.id,
    });
    createdSessionIds.unshift(admitted.session.id);
    const workerId = `subagent-heartbeat-${randomUUID()}`;
    const claimed = await db.runtime.claimExecution({
      run_id: admitted.run.id,
      step_id: admitted.step.id,
      worker_id: workerId,
      lease_ms: 60_000,
    });
    const execution = createSubagentRuntimeDriver({
      resolveMemory: async () => null,
      assembleTools: async () => ({}),
      heartbeatIntervalMs: 10,
      cancelPollIntervalMs: 60_000,
      generate: ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          const rejectAbort = () => reject(abortSignal?.reason ?? new Error('aborted'));
          if (abortSignal?.aborted) rejectAbort();
          else abortSignal?.addEventListener('abort', rejectAbort, { once: true });
        }),
      claimedStep: claimed!.step,
    })({ db, run: claimed!.run, workerId, leaseMs: 60_000 });

    const deadline = Date.now() + 3_000;
    while ((await db.runtime.getRun(admitted.run.id))?.status !== 'running') {
      if (Date.now() >= deadline) throw new Error('Subagent did not enter running');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await requestSubagentRuntimeCancellation(db, admitted.run.id, user.id, `heartbeat-cancel-${admitted.run.id}`);
    await execution;

    expect(await db.runtime.getRun(admitted.run.id)).toMatchObject({ status: 'canceled', desired_state: 'cancel' });
    expect(await db.runtime.listSteps(admitted.run.id)).toEqual([expect.objectContaining({ status: 'canceled' })]);
  }, 15_000);
});
