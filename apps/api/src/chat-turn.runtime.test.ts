import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engineResult: null as any,
  persistChatResult: vi.fn(),
  settleChatRuntimeTrace: vi.fn(),
  chatRuntimePayload: vi.fn(),
  checkpointChatRuntimeStream: vi.fn(),
  sendToUser: vi.fn(),
}));

vi.mock('@greenhouse/db', () => ({ getDb: () => ({}) }));

vi.mock('@greenhouse/agent-core', () => ({
  withFinalAnswerGuarantee: (streamResult: { fullStream: AsyncIterable<unknown> }) => streamResult.fullStream,
  processStreamPart: (part: any, collectors: any) => {
    if (part.type === 'finish') collectors.receivedFinish = true;
    if (part.type === 'error') collectors.streamError = String(part.error ?? 'stream error');
    if (part.type === 'abort') collectors.streamError = 'Chat generation aborted before completion';
  },
  buildEngineResult: vi.fn(async () => mocks.engineResult),
}));

vi.mock('./chat-persist.js', () => ({ persistChatResult: mocks.persistChatResult }));

vi.mock('./chat-runtime.js', () => ({
  chatRuntimeResultMessageId: (runId: string, status: string) => `chat-runtime-result:${runId}:${status}`,
  chatRuntimePayload: mocks.chatRuntimePayload,
  checkpointChatRuntimeStream: mocks.checkpointChatRuntimeStream,
  settleChatRuntimeTrace: mocks.settleChatRuntimeTrace,
}));

vi.mock('./ws/connection-manager.js', () => ({
  connectionManager: { sendToUser: mocks.sendToUser },
}));

import { ChatRun } from './chat-runs.js';
import { pumpChatTurn } from './chat-turn.js';
import { UsageBudgetAdmissionError } from './llm/usage-budget.js';

function collectors() {
  return {
    fullText: '',
    reasoningText: '',
    pipelineSteps: [],
    referencesMap: new Map(),
    searchRelevance: new Map(),
    stepStartTime: Date.now(),
    activeToolInputs: new Map(),
    receivedFinish: false,
    streamError: undefined,
    streamCompleted: false,
  };
}

function engineResult(overrides: Record<string, unknown> = {}) {
  return {
    text: 'done',
    reasoningText: 'full reasoning',
    finishReason: 'stop',
    usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, reasoningTokens: 2 },
    pipelineSteps: [
      { step: 1, tool: 'example_tool', input: { exact: true }, output: { compact: true }, duration_ms: 9 },
    ],
    references: [],
    durationMs: 42,
    dsmlRecoveries: [],
    ...overrides,
  };
}

async function runPump(run: ChatRun, parts: unknown[]) {
  async function* fullStream() {
    for (const part of parts) yield part;
  }
  await pumpChatTurn({
    run,
    streamResult: { fullStream: fullStream(), steps: Promise.resolve([]) } as any,
    collectors: collectors(),
    dsmlRecoveries: [],
    startTime: Date.now(),
    modelId: 'test-model',
    profile: { id: 'team', model: { id: 'test-model' }, access: { level: 'internal' } } as any,
    systemPrompt: 'system',
    chatMessages: [{ role: 'user', content: 'hello' }],
    sessionId: 'session-1',
    userId: 'user-1',
    titlePromise: null,
    clientActionBridge: null,
    providerAttemptHook: vi.fn(),
    runtimeTrace: { runId: 'runtime-run', stepId: 'runtime-step', actorUserId: 'user-1' },
  });
}

describe('Chat turn Runtime settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.engineResult = engineResult();
    mocks.persistChatResult.mockResolvedValue(undefined);
    mocks.settleChatRuntimeTrace.mockResolvedValue(undefined);
    mocks.checkpointChatRuntimeStream.mockResolvedValue(undefined);
    mocks.chatRuntimePayload.mockImplementation((value) => value);
  });

  it('settles succeeded with complete raw tool input/output instead of the compact transcript projection', async () => {
    const fullOutput = { content: 'x'.repeat(20_000), nested: { keep: ['all', 'fields'] } };
    await runPump(new ChatRun('session-1', 'user-1'), [
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'example_tool', input: { query: 'exact input' } },
      { type: 'tool-result', toolCallId: 'call-1', toolName: 'example_tool', output: fullOutput },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 11, outputTokens: 7 } },
    ]);

    expect(mocks.settleChatRuntimeTrace).toHaveBeenCalledWith(
      expect.anything(),
      { runId: 'runtime-run', stepId: 'runtime-step', actorUserId: 'user-1' },
      expect.objectContaining({
        status: 'succeeded',
        tokensUsed: 18,
        output: expect.objectContaining({
          raw_tool_evidence: [
            expect.objectContaining({ type: 'tool-call', input: { query: 'exact input' } }),
            expect.objectContaining({ type: 'tool-result', output: fullOutput }),
          ],
        }),
      }),
    );
  });

  it('maps an explicit user stop to canceled', async () => {
    const run = new ChatRun('session-1', 'user-1');
    run.requestStop('user');
    mocks.engineResult = engineResult({ finishReason: undefined });

    await runPump(run, [{ type: 'abort' }]);

    expect(mocks.settleChatRuntimeTrace).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ status: 'canceled', errorCode: 'chat_user_canceled' }),
    );
  });

  it('marks an uncompleted stream interrupted and never asks Runtime to replay it', async () => {
    mocks.engineResult = engineResult({ finishReason: undefined });

    await runPump(new ChatRun('session-1', 'user-1'), [{ type: 'error', error: 'connection reset' }]);

    expect(mocks.settleChatRuntimeTrace).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ status: 'interrupted', errorCode: 'chat_stream_interrupted' }),
    );
  });

  it('tells the user a budget refusal is a budget refusal instead of asking them to retry', async () => {
    mocks.engineResult = engineResult({ finishReason: undefined });
    const run = new ChatRun('session-1', 'user-1');
    const events: Array<Record<string, unknown>> = [];
    run.subscribe(0, { onEvent: (event) => events.push(event), onEnd: () => {} });

    await runPump(run, [
      {
        type: 'error',
        // The SDK wraps provider-attempt failures before they reach fullStream.
        error: new Error('retry limit', {
          cause: new UsageBudgetAdmissionError(
            'Monthly token budget exceeded. Contact an administrator to increase the limit.',
            429,
            'usage_budget_exceeded',
          ),
        }),
      },
    ]);

    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent?.error).toContain('额度已用尽');
    expect(errorEvent?.error).not.toContain('请重试');
    // The persisted transcript must say the same thing as the live stream.
    expect(mocks.persistChatResult).toHaveBeenCalledWith(
      expect.objectContaining({ interruptionNotice: errorEvent?.error }),
    );
  });

  it('still collapses an ordinary stream failure to the generic notice', async () => {
    mocks.engineResult = engineResult({ finishReason: undefined });
    const run = new ChatRun('session-1', 'user-1');
    const events: Array<Record<string, unknown>> = [];
    run.subscribe(0, { onEvent: (event) => events.push(event), onEnd: () => {} });

    await runPump(run, [{ type: 'error', error: new Error('upstream 502 from provider host') }]);

    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent?.error).toContain('请重试');
    expect(errorEvent?.error).not.toContain('provider host');
  });

  it('fails terminally when complete Runtime evidence is not JSON-serializable', async () => {
    mocks.chatRuntimePayload.mockImplementationOnce(() => {
      throw new Error('non-json evidence');
    });

    await runPump(new ChatRun('session-1', 'user-1'), [
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 11, outputTokens: 7 } },
    ]);

    expect(mocks.settleChatRuntimeTrace).toHaveBeenCalledTimes(1);
    expect(mocks.settleChatRuntimeTrace).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        status: 'failed',
        errorCode: 'chat_runtime_terminalization_failed',
        output: expect.objectContaining({ stage: 'runtime_terminal_evidence' }),
      }),
    );
  });
});
