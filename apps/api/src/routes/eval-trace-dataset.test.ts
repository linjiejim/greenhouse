import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalTraceIdempotencyConflictError } from '@greenhouse/db';
import type { EvalDataset } from '@greenhouse/types/eval';
import type { AppEnv } from '../app-env.js';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  ensureEvalRuntimeRun: vi.fn(),
  settleQueuedEvalCancellation: vi.fn(),
}));

vi.mock('@greenhouse/db', () => {
  class EvalTraceIdempotencyConflictError extends Error {}
  return { getDb: mocks.getDb, EvalTraceIdempotencyConflictError };
});
vi.mock('@greenhouse/db/seeds/eval-seed', () => ({ SEED_DATASETS: [] }));
vi.mock('../runtime/eval-driver.js', () => ({
  ensureEvalRuntimeRun: mocks.ensureEvalRuntimeRun,
  settleQueuedEvalCancellation: mocks.settleQueuedEvalCancellation,
}));

import evalRoutes from './eval.js';

const runtimeRow = {
  id: 'rtr_trace_1',
  kind: 'mission',
  owner_user_id: 'member',
  initiated_by_user_id: 'member',
  session_id: 'session-1',
  parent_run_id: null,
  root_run_id: 'rtr_trace_1',
  source_kind: 'agent_run',
  source_id: 'mission-1',
  idempotency_key: 'mission-1',
  status: 'succeeded',
  desired_state: 'run',
  wait_reason: null,
  priority: 0,
  not_before: null,
  deadline_at: null,
  lease_owner: null,
  lease_expires_at: null,
  heartbeat_at: null,
  attempt: 1,
  max_attempts: 3,
  input: JSON.stringify({ prompt: 'original prompt', api_key: 'sk-sensitive-value' }),
  output: JSON.stringify({ answer: 'x'.repeat(20_000) }),
  error_code: null,
  error_message: null,
  started_at: '2026-08-12T00:00:00.000Z',
  ended_at: '2026-08-12T00:01:00.000Z',
  settled_at: '2026-08-12T00:01:00.000Z',
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:01:00.000Z',
  version: 3,
} as const;

const dataset: EvalDataset = {
  id: 77,
  category: 'runtime-mission',
  difficulty: 'medium',
  question: 'Why did this fail?',
  ground_truth: 'Expected answer',
  expected_behavior: null,
  tags: '["runtime-trace"]',
  language: 'en',
  is_negative: 0,
  enabled: 1,
  created_by: 'admin',
  updated_by: 'admin',
  source: 'agent',
  source_session_id: 'session-1',
  status: 'active',
  notes: '[runtime-trace:v1] {}',
  archived_at: null,
  created_at: '2026-08-12T00:02:00.000Z',
  updated_at: '2026-08-12T00:02:00.000Z',
};

function appFor(role: 'team' | 'super') {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: role === 'super' ? 'admin' : 'member', role });
      await next();
    })
    .route('/', evalRoutes);
}

function dbFixture(created = true) {
  const createDatasetFromRuntimeTrace = vi.fn().mockResolvedValue({ dataset, created });
  const db = {
    runtime: {
      getRunDetail: vi.fn().mockResolvedValue({
        run: runtimeRow,
        events: [
          {
            id: 'rte-1',
            run_id: runtimeRow.id,
            step_id: null,
            seq: 1,
            type: 'run.created',
            payload: JSON.stringify({ email: 'person@example.com' }),
            actor_user_id: 'owner',
            idempotency_key: 'created',
            created_at: runtimeRow.created_at,
          },
        ],
        steps: [],
        tool_calls: [],
        artifacts: [],
        interrupts: [],
      }),
    },
    eval: { getRun: vi.fn(), getRunResults: vi.fn(), createDatasetFromRuntimeTrace },
    sessions: {
      getMessageCount: vi.fn().mockResolvedValue(2),
      getMessages: vi.fn().mockResolvedValue([
        { id: 'm1', session_id: 'session-1', role: 'user', content: 'first', seq: 0 },
        { id: 'm2', session_id: 'session-1', role: 'user', content: 'latest exact question', seq: 1 },
      ]),
    },
  };
  mocks.getDb.mockReturnValue(db);
  return { db, createDatasetFromRuntimeTrace };
}

describe('Trace → Eval Dataset routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settleQueuedEvalCancellation.mockImplementation(async (_db, run) => run);
  });

  it('is super-only even when mounted without the global Eval guard', async () => {
    dbFixture();
    const response = await appFor('team').request(`/datasets/from-runtime/${runtimeRow.id}/preview`);
    expect(response.status).toBe(403);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it('previews complete unredacted evidence without creating a Dataset', async () => {
    const { db, createDatasetFromRuntimeTrace } = dbFixture();
    const response = await appFor('super').request(`/datasets/from-runtime/${runtimeRow.id}/preview`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.draft.category).toBe('edge');
    expect(body.draft.question).toBe('latest exact question');
    expect(body.draft.ground_truth).toHaveLength(20_000);
    expect(body.evidence.run.input.api_key).toBe('sk-sensitive-value');
    expect(body.evidence.events[0].payload.email).toBe('person@example.com');
    expect(body.warnings[0].paths).toEqual(
      expect.arrayContaining(['evidence.run.input.api_key', 'evidence.events[0].payload.email']),
    );
    expect(db.sessions.getMessages).toHaveBeenCalledWith('session-1', { limit: 2 });
    expect(createDatasetFromRuntimeTrace).not.toHaveBeenCalled();
  });

  it('prefills editable fields from the lowest Eval result without exposing JSON-array syntax', async () => {
    const { db } = dbFixture();
    db.runtime.getRunDetail.mockResolvedValue({
      run: {
        ...runtimeRow,
        kind: 'eval',
        source_kind: 'eval_run',
        source_id: 'eval-run-1',
        session_id: null,
        status: 'failed',
        input: '{}',
        output: null,
      },
      events: [],
      steps: [],
      tool_calls: [],
      artifacts: [],
      interrupts: [],
    });
    db.eval.getRun.mockResolvedValue({ id: 'eval-run-1' });
    db.eval.getRunResults.mockResolvedValue([
      {
        id: 91,
        run_id: 'eval-run-1',
        dataset_id: 12,
        status: 'completed',
        error: null,
        score_final: 0.2,
        question: 'Why did the regression fail?',
        ground_truth: JSON.stringify(['First exact fact', 'Second exact fact']),
        category: 'troubleshooting',
        difficulty: 'hard',
        language: 'en',
        tags: JSON.stringify(['regression']),
        is_negative: 0,
      },
    ]);

    const response = await appFor('super').request(`/datasets/from-runtime/${runtimeRow.id}/preview`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.draft).toMatchObject({
      question: 'Why did the regression fail?',
      ground_truth: 'First exact fact\nSecond exact fact',
      category: 'troubleshooting',
      difficulty: 'hard',
      language: 'en',
      is_negative: false,
    });
    expect(body.draft.tags).toEqual(expect.arrayContaining(['regression', 'runtime-trace', 'eval', 'status:failed']));
  });

  it('creates only after explicit submission and returns an idempotent replay without a duplicate', async () => {
    const { createDatasetFromRuntimeTrace } = dbFixture(false);
    const draft = {
      category: 'runtime-mission',
      difficulty: 'hard',
      question: 'Edited question',
      ground_truth: 'Edited expected result',
      expected_behavior: 'No failure',
      tags: ['runtime-trace'],
      language: 'en',
      is_negative: true,
      enabled: true,
      notes: 'operator note',
    };
    const response = await appFor('super').request(`/datasets/from-runtime/${runtimeRow.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'web:trace:once', dataset: draft }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dataset: { id: 77, source: 'agent' }, created: false });
    expect(createDatasetFromRuntimeTrace).toHaveBeenCalledWith({
      source: {
        runtime_run_id: runtimeRow.id,
        runtime_kind: 'mission',
        runtime_status: 'succeeded',
        source_kind: 'agent_run',
        source_id: 'mission-1',
        session_id: 'session-1',
      },
      dataset: draft,
      actor_user_id: 'admin',
      idempotency_key: 'web:trace:once',
    });
  });

  it('returns a stable conflict when a capture key is reused with changed content', async () => {
    const { createDatasetFromRuntimeTrace } = dbFixture();
    createDatasetFromRuntimeTrace.mockRejectedValueOnce(new EvalTraceIdempotencyConflictError());
    const response = await appFor('super').request(`/datasets/from-runtime/${runtimeRow.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotency_key: 'web:trace:conflict',
        dataset: {
          category: 'negative',
          difficulty: 'hard',
          question: 'Changed question',
          ground_truth: 'Changed result',
          expected_behavior: '',
          tags: [],
          language: 'en',
          is_negative: true,
          enabled: true,
          notes: '',
        },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'trace_idempotency_conflict' });
  });

  it('persists direct Eval cancellation through the Runtime command fence', async () => {
    const evalRun = { id: 'eval-run-cancel', status: 'queued' };
    const runtimeRun = {
      ...runtimeRow,
      id: 'runtime-eval-cancel',
      root_run_id: 'runtime-eval-cancel',
      kind: 'eval',
      source_kind: 'eval_run',
      source_id: evalRun.id,
      status: 'queued',
      desired_state: 'run',
      version: 1,
    };
    const commanded = { ...runtimeRun, desired_state: 'cancel', version: 2 };
    const cancelRun = vi.fn().mockResolvedValue(undefined);
    const evalService = {
      getRun: vi
        .fn()
        .mockResolvedValueOnce(evalRun)
        .mockResolvedValueOnce(evalRun)
        .mockResolvedValueOnce({ ...evalRun, status: 'cancelled' }),
      cancelRun,
    };
    const runtime = {
      getRunBySource: vi.fn().mockResolvedValue(runtimeRun),
      executeRunDomainCommand: vi.fn(
        async (_command: unknown, _actor: unknown, effect: (context: { may_drive: boolean }) => Promise<void>) => {
          await effect({ may_drive: true });
          return { run: commanded, idempotent: false };
        },
      ),
      transitionRun: vi.fn().mockResolvedValue({ ...commanded, status: 'canceled', version: 3 }),
    };
    mocks.getDb.mockReturnValue({ eval: evalService, runtime });
    const canceled = { ...commanded, status: 'canceled', version: 3 };
    mocks.settleQueuedEvalCancellation.mockResolvedValueOnce(canceled);

    const response = await appFor('super').request(`/runs/${evalRun.id}/cancel`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: evalRun.id, status: 'cancelled' });
    expect(cancelRun).toHaveBeenCalledWith(evalRun.id);
    expect(runtime.executeRunDomainCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cancel', run_id: runtimeRun.id, expected_version: 1 }),
      'admin',
      expect.any(Function),
    );
    expect(mocks.settleQueuedEvalCancellation).toHaveBeenCalledWith(
      expect.objectContaining({ eval: evalService, runtime }),
      commanded,
      'admin',
    );
  });
});
