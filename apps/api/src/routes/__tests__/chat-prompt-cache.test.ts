/**
 * Cache-first prompt through the real POST /api/chat route.
 *
 * DeepSeek and the OpenAI-compatible providers cache prompt prefixes
 * automatically, so the system prompt must be byte-identical from one turn to
 * the next. Per-turn content — the clock, the page the user is on, the
 * attached-images note, the UI-actions note — closes the newest user message
 * instead, and the Runtime trace records exactly what the provider receives.
 * The rolling digest closes the system prompt and replaces the messages it
 * folded.
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
  modelSupportsVision: vi.fn(),
  inlineImagesForVision: vi.fn(),
  scheduleDigestFold: vi.fn(),
  createProviderAttemptBudgetHook: vi.fn(),
  startChatRuntimeTrace: vi.fn(),
  recordChatRuntimeProviderInput: vi.fn(),
  settleChatRuntimeTrace: vi.fn(),
  persistChatResult: vi.fn(),
  selectTools: vi.fn(),
  users: { getById: vi.fn() },
  sessions: {
    getById: vi.fn(),
    addMessage: vi.fn(),
    buildChatMessages: vi.fn(),
    updateTitle: vi.fn(),
  },
}));

vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  getDb: () => ({ users: mocks.users, sessions: mocks.sessions }),
}));

vi.mock('@greenhouse/agent-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/agent-core')>()),
  createChatStreamAsync: mocks.createChatStreamAsync,
  withFinalAnswerGuarantee: mocks.withFinalAnswerGuarantee,
  createCollectors: mocks.createCollectors,
  processStreamPart: mocks.processStreamPart,
  buildEngineResult: mocks.buildEngineResult,
  modelSupportsVision: mocks.modelSupportsVision,
}));

vi.mock('../../chat/vision.js', () => ({ inlineImagesForVision: mocks.inlineImagesForVision }));

vi.mock('../../chat/digest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../chat/digest.js')>()),
  scheduleDigestFold: mocks.scheduleDigestFold,
}));

vi.mock('../../llm/memory.js', () => ({
  resolveMemoryContext: vi.fn(async () => '### Memory\n- [fact] prefers short answers (id: 1)'),
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

vi.mock('../../config/models.js', () => ({ isChatModelAllowed: () => false }));
vi.mock('../../chat/persist.js', () => ({ persistChatResult: mocks.persistChatResult }));
vi.mock('../../agent.js', () => ({
  selectTools: mocks.selectTools,
  buildSystemPrompt: vi.fn((_profile: unknown, ctx?: { userInfo?: string }) =>
    ctx?.userInfo ? `PROFILE PROMPT\n## User Context\n${ctx.userInfo}` : 'PROFILE PROMPT',
  ),
}));

vi.mock('../../agent-runtime/tool-resolution.js', () => ({
  LAZY_TOOL_IDS: new Set(['session_query']),
  resolveEffectiveTools: vi.fn(async () => ({ effectiveTools: ['knowledge_query', 'session_query'] })),
  buildLazyServerTools: vi.fn(() => ({ session_query: {} })),
  filterBrowserSessionToolIds: (ids: string[]) => ids,
}));

vi.mock('../../profiles/profile.js', () => ({
  resolveProfileAsync: vi.fn(async () => ({
    id: 'team',
    name: 'Team',
    access: { level: 'internal', rich_output: true },
    model: { id: 'test-model' },
    tools: [],
    system_prompt: 'PROFILE PROMPT',
  })),
}));

vi.mock('../../profiles/access.js', () => ({
  pinProfileIdForUser: vi.fn(async (_user: unknown, profileId: string | undefined) => profileId ?? 'team'),
  ProfileAccessError: class ProfileAccessError extends Error {
    status = 403 as const;
  },
}));

import { createChatRoute } from '../chat.js';
import { formatDigestSection } from '../../chat/digest.js';
import { buildChatRequestBody } from '../../../../browser/src/lib/chat-request';

interface ProviderInput {
  system_prompt: string;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'owner', role: 'team' });
    return next();
  });
  app.route('/api/chat', createChatRoute({} as ToolRegistry));
  return app;
}

function session(extra: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    title: 'Pricing review',
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
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

const HISTORY = [
  { role: 'user', content: 'What does the blue plan cost?', created_at: '2026-10-01T01:00:00.000Z', images: [] },
  { role: 'assistant', content: '1.2M per year.', created_at: '2026-10-01T01:00:05.000Z', images: [] },
];

async function sendTurn(body: unknown): Promise<ProviderInput> {
  mocks.recordChatRuntimeProviderInput.mockClear();
  const response = await createApp().request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  await response.text();
  return mocks.recordChatRuntimeProviderInput.mock.calls[0]![2] as ProviderInput;
}

/** A plain turn: no page, no images, no client actions. */
async function plainTurn(): Promise<ProviderInput> {
  mocks.modelSupportsVision.mockReturnValue(false);
  mocks.sessions.buildChatMessages.mockResolvedValue([
    ...HISTORY,
    { role: 'user', content: 'And the green one?', created_at: '2026-10-01T01:01:00.000Z', images: [] },
  ]);
  return sendTurn({ session_id: 'session-1', messages: [{ role: 'user', content: 'And the green one?' }] });
}

/** A turn from a page, with an image the vision model sees and the page's Client Actions. */
async function pageTurnWithImage(): Promise<ProviderInput> {
  mocks.modelSupportsVision.mockReturnValue(true);
  const latest = {
    role: 'user',
    content: 'Compare it with this screenshot',
    created_at: '2026-10-01T01:02:00.000Z',
    images: [{ id: 'shot.png', url: '/api/upload/shot.png' }],
  };
  mocks.sessions.buildChatMessages.mockResolvedValue([...HISTORY, latest]);
  mocks.inlineImagesForVision.mockImplementation(async (messages: Array<Record<string, unknown>>) => ({
    messages: messages.map((m) =>
      Array.isArray(m.images) && m.images.length > 0
        ? {
            ...m,
            content: [
              { type: 'text', text: m.content },
              { type: 'image', image: new Uint8Array([1]), mediaType: 'image/png' },
            ],
          }
        : { ...m },
    ),
    inlined: 1,
    hinted: 0,
  }));
  return sendTurn(
    buildChatRequestBody({
      sessionId: 'session-1',
      message: 'Compare it with this screenshot',
      scopeId: 'scope-page-1',
      ambientContext: {
        version: 1,
        scope_id: 'scope-page-1',
        source: 'current-page',
        label: 'Plans',
        route: '#/tables/plans',
        hint: 'PAGE-CONTEXT-MARKER',
      },
    }),
  );
}

function lastUserText(input: ProviderInput): string {
  const last = input.messages.at(-1)!;
  return typeof last.content === 'string' ? last.content : last.content.map((p) => p.text ?? '').join('');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.users.getById.mockResolvedValue({
    id: 'owner',
    role: 'team',
    status: 'active',
    nickname: 'Owner',
    notes: 'Use metric units.',
    locale: 'en',
  });
  mocks.sessions.getById.mockResolvedValue(session());
  mocks.sessions.addMessage.mockImplementation(async (input: { content: string }) => ({
    id: 'persisted-user-message',
    content: input.content,
  }));
  mocks.sessions.updateTitle.mockResolvedValue(undefined);
  mocks.createProviderAttemptBudgetHook.mockReturnValue(vi.fn());
  mocks.startChatRuntimeTrace.mockResolvedValue({ runId: 'runtime-run', stepId: 'runtime-step', actorUserId: 'owner' });
  mocks.recordChatRuntimeProviderInput.mockResolvedValue(undefined);
  mocks.settleChatRuntimeTrace.mockResolvedValue(undefined);
  mocks.persistChatResult.mockResolvedValue(undefined);
  mocks.selectTools.mockImplementation((_registry: unknown, ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, {}])),
  );
  mocks.buildEngineResult.mockResolvedValue({
    text: 'answer',
    reasoningText: '',
    pipelineSteps: [],
    references: [],
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 },
    durationMs: 1,
    finishReason: 'stop',
  });
  mocks.createCollectors.mockImplementation(() => ({
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
  }));
  mocks.processStreamPart.mockImplementation((part: { type: string }, collectors: Record<string, unknown>) => {
    if (part.type === 'finish') {
      collectors.receivedFinish = true;
      collectors.streamCompleted = true;
    }
  });
  mocks.withFinalAnswerGuarantee.mockImplementation((streamResult: { fullStream: unknown }) => streamResult.fullStream);
  mocks.createChatStreamAsync.mockImplementation(async () => {
    async function* fullStream() {
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } };
    }
    return {
      streamResult: { fullStream: fullStream(), steps: Promise.resolve([]) },
      dsmlRecoveries: [],
      startTime: Date.now(),
      modelId: 'test-model',
    };
  });
});

describe('POST /api/chat — cache-first prompt', () => {
  it('keeps the system prompt byte-identical across turns with different page context and images', async () => {
    const plain = await plainTurn();
    const fromPage = await pageTurnWithImage();

    expect(fromPage.system_prompt).toBe(plain.system_prompt);
    // The stable parts are all there…
    expect(plain.system_prompt).toContain('PROFILE PROMPT');
    expect(plain.system_prompt).toContain('Use metric units.');
    expect(plain.system_prompt).toContain('### Memory');
    expect(plain.system_prompt).toContain('## Tool Guidance');
    expect(plain.system_prompt).toContain('## Response Language');
    // …and nothing that varies per turn.
    for (const perTurn of ['Current Time', 'PAGE-CONTEXT-MARKER', '## Attached Images', '## UI Actions']) {
      expect(plain.system_prompt).not.toContain(perTurn);
    }
  });

  it('closes the newest user message with the per-turn block, leaving earlier messages untouched', async () => {
    const plain = await plainTurn();
    const fromPage = await pageTurnWithImage();

    // History renders the same bytes in both requests (deterministic stamps).
    expect(fromPage.messages.slice(0, 2)).toEqual(plain.messages.slice(0, 2));

    const closing = lastUserText(fromPage);
    expect(closing).toContain('Compare it with this screenshot');
    expect(closing).toContain('[Turn context — added by Greenhouse');
    expect(closing).toContain('[Current Time: ');
    expect(closing).toContain('PAGE-CONTEXT-MARKER');
    expect(closing).toContain('## Attached Images');
    expect(closing).toContain('## UI Actions');
    expect(lastUserText(plain)).not.toContain('PAGE-CONTEXT-MARKER');

    // The trace records exactly what the engine was handed, closing block included.
    const engineInput = mocks.createChatStreamAsync.mock.calls.at(-1)![0] as {
      systemPrompt: string;
      messages: unknown[];
    };
    expect(engineInput.systemPrompt).toBe(fromPage.system_prompt);
    expect(JSON.stringify(engineInput.messages)).toContain('PAGE-CONTEXT-MARKER');
  });

  it('never persists the closing block', async () => {
    await pageTurnWithImage();
    expect(mocks.sessions.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'Compare it with this screenshot' }),
    );
  });
});

describe('POST /api/chat — rolling digest in the prompt', () => {
  const DIGEST = '### Goals\n- choose a plan\n### Decisions\n- blue costs 1.2M (#1)';

  beforeEach(() => {
    mocks.sessions.getById.mockResolvedValue(session({ digest: DIGEST, digest_upto_seq: 7 }));
  });

  it('replaces folded messages with the digest at the end of a still-stable system prompt', async () => {
    const plain = await plainTurn();
    const fromPage = await pageTurnWithImage();

    expect(mocks.sessions.buildChatMessages).toHaveBeenCalledWith('session-1', { afterSeq: 7 });
    expect(plain.system_prompt.endsWith(formatDigestSection(DIGEST, { canSearch: true }))).toBe(true);
    expect(fromPage.system_prompt).toBe(plain.system_prompt);

    const traceInput = mocks.startChatRuntimeTrace.mock.calls.at(-1)![1] as { input: { digest: unknown } };
    expect(traceInput.input.digest).toEqual({ upto_seq: 7, text: DIGEST });
  });

  it('schedules a background fold only after the reply is persisted', async () => {
    await plainTurn();
    await vi.waitFor(() => expect(mocks.scheduleDigestFold).toHaveBeenCalledTimes(1));
    expect(mocks.scheduleDigestFold).toHaveBeenCalledWith({
      sessionId: 'session-1',
      userId: 'owner',
      modelId: 'test-model',
    });
    expect(mocks.persistChatResult.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.scheduleDigestFold.mock.invocationCallOrder[0]!,
    );
  });

  it('does not fold after a turn that failed to finish', async () => {
    mocks.buildEngineResult.mockResolvedValueOnce({
      text: 'partial',
      reasoningText: '',
      pipelineSteps: [],
      references: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
      finishReason: 'error',
    });
    await plainTurn();
    await vi.waitFor(() => expect(mocks.settleChatRuntimeTrace).toHaveBeenCalled());
    expect(mocks.scheduleDigestFold).not.toHaveBeenCalled();
  });
});
