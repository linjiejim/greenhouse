import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvalService } from '@greenhouse/db';
import type { EvalDataset, EvalRun } from '@greenhouse/types/eval';
import { executeRun } from '../../apps/api/src/eval.js';

const dataset: EvalDataset = {
  id: 1,
  category: 'regression',
  difficulty: 'easy',
  question: 'test question',
  ground_truth: '[]',
  expected_behavior: null,
  tags: '[]',
  language: 'en',
  is_negative: 0,
  enabled: 1,
  created_by: null,
  updated_by: null,
  source: 'manual',
  source_session_id: null,
  status: 'active',
  notes: null,
  archived_at: null,
  created_at: '2026-07-21T00:00:00.000Z',
  updated_at: '2026-07-21T00:00:00.000Z',
};

const runningRun: EvalRun = {
  id: 'run-1',
  name: null,
  status: 'running',
  total: 1,
  completed: 0,
  passed: 0,
  failed: 0,
  avg_score: null,
  avg_accuracy: null,
  avg_completeness: null,
  avg_relevance: null,
  avg_speed: null,
  model: 'flash',
  profile_id: 'team',
  config: '{}',
  started_at: '2026-07-21T00:00:00.000Z',
  finished_at: null,
  created_at: '2026-07-21T00:00:00.000Z',
};

describe('executeRun model metadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records the target profile registry model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const createRun = vi.fn(async () => runningRun);
    const repo = {
      listDatasets: vi.fn(async () => [dataset]),
      createRun,
      createResult: vi.fn(async () => 1),
      updateResult: vi.fn(async () => null),
      updateRunProgress: vi.fn(async () => null),
      finalizeRun: vi.fn(async () => ({ ...runningRun, status: 'completed', completed: 1 })),
    } as unknown as EvalService;

    await executeRun(repo, {
      accessToken: 'test-token',
      userId: 'test-user',
      profileId: 'team',
      concurrency: 1,
      apiBase: 'http://invalid.local',
    });

    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ model: 'flash', profileId: 'sprouty' }));
  });
});
