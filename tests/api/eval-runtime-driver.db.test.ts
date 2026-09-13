import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { ResultUpdateData } from '@greenhouse/db';
import { validateAccessToken } from '../../apps/api/src/auth/token.js';
import {
  createEvalRuntimeDriver,
  ensureEvalRuntimeRun,
  reconcileReclaimedEvalRun,
  settleQueuedEvalCancellation,
  type EvalCaseExecutor,
} from '../../apps/api/src/runtime/eval-driver.js';
import { createInternalTestUser } from '../helpers/internal-user.js';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

let db: DatabaseProvider;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random()}`;
}

const successfulCase: ResultUpdateData = {
  answer: 'durable answer',
  references_used: [],
  duration_ms: 25,
  ttfb_ms: 5,
  answer_length: 14,
  score_accuracy: 9,
  score_completeness: 8,
  score_relevance: 9,
  score_speed: 10,
  score_final: 8.8,
  judge_reasoning: { durable: true },
  status: 'completed',
};

async function queuedEval(caseCount = 1) {
  const actor = await createInternalTestUser(db, {
    email: `${unique('eval-runtime')}@test.local`,
    role: 'super',
  });
  const datasets = [];
  for (let index = 0; index < caseCount; index += 1) {
    datasets.push(
      await db.eval.createDataset({
        category: 'durability',
        difficulty: 'medium',
        question: `Question ${index}`,
        ground_truth: JSON.stringify([`Fact ${index}`]),
        enabled: true,
      }),
    );
  }
  const datasetIds = datasets.map((dataset) => dataset.id);
  const created = await db.eval.createQueuedRun({
    name: unique('durable-eval'),
    total: datasetIds.length,
    model: 'test-model',
    profileId: 'team',
    datasetIds,
    config: {
      actor_user_id: actor.id,
      concurrency: 2,
      profile_id: 'team',
      dataset_ids: datasetIds,
      agent_timeout_ms: 5_000,
    },
  });
  const runtime = await ensureEvalRuntimeRun(db, created.run);
  return { actor, datasets, evalRun: created.run, results: created.results, runtime };
}

async function claimEval(workerId: string, at?: Date, leaseMs = 60_000) {
  const run = await db.runtime.claimNextRun({
    worker_id: workerId,
    lease_ms: leaseMs,
    kinds: ['eval'],
    ...(at ? { at } : {}),
  });
  expect(run).toBeDefined();
  return run!;
}

describe('durable Eval Runtime driver', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('executes a persisted request under a fresh active-super token and settles Runtime/Step facts', async () => {
    const fixture = await queuedEval();
    const executeCase = vi.fn<EvalCaseExecutor>(async ({ accessToken, userId }) => {
      expect(validateAccessToken(accessToken)).toMatchObject({ uid: userId, role: 'super' });
      return successfulCase;
    });
    const workerId = unique('eval-worker');
    const claimed = await claimEval(workerId);

    await createEvalRuntimeDriver({ executeCase, heartbeatIntervalMs: 60_000 })({
      db,
      run: claimed,
      workerId,
      leaseMs: 60_000,
    });

    expect(executeCase).toHaveBeenCalledOnce();
    expect(await db.eval.getRun(fixture.evalRun.id)).toMatchObject({ status: 'completed', completed: 1 });
    expect(await db.runtime.getRun(fixture.runtime.id)).toMatchObject({ status: 'succeeded', desired_state: 'run' });
    expect(await db.eval.listResults(fixture.evalRun.id)).toEqual([
      expect.objectContaining({ status: 'completed', answer: 'durable answer' }),
    ]);
    expect(await db.runtime.listSteps(fixture.runtime.id)).toEqual([
      expect.objectContaining({ status: 'succeeded', step_key: `eval-result:${fixture.results[0]!.id}` }),
    ]);
    expect(JSON.parse((await db.runtime.getRun(fixture.runtime.id))!.input)).not.toHaveProperty('access_token');
  });

  it('never repeats a committed case and resumes only the pending result', async () => {
    const fixture = await queuedEval(2);
    await db.eval.updatePendingResult(fixture.results[0]!.id, { ...successfulCase, answer: 'already committed' });
    await db.eval.updateRunProgress(fixture.evalRun.id, 1);
    const executeCase = vi.fn<EvalCaseExecutor>(async ({ result }) => ({
      ...successfulCase,
      answer: `executed ${result.dataset_id}`,
    }));
    const workerId = unique('eval-resume-worker');
    const claimed = await claimEval(workerId);

    await createEvalRuntimeDriver({ executeCase, heartbeatIntervalMs: 60_000 })({
      db,
      run: claimed,
      workerId,
      leaseMs: 60_000,
    });

    expect(executeCase).toHaveBeenCalledOnce();
    expect(executeCase.mock.calls[0]![0].result.id).toBe(fixture.results[1]!.id);
    const results = await db.eval.listResults(fixture.evalRun.id);
    expect(results.map((result) => result.answer)).toEqual(['already committed', `executed ${results[1]!.dataset_id}`]);
    expect((await db.runtime.listSteps(fixture.runtime.id)).map((step) => step.status)).toEqual([
      'succeeded',
      'succeeded',
    ]);
  });

  it('fails closed before provider I/O when the persisted super actor is disabled', async () => {
    const fixture = await queuedEval();
    await db.users.updateAndRevokeSessions(fixture.actor.id, { status: 'disabled' });
    const executeCase = vi.fn<EvalCaseExecutor>(async () => successfulCase);
    const workerId = unique('disabled-actor-worker');
    const claimed = await claimEval(workerId);

    await createEvalRuntimeDriver({ executeCase, heartbeatIntervalMs: 60_000 })({
      db,
      run: claimed,
      workerId,
      leaseMs: 60_000,
    });

    expect(executeCase).not.toHaveBeenCalled();
    expect(await db.eval.getRun(fixture.evalRun.id)).toMatchObject({ status: 'failed' });
    expect(await db.runtime.getRun(fixture.runtime.id)).toMatchObject({
      status: 'failed',
      error_code: 'eval_driver_failed',
    });
  });

  it('does not cross into provider I/O from an already-expired claim', async () => {
    await queuedEval();
    const workerId = unique('expired-eval-worker');
    const claimed = await claimEval(workerId, new Date(Date.now() - 10_000), 1_000);
    const executeCase = vi.fn<EvalCaseExecutor>(async () => successfulCase);

    await expect(
      createEvalRuntimeDriver({ executeCase, heartbeatIntervalMs: 60_000 })({
        db,
        run: claimed,
        workerId,
        leaseMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: 'runtime_lease_lost' });
    expect(executeCase).not.toHaveBeenCalled();
  });

  it('closes every pre-created case Step when a queued Eval is canceled', async () => {
    const fixture = await queuedEval(2);
    await db.eval.cancelRun(fixture.evalRun.id);
    const fenced = await db.runtime.executeRunDomainCommand(
      {
        type: 'cancel',
        run_id: fixture.runtime.id,
        expected_version: fixture.runtime.version,
        idempotency_key: unique('queued-eval-cancel'),
      },
      fixture.actor.id,
      async () => {},
    );

    const canceled = await settleQueuedEvalCancellation(db, fenced.run, fixture.actor.id);

    expect(canceled).toMatchObject({ status: 'canceled', desired_state: 'cancel' });
    expect((await db.runtime.listSteps(fixture.runtime.id)).map((step) => step.status)).toEqual([
      'canceled',
      'canceled',
    ]);
  });

  it('recovers an expired process lease as a new immutable case attempt', async () => {
    const fixture = await queuedEval();
    const staleAt = new Date();
    const oldWorker = unique('old-eval-worker');
    const oldClaim = await claimEval(oldWorker, staleAt, 1_000);
    await db.runtime.transitionRun({
      id: oldClaim.id,
      expected_version: oldClaim.version,
      to_status: 'running',
      idempotency_key: unique('old-running'),
      worker_id: oldWorker,
      lease_ms: 1_000,
    });
    const originalStep = (await db.runtime.listSteps(fixture.runtime.id))[0]!;
    const oldStepClaim = await db.runtime.claimNextStep({
      worker_id: oldWorker,
      lease_ms: 1_000,
      run_id: fixture.runtime.id,
      step_id: originalStep.id,
      at: staleAt,
    });
    await db.runtime.transitionStep({
      id: oldStepClaim!.id,
      expected_version: oldStepClaim!.version,
      to_status: 'running',
      idempotency_key: unique('old-step-running'),
      worker_id: oldWorker,
      lease_ms: 1_000,
    });
    await db.runtime.reclaimStaleRuns(new Date(staleAt.getTime() + 2_000), 10);

    const newWorker = unique('new-eval-worker');
    const recovered = await claimEval(newWorker);
    const executeCase = vi.fn<EvalCaseExecutor>(async () => successfulCase);
    await createEvalRuntimeDriver({ executeCase, heartbeatIntervalMs: 60_000 })({
      db,
      run: recovered,
      workerId: newWorker,
      leaseMs: 60_000,
    });

    expect(executeCase).toHaveBeenCalledOnce();
    expect(await db.runtime.getRun(fixture.runtime.id)).toMatchObject({ status: 'succeeded', attempt: 2 });
    const steps = await db.runtime.listSteps(fixture.runtime.id);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ id: originalStep.id, status: 'interrupted', attempt: 1 });
    expect(steps[1]).toMatchObject({ status: 'succeeded', attempt: 2, step_key: originalStep.step_key });
  });

  it('projects an exhausted final Runtime lease back to Eval and all active case steps', async () => {
    const fixture = await queuedEval(2);
    const base = new Date();
    let reclaimed = fixture.runtime;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const workerId = unique(`exhausted-worker-${attempt}`);
      const claimed = await claimEval(workerId, new Date(base.getTime() + attempt * 2_000), 1_000);
      await db.runtime.transitionRun({
        id: claimed.id,
        expected_version: claimed.version,
        to_status: 'running',
        idempotency_key: unique(`exhausted-running-${attempt}`),
        worker_id: workerId,
        lease_ms: 1_000,
      });
      const recovered = await db.runtime.reclaimStaleRuns(
        new Date(base.getTime() + attempt * 2_000 + 1_001),
      );
      expect(recovered).toHaveLength(1);
      reclaimed = recovered[0]!;
    }

    expect(reclaimed).toMatchObject({ status: 'failed', attempt: 3 });
    await reconcileReclaimedEvalRun(db, reclaimed);
    expect(await db.eval.getRun(fixture.evalRun.id)).toMatchObject({ status: 'failed' });
    expect((await db.runtime.listSteps(fixture.runtime.id)).map((step) => step.status)).toEqual([
      'skipped',
      'skipped',
    ]);
  });

  it('observes durable desired_state cancellation and stops at the case boundary', async () => {
    const fixture = await queuedEval();
    let started!: () => void;
    const caseStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executeCase = vi.fn<EvalCaseExecutor>(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          started();
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const workerId = unique('cancel-eval-worker');
    const claimed = await claimEval(workerId);
    // Heartbeats are intentionally too slow to help this assertion: the
    // read-only cancel poll must abort the in-flight authenticated fetch.
    const driver = createEvalRuntimeDriver({
      executeCase,
      heartbeatIntervalMs: 60_000,
      cancelPollIntervalMs: 25,
    });
    const running = driver({ db, run: claimed, workerId, leaseMs: 5_000 });
    await caseStarted;

    const current = (await db.runtime.getRun(fixture.runtime.id))!;
    await db.runtime.executeRunDomainCommand(
      {
        type: 'cancel',
        run_id: current.id,
        expected_version: current.version,
        idempotency_key: unique('durable-cancel'),
      },
      fixture.actor.id,
      async ({ may_drive: mayDrive }) => {
        expect(mayDrive).toBe(true);
        await db.eval.cancelRun(fixture.evalRun.id);
      },
    );
    await running;

    expect(await db.eval.getRun(fixture.evalRun.id)).toMatchObject({ status: 'cancelled' });
    expect(await db.runtime.getRun(fixture.runtime.id)).toMatchObject({ status: 'canceled', desired_state: 'cancel' });
    expect(await db.eval.listResults(fixture.evalRun.id)).toEqual([
      expect.objectContaining({ status: 'cancelled', answer: null }),
    ]);
    expect(await db.runtime.listSteps(fixture.runtime.id)).toEqual([expect.objectContaining({ status: 'canceled' })]);
  });
});
