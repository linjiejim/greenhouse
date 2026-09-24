/**
 * The browser-extension conversation surface, end to end through the real
 * POST /api/chat route: a `browser`-channel session gets no inline writer (its
 * panel's confirm-carded Client Action is the only write path), while the
 * panel's actions and the page it is on do reach the model. Keyed on the
 * session's channel, so the same request on a web session keeps its writers.
 */
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

// The user's full allow-set: reads, proxy-confirmed writers, a writer the proxy
// never sees (memory) and an output-only tool. The filter under test runs on it.
vi.mock('../../agent-runtime/tool-resolution.js', () => ({
  LAZY_TOOL_IDS: new Set(),
  resolveEffectiveTools: vi.fn(async () => ({
    effectiveTools: ['knowledge_query', 'knowledge_mutation', 'project_mutation', 'memory', 'export_data'],
  })),
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

import { buildChatRequestBody, newTurnScopeId } from '../../../../browser/src/lib/chat-request';
import { buildPageAmbientContext } from '../../../../browser/src/lib/page-context';

function sessionOn(channel: string) {
  return {
    id: 'session-1',
    title: 'Existing title',
    status: 'active',
    rating: null,
    comment: null,
    feedback: null,
    profile_id: 'team',
    user_id: 'owner',
    app_id: null,
    channel,
    parent_session_id: null,
    metadata: '{}',
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:00:00.000Z',
  };
}

function panelTurnBody() {
  const scopeId = newTurnScopeId();
  const ambientContext = buildPageAmbientContext(
    {
      tabId: 7,
      url: 'https://example.com/pricing',
      title: 'Pricing',
      selection: 'SELECTED-SNIPPET-42',
      permitted: true,
    },
    scopeId,
  );
  return buildChatRequestBody({
    sessionId: 'session-1',
    message: 'What does this plan cost?',
    scopeId,
    ambientContext,
  });
}

async function sendTurn(body: unknown): Promise<{ tool_ids: string[]; system_prompt: string }> {
  const response = await createApp().request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  await response.text();
  return mocks.recordChatRuntimeProviderInput.mock.calls[0]![2] as { tool_ids: string[]; system_prompt: string };
}

describe('POST /api/chat on the browser-extension channel', () => {
  beforeEach(() => {
    mocks.sessions.buildChatMessages.mockResolvedValue([{ role: 'user', content: 'What does this plan cost?' }]);
    mocks.selectTools.mockImplementation((_registry: unknown, ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, {}])),
    );
    async function* fullStream() {
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } };
    }
    mocks.createChatStreamAsync.mockResolvedValue({
      streamResult: { fullStream: fullStream() },
      dsmlRecoveries: [],
      startTime: Date.now(),
      modelId: 'test-model',
    });
  });

  it('gives a browser session no inline writer, but the panel actions and page context reach the model', async () => {
    mocks.sessions.getById.mockResolvedValue(sessionOn('browser'));

    const { tool_ids, system_prompt } = await sendTurn(panelTurnBody());

    expect(tool_ids).toEqual(expect.arrayContaining(['knowledge_query', 'export_data']));
    for (const writer of ['knowledge_mutation', 'project_mutation', 'memory']) expect(tool_ids).not.toContain(writer);
    // The confirm-carded write path and the browser automation are registered as Client Actions.
    expect(tool_ids).toEqual(expect.arrayContaining(['save_to_knowledge', 'browser_read_page', 'browser_click']));
    expect(system_prompt).toContain('SELECTED-SNIPPET-42');
    expect(system_prompt).toContain('## UI Actions');
  });

  it('keeps the writers for the same turn on a web session', async () => {
    mocks.sessions.getById.mockResolvedValue(sessionOn('web'));

    const { tool_ids } = await sendTurn(panelTurnBody());

    expect(tool_ids).toEqual(expect.arrayContaining(['knowledge_mutation', 'project_mutation', 'memory']));
  });

  it('stays read-only when the web app continues a browser session without the panel', async () => {
    mocks.sessions.getById.mockResolvedValue(sessionOn('browser'));

    const { tool_ids } = await sendTurn({ session_id: 'session-1', messages: [{ role: 'user', content: 'Save it' }] });

    expect(tool_ids).toEqual(['knowledge_query', 'export_data']);
  });
});
