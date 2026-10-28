/**
 * Tests for the headless runner's pipeline extraction.
 *
 * Regression guard for the "empty tool results" bug: a headless (scheduled)
 * session persists its tool calls via extractPipelineAndReferences,
 * and the chat UI renders straight from that persisted `output`. Two ways it
 * silently went blank:
 *   1. it read the AI SDK v4 step fields (`args`/`result`) while the project is
 *      on v6 (`input`/`output`) → every output came through as `{}`;
 *   2. its local summarizeOutput collapsed non-whitelisted tools to
 *      `{ keys: [...] }`, dropping the real payload the UI needs.
 * Both are fixed by reading the v6 fields and reusing the canonical
 * summarizeOutput (whose default returns the full output).
 */

import { fakeMeteringServices, routeReserve } from './../../../../../tests/helpers/metering-db.js';
import { describe, it, expect, vi } from 'vitest';
import { extractPipelineAndReferences, runAgentInSession } from './../run-agent.js';

/** A single AI SDK v6 step with one tool call + its result. */
function v6Step(toolName: string, input: unknown, output: unknown) {
  return {
    toolCalls: [{ toolCallId: 'call_1', toolName, input }],
    toolResults: [{ toolCallId: 'call_1', toolName, output }],
  };
}

describe('extractPipelineAndReferences', () => {
  it('keeps the FULL output of a non-whitelisted tool (v6 input/output fields)', () => {
    const output = { query: 'shenzhen weather', resultCount: 5, provider: 'tavily', results: [{ title: 'x' }] };
    const { pipeline } = extractPipelineAndReferences([
      v6Step('external_search', { query: 'shenzhen weather' }, output),
    ]);

    expect(pipeline).toHaveLength(1);
    expect(pipeline[0].tool).toBe('external_search');
    // The bug surfaced as output:{} (v4 field read) or output:{keys:[]} (lossy default).
    expect(pipeline[0].output).toEqual(output);
    expect(pipeline[0].input).toEqual({ query: 'shenzhen weather' });
  });

  /**
   * knowledge_query is the KB read surface, and its output carries no top-level
   * `action` — so it is summarized by SHAPE. Without a case in summarizeOutput
   * it fell to `default: return output`, and every document read wrote its full
   * body into messages.pipeline. That was cheap to miss while it was one of
   * three KB tools; it became the only one on 2026-08-14.
   */
});

describe('runAgentInSession transcript persistence', () => {
  const usageContext = { profileId: 'sprouty', userId: 'owner-1', caller: 'scheduled-task' };

  function createRunnerFixture(options: { tailContent?: string; appendOk?: boolean } = {}) {
    const getLatestMessage = vi.fn().mockResolvedValue({
      id: 'user-message',
      role: 'user',
      content: options.tailContent ?? 'Current prompt',
    });
    const appendAssistantIfTail = vi
      .fn()
      .mockResolvedValue(
        options.appendOk === false
          ? { ok: false, reason: 'transcript_changed' }
          : { ok: true, message: { id: 'assistant-message' } },
      );
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const tokenReserve = vi.fn().mockResolvedValue([]);
    const settleBudget = vi.fn().mockResolvedValue([]);
    const generate = vi.fn().mockResolvedValue({
      text: 'Generated answer',
      usage: { inputTokens: 4, outputTokens: 2 },
      steps: [],
    });
    const metered = fakeMeteringServices();
    const db = {
      sessions: {
        getLatestMessage,
        appendAssistantIfTail,
      },
      usage: { record: recordUsage },
      usageBudget: {
        settle: settleBudget,
        release: vi.fn().mockResolvedValue([]),
        ensureAccount: metered.ensureAccount,
        reserve: routeReserve(tokenReserve, metered.reserve),
      },
      metering: metered.metering,
      users: {
        getById: vi.fn().mockResolvedValue({
          id: 'owner-1',
          role: 'team',
          status: 'active',
        }),
      },
    };
    return { appendAssistantIfTail, db, generate, getLatestMessage, recordUsage, tokenReserve, settleBudget };
  }

  it('counts every executed tool under its client and never fails the run on a lost count', async () => {
    const fixture = createRunnerFixture();
    const increment = vi.fn().mockRejectedValueOnce(new Error('counter table locked')).mockResolvedValue(undefined);
    (fixture.db as Record<string, unknown>).usageCounters = { increment };
    const toolExecute = vi.fn().mockResolvedValue({ docs: 1 });
    fixture.generate.mockImplementation(
      async (args: { tools?: Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }> }) => {
        await args.tools!.knowledge_query.execute({ action: 'tree' }, { toolCallId: 'c1', messages: [] });
        await args.tools!.knowledge_query.execute({ action: 'tree' }, { toolCallId: 'c2', messages: [] });
        return { text: 'Generated answer', usage: { inputTokens: 4, outputTokens: 2 }, steps: [] };
      },
    );

    const result = await runAgentInSession({
      db: fixture.db as never,
      sessionId: 'session-1',
      system: 'System',
      prompt: 'Current prompt',
      modelConfig: {} as never,
      tools: { knowledge_query: { execute: toolExecute } },
      maxSteps: 2,
      generate: fixture.generate,
      toolCallClient: 'automation',
      usageContext,
    });

    expect(result.persisted).toBe(true);
    expect(toolExecute).toHaveBeenCalledTimes(2);
    expect(increment).toHaveBeenCalledTimes(2);
    expect(increment).toHaveBeenCalledWith('tool_call', 'knowledge_query', 'automation');
  });
  it('persists through the same exact-tail CAS as streaming chat', async () => {
    const fixture = createRunnerFixture();

    const result = await runAgentInSession({
      db: fixture.db as never,
      sessionId: 'session-1',
      system: 'System',
      prompt: 'Current prompt',
      modelConfig: {} as never,
      maxSteps: 2,
      generate: fixture.generate,
      toolCallClient: 'automation',
      usageContext,
    });

    expect(result.persisted).toBe(true);
    expect(fixture.appendAssistantIfTail).toHaveBeenCalledWith(
      'session-1',
      { id: 'user-message', content: 'Current prompt' },
      expect.objectContaining({
        session_id: 'session-1',
        role: 'assistant',
        content: 'Generated answer',
      }),
    );
  });

  it('records which model wrote the reply, like chat does', async () => {
    const fixture = createRunnerFixture();

    await runAgentInSession({
      db: fixture.db as never,
      sessionId: 'session-1',
      system: 'System',
      prompt: 'Current prompt',
      modelConfig: { id: 'deepseek-flash', provider: 'deepseek', model: 'deepseek-chat' } as never,
      maxSteps: 2,
      generate: fixture.generate,
      toolCallClient: 'automation',
      usageContext,
    });

    expect(fixture.appendAssistantIfTail).toHaveBeenCalledWith(
      'session-1',
      expect.anything(),
      expect.objectContaining({ model: 'deepseek-flash' }),
    );
  });

  it('records an llm_usage row attributed to the owning user (headless-accounting contract)', async () => {
    const fixture = createRunnerFixture();

    await runAgentInSession({
      db: fixture.db as never,
      sessionId: 'session-1',
      system: 'System',
      prompt: 'Current prompt',
      modelConfig: { id: 'flash', model: 'deepseek-v4-flash' } as never,
      maxSteps: 2,
      generate: fixture.generate,
      toolCallClient: 'automation',
      usageContext,
    });

    expect(fixture.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        profile_id: 'sprouty',
        caller: 'scheduled-task',
        session_id: 'session-1',
        user_id: 'owner-1',
        model: 'flash',
        input_tokens: 4,
        output_tokens: 2,
        budget_idempotency_key: expect.any(String),
      }),
    );
    expect(fixture.tokenReserve).toHaveBeenCalledBefore(fixture.generate);
    expect(fixture.settleBudget).toHaveBeenCalledWith(expect.objectContaining({ actual_units: 6 }));
  });

  it('never fails the completed run when the statistical usage write fails after budget settlement', async () => {
    const fixture = createRunnerFixture();
    fixture.recordUsage.mockRejectedValue(new Error('usage stats unavailable'));

    const result = await runAgentInSession({
      db: fixture.db as never,
      sessionId: 'session-1',
      system: 'System',
      prompt: 'Current prompt',
      modelConfig: {} as never,
      maxSteps: 2,
      generate: fixture.generate,
      toolCallClient: 'automation',
      usageContext,
    });

    expect(result.persisted).toBe(true);
    expect(fixture.settleBudget).toHaveBeenCalledOnce();
  });

  it('fails closed before generation when budget admission is unavailable', async () => {
    const fixture = createRunnerFixture();
    fixture.db.users.getById.mockRejectedValue(new Error('database unavailable'));

    await expect(
      runAgentInSession({
        db: fixture.db as never,
        sessionId: 'session-1',
        system: 'System',
        prompt: 'Current prompt',
        modelConfig: {} as never,
        maxSteps: 2,
        generate: fixture.generate,
        toolCallClient: 'automation',
        usageContext,
      }),
    ).rejects.toMatchObject({ code: 'usage_budget_unavailable', status: 503 });
    expect(fixture.generate).not.toHaveBeenCalled();
  });

  it('fails the turn without an unconditional append after a concurrent edit', async () => {
    const fixture = createRunnerFixture({ appendOk: false });

    await expect(
      runAgentInSession({
        db: fixture.db as never,
        sessionId: 'session-1',
        system: 'System',
        prompt: 'Current prompt',
        modelConfig: {} as never,
        maxSteps: 2,
        generate: fixture.generate,
        toolCallClient: 'automation',
        usageContext,
      }),
    ).rejects.toMatchObject({ name: 'SessionTranscriptChangedError' });
    expect(fixture.appendAssistantIfTail).toHaveBeenCalledOnce();
  });

  it('does not start generation when the persisted prompt was already edited', async () => {
    const fixture = createRunnerFixture({ tailContent: 'Edited prompt' });

    await expect(
      runAgentInSession({
        db: fixture.db as never,
        sessionId: 'session-1',
        system: 'System',
        prompt: 'Current prompt',
        modelConfig: {} as never,
        maxSteps: 2,
        generate: fixture.generate,
        toolCallClient: 'automation',
        usageContext,
      }),
    ).rejects.toThrow('Session transcript changed before agent generation');
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(fixture.appendAssistantIfTail).not.toHaveBeenCalled();
  });
});
