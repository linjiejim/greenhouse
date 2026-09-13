import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type RuntimeRunRow, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import {
  admitSubagentRuntimeRun,
  createSubagentRuntimeDriver,
  delegateSubagentRuntimeCancel,
  reconcileReclaimedSubagentRun,
  requestSubagentRuntimeCancellation,
  settleQueuedSubagentCancellation,
} from '../../apps/api/src/runtime/subagent-driver.js';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function startChatParentRun(run: RuntimeRunRow): Promise<RuntimeRunRow> {
  const claimed = await db.runtime.transitionRun({
    id: run.id,
    expected_version: run.version,
    to_status: 'claimed',
    idempotency_key: unique('parent-chat-claimed'),
  });
  return db.runtime.transitionRun({
    id: run.id,
    expected_version: claimed.version,
    to_status: 'running',
    projection_only: true,
    idempotency_key: unique('parent-chat-running'),
  });
}

async function seedChild(mode: 'sync' | 'async' = 'async'): Promise<{
  user: UserRow;
  parentRun: RuntimeRunRow;
  parentSessionId: string;
  childSessionId: string;
  run: RuntimeRunRow;
  stepId: string;
}> {
  const user = await createInternalTestUser(db, { email: `${unique('subagent')}@test.local` });
  const parent = await db.sessions.create('Parent', 'team', user.id, undefined, 'web');
  const parentRun = await startChatParentRun(
    await db.runtime.createRun({
      kind: 'chat',
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      session_id: parent.id,
      source_kind: 'chat_turn',
      source_id: unique('chat-turn'),
      input: { prompt: 'parent turn' },
    }),
  );
  const prompt = 'Inspect the exact durable request and report back.';
  const childSessionId = unique('durable-child');
  const envelope = await admitSubagentRuntimeRun(db, {
    owner_user_id: user.id,
    initiated_by_user_id: user.id,
    child_session_id: childSessionId,
    seed_message_id: unique('durable-child-seed'),
    parent_session_id: parent.id,
    parent_runtime_run_id: parentRun.id,
    profile_id: 'team',
    prompt,
    title: '[spawn-session] Durable child',
    depth: 1,
    max_steps: 5,
    mode,
    timeout_ms: 60_000,
    workspace_id: null,
  });
  return {
    user,
    parentRun,
    parentSessionId: parent.id,
    childSessionId,
    run: envelope.run,
    stepId: envelope.step.id,
  };
}

async function waitUntilRunning(runId: string): Promise<RuntimeRunRow> {
  const deadline = Date.now() + 3_000;
  let latest: RuntimeRunRow | undefined;
  while (Date.now() < deadline) {
    latest = await db.runtime.getRun(runId);
    if (latest?.status === 'running') return latest;
    if (latest && ['failed', 'canceled', 'interrupted', 'succeeded'].includes(latest.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Subagent Runtime did not enter running: ${latest?.status ?? 'missing'} ${latest?.error_message ?? ''}`,
  );
}

// Timeout is declared on the suite, not per case, because the exposure is a
// property of the whole file: every case drives the durable Runtime through a
// real PostgreSQL connection, so its wall time is dominated by round trips
// rather than computation. Measured under a loaded machine, the slowest case
// ("executes a queued child after restart", which also writes ~10KB of exact
// tool evidence) runs 2.6-5.5s and crosses the 5s default outright, but it is
// not alone — "cancels a queued child" was observed at 3415ms against a ~120ms
// idle baseline. Which case trips is whichever one lands on a starved worker,
// so pinning bounds to the two that happened to fail would just fit the sample.
// The value is measured, not guessed: at load average ~260 that slowest case
// was observed at 13.5s, so the 15s that comfortably covers the I/O-bound cases
// in network-policy/network-security (worst 3.5s there) would leave only ~10%
// margin here. This is a fail-safe rather than a sleep: dedicated runs stay an
// order of magnitude below it, it mirrors the db project's existing hookTimeout
// rationale in vitest.config.ts, and a stuck lease still fails, just later.
describe('durable Subagent Runtime driver', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('atomically admits transcript + Run + Step and replays the same tool-call identity', async () => {
    const user = await createInternalTestUser(db, { email: `${unique('subagent-atomic')}@test.local` });
    const parent = await db.sessions.create('Atomic parent', 'team', user.id, undefined, 'web');
    const parentRun = await startChatParentRun(
      await db.runtime.createRun({
        kind: 'chat',
        owner_user_id: user.id,
        initiated_by_user_id: user.id,
        session_id: parent.id,
        source_kind: 'chat_turn',
        source_id: unique('atomic-chat-turn'),
        input: { prompt: 'parent' },
      }),
    );
    const childSessionId = unique('atomic-child');
    const seedMessageId = unique('atomic-seed');
    const request = {
      child_session_id: childSessionId,
      seed_message_id: seedMessageId,
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      parent_session_id: parent.id,
      parent_run_id: parentRun.id,
      profile_id: 'team',
      title: '[spawn-session] Atomic child',
      metadata: { spawn_depth: 1, parent_session_id: parent.id, spawned_by: 'spawn_session' },
      prompt: 'Atomically durable prompt',
      depth: 1,
      max_steps: 5,
      mode: 'async' as const,
      timeout_ms: 60_000,
      workspace_id: null,
      active_limit: 5,
      actor_user_id: user.id,
    };

    // Parent Runtime validation shares the same outer transaction as transcript
    // insertion, so a bad lineage must leave no child-domain residue.
    await expect(
      db.runtime.admitSubagent({ ...request, parent_run_id: 'missing-parent-runtime' }),
    ).rejects.toMatchObject({ code: 'runtime_not_found' });
    expect(await db.sessions.getById(childSessionId)).toBeUndefined();
    expect(await db.runtime.getRunBySource('subagent', 'spawned_session', childSessionId)).toBeUndefined();

    // Even though a valid active Run exists for this parent session, an
    // explicit missing lineage must not silently fall back to it.
    const noFallbackChild = unique('explicit-parent-no-fallback');
    await expect(
      admitSubagentRuntimeRun(db, {
        owner_user_id: user.id,
        initiated_by_user_id: user.id,
        child_session_id: noFallbackChild,
        seed_message_id: unique('explicit-parent-no-fallback-seed'),
        parent_session_id: parent.id,
        parent_runtime_run_id: 'missing-explicit-parent',
        profile_id: 'team',
        prompt: 'Must not use another parent Runtime',
        title: '[spawn-session] No fallback',
        depth: 1,
        max_steps: 5,
        mode: 'async',
        timeout_ms: 60_000,
        workspace_id: null,
      }),
    ).rejects.toMatchObject({ code: 'runtime_not_found' });
    expect(await db.sessions.getById(noFallbackChild)).toBeUndefined();

    const admitted = await db.runtime.admitSubagent(request);
    const replayed = await db.runtime.admitSubagent(request);
    expect(replayed).toMatchObject({
      idempotent: true,
      session: { id: admitted.session.id },
      message: { id: admitted.message.id },
      run: { id: admitted.run.id },
      step: { id: admitted.step.id },
    });
    expect(await db.sessions.getMessages(childSessionId)).toEqual([
      expect.objectContaining({ id: seedMessageId, role: 'user', content: request.prompt, seq: 0 }),
    ]);
    await expect(db.runtime.admitSubagent({ ...request, prompt: 'Different retry payload' })).rejects.toMatchObject({
      code: 'runtime_idempotency_conflict',
    });

    const canceledParent = await db.runtime.executeRunDomainCommand(
      {
        type: 'cancel',
        run_id: parentRun.id,
        expected_version: parentRun.version,
        idempotency_key: unique('parent-cancel-before-child'),
      },
      user.id,
      async ({ may_drive: mayDrive }) => expect(mayDrive).toBe(true),
    );
    expect(canceledParent.run.desired_state).toBe('cancel');
    const canceledChild = unique('canceled-parent-child');
    await expect(
      db.runtime.admitSubagent({
        ...request,
        child_session_id: canceledChild,
        seed_message_id: unique('canceled-parent-seed'),
      }),
    ).rejects.toMatchObject({ code: 'runtime_invalid_transition' });
    expect(await db.sessions.getById(canceledChild)).toBeUndefined();
  });

  it('executes a queued child after restart, preserves lineage, and stores exact tool evidence', async () => {
    const seeded = await seedChild();
    const workerId = unique('subagent-restart-worker');
    const claimed = await db.runtime.claimNextRun({
      run_id: seeded.run.id,
      worker_id: workerId,
      lease_ms: 60_000,
      kinds: ['subagent'],
    });
    expect(claimed?.id).toBe(seeded.run.id);

    const exactInput = { project_id: 'p-1', query: 'x'.repeat(5_000), nested: { preserve: true } };
    const exactOutput = { rows: [{ id: 'row-1', full: 'y'.repeat(5_000) }] };
    const executeProjectQuery = vi.fn(async () => exactOutput);
    await createSubagentRuntimeDriver({
      resolveMemory: async () => null,
      assembleTools: async () => ({ project_query: { execute: executeProjectQuery } }),
      heartbeatIntervalMs: 60_000,
      generate: async ({ tools }) => {
        const output = await tools!.project_query.execute(exactInput, { toolCallId: 'call-exact-1' });
        return {
          text: 'Durable child completed.',
          usage: { inputTokens: 11, outputTokens: 7 },
          steps: [
            {
              toolCalls: [{ toolCallId: 'call-exact-1', toolName: 'project_query', input: exactInput }],
              toolResults: [{ toolCallId: 'call-exact-1', toolName: 'project_query', output }],
            },
          ],
        };
      },
    })({ db, run: claimed!, workerId, leaseMs: 60_000 });

    const completed = (await db.runtime.getRun(seeded.run.id))!;
    expect(completed).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      parent_run_id: seeded.parentRun.id,
      root_run_id: seeded.parentRun.root_run_id,
      source_kind: 'spawned_session',
      source_id: seeded.childSessionId,
      max_attempts: 1,
      error_message: null,
    });
    expect(JSON.parse(completed.input)).toMatchObject({
      child_session_id: seeded.childSessionId,
      parent_session_id: seeded.parentSessionId,
      profile_id: 'team',
      prompt: 'Inspect the exact durable request and report back.',
    });
    expect(await db.runtime.listSteps(completed.id)).toEqual([
      expect.objectContaining({ status: 'succeeded', step_key: 'agent-turn', tokens_used: 18, requests_used: 1 }),
    ]);
    const [toolCall] = await db.runtime.listToolCalls(completed.id);
    expect(toolCall).toMatchObject({ tool_name: 'project_query', status: 'succeeded' });
    expect(executeProjectQuery).toHaveBeenCalledOnce();
    expect(JSON.parse(toolCall!.input)).toEqual(exactInput);
    expect(JSON.parse(toolCall!.output!)).toEqual(exactOutput);
    expect(await db.sessions.getLatestMessage(seeded.childSessionId)).toMatchObject({
      role: 'assistant',
      content: 'Durable child completed.',
    });
  });

  it('fails a stale running child once and never replays its uncertain side-effectful turn', async () => {
    const seeded = await seedChild();
    // Setup runs entirely on the real clock, and only the reclaim point is
    // injected — derived from the lease the kernel actually stamped.
    //
    // `claimExecution` accepts an injected `at`, but `transitionRun` and
    // `transitionStep` do not (`RuntimeRunTransitionInput` has no such field);
    // they read `nowIso()` internally. Seeding the claim from a captured `base`
    // while the transitions used real time put three separate checks on a race
    // with the 1s lease: both transitions fence on the *existing* lease still
    // being live (`runtime_lease_lost` once >1s of setup elapsed), and the
    // reclaim cutoff of `base + 2s` only exceeds a lease stamped at
    // `realNow + 1s` while setup stays under a second. On a loaded machine it
    // does not, so the run was never stale, `find()` returned `undefined`, and
    // the case failed on a confusing `toMatchObject(undefined)` rather than a
    // timeout — which no timeout bound could have fixed.
    //
    // The lease duration was never the subject here: staleness is decided by
    // the injected cutoff below. So use the same 60s lease the real worker and
    // the rest of this file use (long enough that it cannot lapse mid-setup),
    // then reclaim from a point provably past what was stamped.
    const claimed = await db.runtime.claimExecution({
      run_id: seeded.run.id,
      step_id: seeded.stepId,
      worker_id: 'subagent-crashed-worker',
      lease_ms: 60_000,
    });
    const running = await db.runtime.transitionRun({
      id: claimed!.run.id,
      expected_version: claimed!.run.version,
      to_status: 'running',
      idempotency_key: 'subagent-test-running',
      worker_id: 'subagent-crashed-worker',
      lease_ms: 60_000,
    });
    await db.runtime.transitionStep({
      id: claimed!.step.id,
      expected_version: claimed!.step.version,
      to_status: 'running',
      idempotency_key: 'subagent-test-step-running',
      worker_id: 'subagent-crashed-worker',
      lease_ms: 60_000,
    });

    // The worker "crashes" here — nothing renews the lease, so every instant
    // past its expiry is stale by definition, however long the setup took.
    const leaseExpiredAt = Date.parse(running.lease_expires_at!);
    const reclaimed = await db.runtime.reclaimStaleRuns(new Date(leaseExpiredAt + 1_000), 10);
    const failed = reclaimed.find((run) => run.id === seeded.run.id)!;
    expect(failed).toMatchObject({ status: 'failed', error_code: 'runtime_attempts_exhausted' });
    await reconcileReclaimedSubagentRun(db, failed);

    expect(await db.runtime.listSteps(running.id)).toEqual([
      expect.objectContaining({ status: 'interrupted', error_code: 'subagent_lease_expired' }),
    ]);
    await expect(
      db.runtime.claimNextRun({
        run_id: running.id,
        worker_id: 'subagent-replacement-worker',
        lease_ms: 60_000,
        kinds: ['subagent'],
        at: new Date(leaseExpiredAt + 2_000),
      }),
    ).resolves.toBeUndefined();
    expect(await db.sessions.getLatestMessage(seeded.childSessionId)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('不会自动重放'),
    });
  });

  it('cancels a queued child durably and closes its Step without a fake domain mutation', async () => {
    const seeded = await seedChild();
    const fenced = await db.runtime.executeRunDomainCommand(
      {
        type: 'cancel',
        run_id: seeded.run.id,
        expected_version: seeded.run.version,
        idempotency_key: `cancel-${seeded.run.id}`,
      },
      seeded.user.id,
      ({ run, may_drive: mayDrive }) => delegateSubagentRuntimeCancel(db, run, 'cancel', mayDrive),
    );
    const canceled = await settleQueuedSubagentCancellation(db, fenced.run, seeded.user.id);

    expect(canceled).toMatchObject({ status: 'canceled', desired_state: 'cancel' });
    expect(await db.runtime.listSteps(canceled.id)).toEqual([expect.objectContaining({ status: 'canceled' })]);
    expect(await db.sessions.getLatestMessage(seeded.childSessionId)).toMatchObject({
      role: 'assistant',
      content: '⚠️ 子任务已取消。',
    });
  });

  it('blocks deleting a child or parent session while its Subagent Run is active', async () => {
    const seeded = await seedChild();
    await expect(db.sessions.delete(seeded.childSessionId)).rejects.toThrow(/Subagent execution is active/i);
    await expect(db.sessions.delete(seeded.parentSessionId)).rejects.toThrow(/Subagent execution is active/i);
    expect(await db.sessions.getById(seeded.childSessionId)).toBeDefined();
    expect(await db.sessions.getById(seeded.parentSessionId)).toBeDefined();
  });

  it('polls desired_state and aborts a running child when its parent/Task Center cancels', async () => {
    const seeded = await seedChild('sync');
    const workerId = unique('subagent-cancel-worker');
    const claimed = await db.runtime.claimExecution({
      run_id: seeded.run.id,
      step_id: seeded.stepId,
      worker_id: workerId,
      lease_ms: 60_000,
    });
    const execution = createSubagentRuntimeDriver({
      resolveMemory: async () => null,
      assembleTools: async () => ({}),
      heartbeatIntervalMs: 60_000,
      cancelPollIntervalMs: 10,
      generate: ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          const rejectAbort = () => reject(abortSignal?.reason ?? new Error('aborted'));
          if (abortSignal?.aborted) rejectAbort();
          else abortSignal?.addEventListener('abort', rejectAbort, { once: true });
        }),
      claimedStep: claimed!.step,
    })({ db, run: claimed!.run, workerId, leaseMs: 60_000 });

    await waitUntilRunning(seeded.run.id);
    await requestSubagentRuntimeCancellation(db, seeded.run.id, seeded.user.id, `parent-cancel-${seeded.run.id}`);
    await execution;

    expect(await db.runtime.getRun(seeded.run.id)).toMatchObject({ status: 'canceled', desired_state: 'cancel' });
    expect(await db.runtime.listSteps(seeded.run.id)).toEqual([expect.objectContaining({ status: 'canceled' })]);
  });
}, 30_000);
