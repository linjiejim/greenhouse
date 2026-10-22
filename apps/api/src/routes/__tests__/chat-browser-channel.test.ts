/**
 * The browser-extension conversation surface through the real POST /api/chat
 * route: a `browser`-channel session has its tools narrowed by
 * `filterBrowserSessionToolIds` (no inline writer; the panel's confirm-carded
 * Client Action is the only write path), while the panel's actions and the page
 * it is on do reach the model. Keyed on the session's channel, so the same
 * request on a web session is not narrowed.
 *
 * The filter is a stand-in here on purpose: the real one reads the tool catalog,
 * which loads every active extension, and a fork running these tests with its
 * own extensions on must not trip over that. Its semantics are pinned against
 * the real catalog in agent-runtime/__tests__/browser-session-tools.test.ts.
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
  usageCounters: {
    increment: vi.fn(),
  },
}));

vi.mock('@greenhouse/db', () => ({
  // Sessions in these fixtures carry no digest columns, so this is the real answer.
  readSessionDigest: () => null,
  getDb: () => ({
    users: mocks.users,
    userFeatures: mocks.userFeatures,
    sessions: mocks.sessions,
    usageCounters: mocks.usageCounters,
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
  // The closing turn-context block's clock line and the deterministic stamps
  // recorded in the Runtime trace (both unit-tested in agent-core).
  formatCurrentTimeLine: () => '[Current Time: test]',
  injectTimeContext: <T>(messages: T[]) => messages,
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
// never sees (memory) and an output-only tool. The stand-in filter keeps the two
// the real one keeps from this set.
const EFFECTIVE_TOOLS = ['knowledge_query', 'knowledge_mutation', 'project_mutation', 'memory', 'export_data'];
const filterBrowserSessionToolIds = vi.hoisted(() =>
  vi.fn((ids: string[]) => ids.filter((id) => id === 'knowledge_query' || id === 'export_data')),
);
vi.mock('../../agent-runtime/tool-resolution.js', () => ({
  LAZY_TOOL_IDS: new Set(),
  resolveEffectiveTools: vi.fn(async () => ({ effectiveTools: EFFECTIVE_TOOLS })),
  buildLazyServerTools: vi.fn(() => ({})),
  filterBrowserSessionToolIds,
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

async function sendTurn(
  body: unknown,
): Promise<{ tool_ids: string[]; system_prompt: string; messages: Array<{ role: string; content: string }> }> {
  const response = await createApp().request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  await response.text();
  return mocks.recordChatRuntimeProviderInput.mock.calls[0]![2] as {
    tool_ids: string[];
    system_prompt: string;
    messages: Array<{ role: string; content: string }>;
  };
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

    const { tool_ids, system_prompt, messages } = await sendTurn(panelTurnBody());

    expect(filterBrowserSessionToolIds).toHaveBeenCalledWith(EFFECTIVE_TOOLS);
    expect(tool_ids).toEqual(expect.arrayContaining(['knowledge_query', 'export_data']));
    for (const writer of ['knowledge_mutation', 'project_mutation', 'memory']) expect(tool_ids).not.toContain(writer);
    // The confirm-carded write path and the browser automation are registered as Client Actions.
    expect(tool_ids).toEqual(expect.arrayContaining(['save_to_knowledge', 'browser_read_page', 'browser_click']));
    // Page context and the UI-actions note are per-turn: they close the newest
    // user message, never the (cache-stable) system prompt.
    const closing = messages.at(-1)!.content;
    expect(closing).toContain('SELECTED-SNIPPET-42');
    expect(closing).toContain('## UI Actions');
    expect(system_prompt).not.toContain('SELECTED-SNIPPET-42');
    expect(system_prompt).not.toContain('## UI Actions');
  });

  it('keeps the writers for the same turn on a web session', async () => {
    mocks.sessions.getById.mockResolvedValue(sessionOn('web'));

    const { tool_ids } = await sendTurn(panelTurnBody());

    expect(filterBrowserSessionToolIds).not.toHaveBeenCalled();
    expect(tool_ids).toEqual(expect.arrayContaining(['knowledge_mutation', 'project_mutation', 'memory']));
  });

  it('stays read-only when the web app continues a browser session without the panel', async () => {
    mocks.sessions.getById.mockResolvedValue(sessionOn('browser'));

    const { tool_ids } = await sendTurn({ session_id: 'session-1', messages: [{ role: 'user', content: 'Save it' }] });

    expect(tool_ids).toEqual(['knowledge_query', 'export_data']);
  });
});

describe('module usage counting on chat turns', () => {
  beforeEach(() => {
    mocks.sessions.buildChatMessages.mockResolvedValue([{ role: 'user', content: 'Hello' }]);
    mocks.usageCounters.increment.mockResolvedValue(undefined);
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

  /** Run one turn and execute `knowledge_query` from the registry the engine received. */
  async function countedClientFor(channel: string, headers: Record<string, string> = {}) {
    mocks.sessions.getById.mockResolvedValue(sessionOn(channel));
    const execute = vi.fn().mockResolvedValue({ ok: true });
    mocks.selectTools.mockImplementation((_registry: unknown, ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, { execute }])),
    );
    const response = await createApp().request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ session_id: 'session-1', messages: [{ role: 'user', content: 'Hello' }] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    const tools = mocks.createChatStreamAsync.mock.calls[0]![0].tools as ToolRegistry;
    await tools.knowledge_query.execute({}, { toolCallId: 'call-1', messages: [] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.usageCounters.increment).toHaveBeenCalledTimes(1);
    return mocks.usageCounters.increment.mock.calls[0];
  }

  beforeEach(() => {
    // Without a Runtime trace the engine receives the counted registry itself.
    mocks.startChatRuntimeTrace.mockResolvedValue(null);
  });

  it('counts a web session turn as web_chat', async () => {
    expect(await countedClientFor('web')).toEqual(['tool_call', 'knowledge_query', 'web_chat']);
  });

  it('counts a browser-channel turn as browser', async () => {
    expect(await countedClientFor('browser')).toEqual(['tool_call', 'knowledge_query', 'browser']);
  });

  it('counts a turn sent by the mobile app as mobile', async () => {
    expect(await countedClientFor('web', { 'X-Greenhouse-Client': 'mobile' })).toEqual([
      'tool_call',
      'knowledge_query',
      'mobile',
    ]);
  });
});
