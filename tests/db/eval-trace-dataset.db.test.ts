import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, EvalTraceIdempotencyConflictError, initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { RuntimeDatasetDraft, RuntimeDatasetTraceSource } from '@greenhouse/types/eval';

let db: DatabaseProvider;

const source: RuntimeDatasetTraceSource = {
  runtime_run_id: 'rtr-trace-dataset-test',
  runtime_kind: 'mission',
  runtime_status: 'failed',
  source_kind: 'agent_run',
  source_id: 'mission-trace-dataset-test',
  session_id: 'session-trace-dataset-test',
};

const draft: RuntimeDatasetDraft = {
  category: 'runtime-mission',
  difficulty: 'medium',
  question: 'Preserve this exact question',
  ground_truth: 'Preserve this exact ground truth',
  expected_behavior: 'Complete safely',
  tags: ['runtime-trace', 'mission'],
  language: 'en',
  is_negative: true,
  enabled: true,
  notes: 'Permanent operator note',
};

describe('Eval Trace Dataset persistence', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('atomically replays a duplicate capture and preserves provenance plus exact content', async () => {
    const idempotencyKey = `trace-test:${Date.now()}:${Math.random()}`;
    const first = await db.eval.createDatasetFromRuntimeTrace({
      source,
      dataset: draft,
      actor_user_id: 'super-test',
      idempotency_key: idempotencyKey,
    });
    const replay = await db.eval.createDatasetFromRuntimeTrace({
      source,
      dataset: draft,
      actor_user_id: 'super-test',
      idempotency_key: idempotencyKey,
    });

    expect(first.created).toBe(true);
    expect(replay).toEqual({ dataset: first.dataset, created: false });
    expect(first.dataset).toMatchObject({
      question: draft.question,
      ground_truth: JSON.stringify([draft.ground_truth]),
      source: 'agent',
      source_session_id: source.session_id,
      created_by: 'super-test',
    });
    expect(first.dataset.notes).toContain('[runtime-trace:v1]');
    expect(first.dataset.notes).toContain(`"runtime_run_id":"${source.runtime_run_id}"`);
    expect(first.dataset.notes).toContain(draft.notes);

    const edited = await db.eval.updateDataset(first.dataset.id, { notes: 'Updated operator note' });
    expect(edited?.notes).toContain(`"runtime_run_id":"${source.runtime_run_id}"`);
    expect(edited?.notes).toContain('Updated operator note');
  });

  it('rejects reusing a capture key with changed content', async () => {
    const idempotencyKey = `trace-conflict:${Date.now()}:${Math.random()}`;
    await db.eval.createDatasetFromRuntimeTrace({
      source,
      dataset: draft,
      actor_user_id: 'super-test',
      idempotency_key: idempotencyKey,
    });
    await expect(
      db.eval.createDatasetFromRuntimeTrace({
        source,
        dataset: { ...draft, ground_truth: 'Changed after the first submit' },
        actor_user_id: 'super-test',
        idempotency_key: idempotencyKey,
      }),
    ).rejects.toBeInstanceOf(EvalTraceIdempotencyConflictError);
  });
});
