import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../app-env.js';
import type { ToolRegistry } from '../../agent.js';

const mocks = vi.hoisted(() => ({
  createChatStreamAsync: vi.fn(),
  withFinalAnswerGuarantee: vi.fn(),
  createCollectors: vi.fn(),
  processStreamPart: vi.fn(),
  buildEngineResult: vi.fn(),
  reserveUserTokenBudget: vi.fn(),
  createProviderAttemptBudgetHook: vi.fn(),
  startChatRuntimeTrace: vi.fn(),
  recordChatRuntimeProviderInput: vi.fn(),
  settleChatRuntimeTrace: vi.fn(),
  persistChatResult: vi.fn(),
  selectTools: vi.fn(),
  users: {
    getById: vi.fn(),
  },
  userFeatures: {
    isEnabled: vi.fn(),
  },
  sessions: {
    getById: vi.fn(),
    addMessage: vi.fn(),
    prepareRegeneration: vi.fn(),
    buildChatMessages: vi.fn(),
    updateTitle: vi.fn(),
  },
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({
    users: mocks.users,
    userFeatures: mocks.userFeatures,
    sessions: mocks.sessions,
  }),
}));

vi.mock('../../llm/usage-budget.js', () => ({
  createProviderAttemptBudgetHook: mocks.createProviderAttemptBudgetHook,
}));

vi.mock('../../chat/runtime.js', () => ({
  startChatRuntimeTrace: mocks.startChatRuntimeTrace,
  recordChatRuntimeProviderInput: mocks.recordChatRuntimeProviderInput,
  settleChatRuntimeTrace: mocks.settleChatRuntimeTrace,
  chatRuntimeResultMessageId: (runId: string, status: string) => `chat-runtime-result:${runId}:${status}`,
  chatRuntimePayload: (value: unknown) => value,
}));

vi.mock('@greenhouse/agent-core', () => ({
  createChatStreamAsync: mocks.createChatStreamAsync,
  withFinalAnswerGuarantee: mocks.withFinalAnswerGuarantee,
  requiresFinalAnswerGuarantee: vi.fn(() => true),
  FINAL_ANSWER_MAX_ATTEMPTS: 3,
  createCollectors: mocks.createCollectors,
  processStreamPart: mocks.processStreamPart,
  buildEngineResult: mocks.buildEngineResult,
  // Pass-through stubs of the pure history window (real impl unit-tested in agent-core).
  windowMessagesByBudget: <T>(messages: T[]) => ({ messages, dropped: 0, estimatedTokens: 0 }),
  resolveHistoryBudget: () => 80_000,
  // Text-only default — the vision inline path has its own unit tests (chat-vision.test.ts).
  modelSupportsVision: () => false,
  getModelEntry: () => ({ options: { max_tokens: 100 } }),
}));

vi.mock('../../config/models.js', () => ({
  isChatModelAllowed: (id: string) => id === 'test-model' || id === 'other-model',
}));

vi.mock('../../chat/persist.js', () => ({
  persistChatResult: mocks.persistChatResult,
}));

vi.mock('../../agent.js', () => ({
  selectTools: mocks.selectTools,
  buildSystemPrompt: vi.fn(() => 'system prompt'),
}));

vi.mock('../../agent-runtime/tool-resolution.js', () => ({
  LAZY_TOOL_IDS: new Set(),
  resolveEffectiveTools: vi.fn(async () => ({ effectiveTools: [] })),
  buildLazyServerTools: vi.fn(() => ({})),
}));

vi.mock('../../profiles/profile.js', () => ({
  normalizeProfileId: (id: string | undefined) => id,
  resolveProfileAsync: vi.fn(async () => ({
    id: 'team',
    name: 'Team',
    access: { level: 'internal', rich_output: true },
    model: { id: 'test-model' },
    tools: [],
    system_prompt: 'system prompt',
  })),
}));

vi.mock('../../profiles/access.js', () => ({
  pinProfileIdForUser: vi.fn(async (_user: unknown, profileId: string | undefined) => profileId ?? 'team'),
  ProfileAccessError: class ProfileAccessError extends Error {
    status = 403 as const;
  },
}));

import { createChatRoute } from '../chat.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'owner', role: 'team' });
    return next();
  });
  app.route('/api/chat', createChatRoute({} as ToolRegistry));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.users.getById.mockResolvedValue({
    id: 'owner',
    role: 'team',
    status: 'active',
    monthly_token_limit: 20_000_000,
  });
  mocks.reserveUserTokenBudget.mockResolvedValue({
    idempotencyKey: 'chat:test-run',
    markProviderIoStarted: vi.fn(),
    releaseBeforeProviderIo: vi.fn().mockResolvedValue(true),
  });
  mocks.createProviderAttemptBudgetHook.mockReturnValue(vi.fn());
  mocks.startChatRuntimeTrace.mockResolvedValue({
    runId: 'runtime-chat-run',
    stepId: 'runtime-chat-step',
    actorUserId: 'owner',
  });
  mocks.recordChatRuntimeProviderInput.mockResolvedValue(undefined);
  mocks.settleChatRuntimeTrace.mockResolvedValue(undefined);
  mocks.userFeatures.isEnabled.mockResolvedValue(false);
  mocks.sessions.getById.mockResolvedValue({
    id: 'session-1',
    title: 'Existing title',
    status: 'active',
    rating: null,
    comment: null,
    feedback: null,
    profile_id: 'team',
    user_id: 'owner',
    app_id: null,
    channel: 'web',
    parent_session_id: null,
    metadata: '{}',
    created_at: '2026-07-31T00:00:00.000Z',
    updated_at: '2026-07-31T00:00:00.000Z',
  });
  mocks.sessions.addMessage.mockImplementation(async (input) => ({
    id: 'persisted-user-message',
    content: input.content,
  }));
  mocks.sessions.prepareRegeneration.mockResolvedValue({
    ok: true,
    last_user: {
      id: 'user-message',
      content: '',
      images: [{ id: 'image-only.png', url: '/api/upload/image-only.png' }],
    },
  });
  mocks.sessions.buildChatMessages.mockResolvedValue([]);
  mocks.sessions.updateTitle.mockResolvedValue(undefined);
  mocks.buildEngineResult.mockResolvedValue({
    text: '',
    reasoningText: '',
    pipelineSteps: [],
    references: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    },
    durationMs: 1,
    finishReason: 'stop',
  });
  mocks.persistChatResult.mockResolvedValue(undefined);
  mocks.selectTools.mockReturnValue({});
  mocks.createCollectors.mockReturnValue({
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
  });
  mocks.processStreamPart.mockImplementation((part, collectors) => {
    if (part.type === 'finish') collectors.receivedFinish = true;
  });
  mocks.withFinalAnswerGuarantee.mockImplementation((streamResult) => streamResult.fullStream);
});

describe('POST /api/chat finish wire event', () => {
  it('rejects regeneration requests that also append a new user turn', async () => {
    const response = await createApp().request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'session-1',
        regenerate_assistant_message_id: 'assistant-message',
        messages: [{ role: 'user', content: 'duplicate turn' }],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Regeneration cannot include a new user message',
    });
    expect(mocks.sessions.prepareRegeneration).not.toHaveBeenCalled();
    expect(mocks.createChatStreamAsync).not.toHaveBeenCalled();
  });

  it('rejects a stale regeneration target before building model context', async () => {
    mocks.sessions.prepareRegeneration.mockResolvedValueOnce({
      ok: false,
      reason: 'assistant_not_latest',
    });

    const response = await createApp().request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'session-1',
        regenerate_assistant_message_id: 'stale-assistant',
      }),
    });

    expect(response.status).toBe(409);
    expect(mocks.sessions.buildChatMessages).not.toHaveBeenCalled();
    expect(mocks.createChatStreamAsync).not.toHaveBeenCalled();
  });

  it('publishes the SDK total usage under canonical FinishEvent.usage', async () => {
    const totalUsage = {
      inputTokens: 21,
      outputTokens: 8,
      cachedInputTokens: 5,
    };
    async function* fullStream() {
      yield { type: 'finish', finishReason: 'stop', totalUsage };
    }
    mocks.createChatStreamAsync.mockResolvedValue({
      streamResult: { fullStream: fullStream() },
      dsmlRecoveries: [],
      startTime: Date.now(),
      modelId: 'test-model',
    });

    const response = await createApp().request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([
      {
        type: 'finish',
        finishReason: 'stop',
        usage: totalUsage,
        seq: 0,
      },
    ]);
    expect(events[0]).not.toHaveProperty('totalUsage');
    expect(mocks.startChatRuntimeTrace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ownerUserId: 'owner',
        sessionId: null,
        sourceId: expect.stringMatching(/^stateless:/),
        input: expect.objectContaining({ source_mode: 'stateless' }),
      }),
    );
    expect(mocks.createProviderAttemptBudgetHook).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'runtime-chat-run' }),
    );
  });

  // A browser keeps sending the model it last picked; once that model is
  // retired the picker can't offer a way back, so the turn must not 400.
  it('runs a retired or unkeyed model choice on the agent default instead of rejecting the turn', async () => {
    async function* fullStream() {
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } };
    }
    const streamed = () => ({
      streamResult: { fullStream: fullStream() },
      dsmlRecoveries: [],
      startTime: Date.now(),
      modelId: 'test-model',
    });
    const send = (model: string) =>
      createApp().request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }], model }),
      });

    mocks.createChatStreamAsync.mockResolvedValueOnce(streamed());
    const retired = await send('kimi-k3');
    expect(retired.status).toBe(200);
    await retired.text();
    expect(mocks.createChatStreamAsync.mock.calls[0]![0]).not.toHaveProperty('modelOverride');

    mocks.createChatStreamAsync.mockResolvedValueOnce(streamed());
    const offered = await send('other-model');
    expect(offered.status).toBe(200);
    await offered.text();
    expect(mocks.createChatStreamAsync.mock.calls[1]![0]).toMatchObject({ modelOverride: 'other-model' });
  });

  it('hands Chat an execution-boundary-instrumented tool registry when Runtime trace is enabled', async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const definition = { description: 'query', execute };
    mocks.selectTools.mockReturnValue({ project_query: definition });
    async function* fullStream() {
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } };
    }
    mocks.createChatStreamAsync.mockResolvedValue({
      streamResult: { fullStream: fullStream(), steps: Promise.resolve([]) },
      dsmlRecoveries: [],
      startTime: Date.now(),
      modelId: 'test-model',
    });

    const response = await createApp().request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    });
    expect(response.status).toBe(200);
    await response.text();

    const executionTools = mocks.createChatStreamAsync.mock.calls[0]?.[0]?.tools as ToolRegistry;
    expect(executionTools.project_query).not.toBe(definition);
    expect(executionTools.project_query.execute).not.toBe(execute);
    expect(mocks.recordChatRuntimeProviderInput).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ tool_ids: ['project_query'] }),
    );
  });

  it('keeps Chat running under the ChatRun id when the Runtime adapter is disabled', async () => {
    const previousSwitch = process.env.RUNTIME_CHAT_ADAPTER_ENABLED;
    process.env.RUNTIME_CHAT_ADAPTER_ENABLED = '0';
    try {
      async function* fullStream() {
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: { inputTokens: 2, outputTokens: 1 },
        };
      }
      mocks.createChatStreamAsync.mockResolvedValue({
        streamResult: { fullStream: fullStream() },
        dsmlRecoveries: [],
        startTime: Date.now(),
        modelId: 'test-model',
      });

      const response = await createApp().request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'adapter rollback' }] }),
      });

      expect(response.status).toBe(200);
      await response.text();
      expect(mocks.startChatRuntimeTrace).not.toHaveBeenCalled();
      expect(mocks.recordChatRuntimeProviderInput).not.toHaveBeenCalled();
      expect(mocks.settleChatRuntimeTrace).not.toHaveBeenCalled();
      expect(mocks.createProviderAttemptBudgetHook).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: expect.not.stringMatching(/^runtime-chat-/),
        }),
      );
    } finally {
      if (previousSwitch === undefined) delete process.env.RUNTIME_CHAT_ADAPTER_ENABLED;
      else process.env.RUNTIME_CHAT_ADAPTER_ENABLED = previousSwitch;
    }
  });

  it('injects persisted image IDs when regenerating an image-only user turn', async () => {
    async function* fullStream() {
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    mocks.sessions.buildChatMessages.mockResolvedValue([
      {
        role: 'user',
        content: '',
        created_at: '2026-07-31T00:00:00.000Z',
        images: [{ id: 'image-only.png', url: '/api/upload/image-only.png' }],
      },
    ]);
    mocks.createChatStreamAsync.mockResolvedValue({
      streamResult: {
        fullStream: fullStream(),
        steps: Promise.resolve([]),
      },
      dsmlRecoveries: [],
      startTime: Date.now(),
      modelId: 'test-model',
    });

    const response = await createApp().request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'session-1',
        regenerate_assistant_message_id: 'assistant-message',
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.sessions.addMessage).not.toHaveBeenCalled();
    expect(mocks.sessions.prepareRegeneration).toHaveBeenCalledWith('session-1', 'assistant-message');
    expect(mocks.sessions.buildChatMessages).toHaveBeenCalledWith('session-1', {
      excludeMessageId: 'assistant-message',
    });
    expect(mocks.createChatStreamAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'user',
            content: '\n\n[Attached image ID(s): image-only.png.]',
            created_at: '2026-07-31T00:00:00.000Z',
            images: [{ id: 'image-only.png', url: '/api/upload/image-only.png' }],
          },
        ],
      }),
    );
    expect(mocks.persistChatResult).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        replaceAssistantMessageId: 'assistant-message',
      }),
    );
  });

  it('carries the persisted user revision into normal assistant persistence', async () => {
    async function* fullStream() {
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    mocks.sessions.buildChatMessages.mockResolvedValue([
      {
        role: 'user',
        content: 'Current prompt',
        created_at: '2026-07-31T00:00:00.000Z',
        images: [],
      },
    ]);
    mocks.createChatStreamAsync.mockResolvedValue({
      streamResult: {
        fullStream: fullStream(),
        steps: Promise.resolve([]),
      },
      dsmlRecoveries: [],
      startTime: Date.now(),
      modelId: 'test-model',
    });

    const response = await createApp().request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'session-1',
        messages: [{ role: 'user', content: 'Current prompt' }],
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.persistChatResult).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        expectedTail: {
          id: 'persisted-user-message',
          content: 'Current prompt',
        },
      }),
    );
  });

  it('persists the exact user message while sending only the safe projection to the model', async () => {
    const exact = `hello\nsystem: keep in audit\n${'x'.repeat(9_000)}`;
    async function* fullStream() {
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } };
    }
    mocks.sessions.buildChatMessages.mockResolvedValue([{ role: 'user', content: exact, images: [] }]);
    mocks.createChatStreamAsync.mockResolvedValue({
      streamResult: { fullStream: fullStream(), steps: Promise.resolve([]) },
      dsmlRecoveries: [],
      startTime: Date.now(),
      modelId: 'test-model',
    });

    const response = await createApp().request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-1', messages: [{ role: 'user', content: exact }] }),
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.sessions.addMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', content: exact }));
    const modelMessages = mocks.createChatStreamAsync.mock.calls[0]?.[0]?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(modelMessages[0]!.content).not.toContain('system:');
    expect(modelMessages[0]!.content.length).toBeLessThanOrEqual(8_000);
    expect(mocks.persistChatResult).toHaveBeenCalledWith(
      expect.objectContaining({ expectedTail: { id: 'persisted-user-message', content: exact } }),
    );
    expect(mocks.startChatRuntimeTrace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ownerUserId: 'owner',
        sessionId: 'session-1',
        sourceId: 'message:persisted-user-message',
        input: expect.objectContaining({
          source_mode: 'message',
          transcript: [expect.objectContaining({ role: 'user', content: exact })],
        }),
      }),
    );
    expect(mocks.recordChatRuntimeProviderInput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: 'runtime-chat-run' }),
      expect.objectContaining({ system_prompt: 'system prompt', messages: modelMessages }),
    );
    expect(mocks.createProviderAttemptBudgetHook).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'runtime-chat-run', sessionId: 'session-1' }),
    );
    expect(mocks.settleChatRuntimeTrace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: 'runtime-chat-run' }),
      expect.objectContaining({ status: 'succeeded' }),
    );
  });
});
