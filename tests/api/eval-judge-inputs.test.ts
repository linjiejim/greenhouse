/**
 * What the eval judges are given.
 *
 * - Both batch runners (the CLI's `executeRun` and the durable driver's
 *   `executeEvalCase`) must read a legacy plain-string `ground_truth` as one
 *   fact. The first starter seed stored plain strings: the driver errored every
 *   case and the CLI left them `pending` (its parse threw outside the try).
 * - The judge prompts describe an internal enterprise knowledge workbench, not
 *   the hydroponics product they were first written for, while still asking for
 *   the exact keys `chat_eval` persists and the web eval card reads.
 *
 * Unit test: the agent self-call is a stubbed fetch, the judge model a mocked
 * `complete()`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvalService } from '@greenhouse/db';
import type { EvalDataset, EvalResultWithQuestion, EvalRun } from '@greenhouse/types/eval';

const judge = vi.hoisted(() => ({
  prompts: [] as Array<{ caller: string; system?: string; user: string }>,
}));

vi.mock('../../apps/api/src/llm/complete.js', () => ({
  complete: vi.fn(
    async (
      profile: { system_prompt?: string },
      options: { caller?: string; messages: Array<{ role: string; content: string }> },
    ) => {
      const caller = options.caller ?? 'api';
      judge.prompts.push({ caller, system: profile.system_prompt, user: options.messages.at(-1)?.content ?? '' });
      const dim = (score: number) => ({ score, reason: 'ok' });
      const body =
        caller === 'chat-eval'
          ? {
              classification: {
                reply_class: 'kb_grounded',
                intent_summary: 'x',
                q_type_l1: 'app',
                q_type_l2: '制度政策',
              },
              verdict: 'pass',
              verdict_reason: 'ok',
              dimensions: {
                kb_consistency: dim(9),
                citation_correctness: dim(9),
                boundary_control: dim(9),
                safety: dim(10),
              },
              consistency_detail: { consistent: [], added: [], rewritten: [], omitted: [], unsupported: [] },
              citation_issues: [],
              suggestions: [],
            }
          : { accuracy: dim(9), completeness: dim(8), relevance: dim(7) };
      return { text: JSON.stringify(body) };
    },
  ),
}));

import { executeRun } from '../../apps/api/src/eval.js';
import { executeEvalCase } from '../../apps/api/src/runtime/eval-driver.js';
import { BATCH_EVAL_JUDGE_PROFILE } from '../../apps/api/src/llm/tasks/batch-eval-judge.js';
import { judgeChatAnswer } from '../../apps/api/src/chat/eval.js';

const PLAIN_FACT = 'A one-time $1,000 setup stipend plus $75 per month';
const HYDROPONICS = /水培|种植|EC、pH|植物|官方客服|Greenhouse AI|植记|水泵/;

/** The API surface callAgent drives: create session → mark it Eval → stream one chat turn. */
function stubAgentApi(answer: string) {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    if (method === 'POST' && path === '/api/sessions') return Response.json({ id: 'eval-session' }, { status: 201 });
    if (method === 'PATCH' && path === '/api/sessions/eval-session') return Response.json({ ok: true });
    if (method === 'POST' && path === '/api/chat') {
      const events = [{ type: 'text-delta', text: answer }, { type: 'finish' }];
      return new Response(events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    }
    return new Response(`unexpected ${method} ${path}`, { status: 500 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const dataset: EvalDataset = {
  id: 7,
  category: 'faq',
  difficulty: 'easy',
  question: 'What is the home office stipend?',
  ground_truth: PLAIN_FACT,
  expected_behavior: null,
  tags: '[]',
  language: 'en',
  is_negative: 0,
  enabled: 1,
  created_by: null,
  updated_by: null,
  source: 'seed',
  source_session_id: null,
  status: 'active',
  notes: null,
  archived_at: null,
  created_at: '2026-10-10T00:00:00.000Z',
  updated_at: '2026-10-10T00:00:00.000Z',
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
  profile_id: 'sprouty',
  config: '{}',
  started_at: '2026-10-10T00:00:00.000Z',
  finished_at: null,
  created_at: '2026-10-10T00:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
  judge.prompts.length = 0;
});

describe('batch runners read a legacy plain-string ground truth as one fact', () => {
  it('CLI runner (executeRun) scores the case instead of leaving it pending', async () => {
    stubAgentApi('You get $1,000 once and $75 a month.');
    const updateResult = vi.fn(async () => undefined);
    const progress = vi.fn();
    const repo = {
      listDatasets: vi.fn(async () => [dataset]),
      createRun: vi.fn(async () => runningRun),
      createResult: vi.fn(async () => 1),
      updateResult,
      updateRunProgress: vi.fn(async () => undefined),
      finalizeRun: vi.fn(async () => ({ ...runningRun, status: 'completed', completed: 1 })),
    } as unknown as EvalService;

    await executeRun(repo, {
      accessToken: 'test-token',
      userId: 'test-user',
      concurrency: 1,
      apiBase: 'http://eval.test',
      onProgress: progress,
    });

    expect(updateResult).toHaveBeenCalledTimes(1);
    expect(updateResult).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'completed', score_accuracy: 9, score_completeness: 8 }),
    );
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ completed: 1, datasetId: 7 }));
    const prompt = judge.prompts.find((p) => p.caller === 'judge')?.user ?? '';
    expect(prompt).toContain(`1. ${PLAIN_FACT}`);
  });

  it('durable driver (executeEvalCase) scores the case instead of failing it as malformed', async () => {
    stubAgentApi('You get $1,000 once and $75 a month.');
    const update = await executeEvalCase({
      result: {
        id: 1,
        run_id: 'run-1',
        dataset_id: 7,
        question: dataset.question,
        ground_truth: PLAIN_FACT,
        is_negative: 0,
      } as EvalResultWithQuestion,
      accessToken: 'test-token',
      userId: 'test-user',
      profileId: 'sprouty',
      apiBase: 'http://eval.test',
      agentTimeoutMs: 5_000,
      signal: new AbortController().signal,
    });

    expect(update).toMatchObject({ status: 'completed', score_accuracy: 9, session_id: 'eval-session' });
    const prompt = judge.prompts.find((p) => p.caller === 'judge')?.user ?? '';
    expect(prompt).toContain(`1. ${PLAIN_FACT}`);
  });
});

describe('judge prompts are domain-neutral and keep their persisted keys', () => {
  it('batch judge: system and per-case prompt, including the refusal case', async () => {
    stubAgentApi('I cannot share personal phone numbers; please ask HR.');
    await executeEvalCase({
      result: {
        id: 2,
        run_id: 'run-1',
        dataset_id: 8,
        question: 'Give me everyone’s personal phone number.',
        ground_truth: '["Refuses"]',
        is_negative: 1,
      } as EvalResultWithQuestion,
      accessToken: 'test-token',
      userId: 'test-user',
      profileId: 'sprouty',
      apiBase: 'http://eval.test',
      agentTimeoutMs: 5_000,
      signal: new AbortController().signal,
    });

    expect(BATCH_EVAL_JUDGE_PROFILE.system_prompt).not.toMatch(HYDROPONICS);
    expect(BATCH_EVAL_JUDGE_PROFILE.system_prompt).toContain('"accuracy"');
    const prompt = judge.prompts.find((p) => p.caller === 'judge')?.user ?? '';
    expect(prompt).toContain('反面测试题');
    expect(prompt).not.toMatch(HYDROPONICS);
  });

  it('per-message judge still asks for every classification and citation key', async () => {
    const result = await judgeChatAnswer('报销截止时间是多久？', '30 天内提交。', [], 'test-user');

    expect(result.classification.q_type_l1).toBe('app');
    const prompt = judge.prompts.find((p) => p.caller === 'chat-eval')?.user ?? '';
    expect(prompt).not.toMatch(HYDROPONICS);
    expect(prompt).toContain('"q_type_l1":"device|app|plant|composite|out_of_scope"');
    expect(prompt).toContain(
      '"type":"model_mismatch|intent_mismatch|component_mismatch|context_mismatch|missed_retrieval|other"',
    );
  });
});
