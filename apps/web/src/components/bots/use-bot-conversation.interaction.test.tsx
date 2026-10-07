/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConversationDetail } from '@greenhouse/types/bots';
import type { BotMessage, ConversationPage } from '../../lib/api/bots';
import { I18nProvider } from '../../lib/i18n';
import { ToastContainer } from '../ui';
import { useBotConversation, type BotConversationController } from './use-bot-conversation';

const api = vi.hoisted(() => ({ getConversation: vi.fn(), markConversationRead: vi.fn() }));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));
vi.mock('../../lib/ws', () => ({ wsClient: { onEvent: () => () => {}, onStatusChange: () => () => {} } }));
const sessionManager = vi.hoisted(() => ({
  activeSessions: new Map<string, Record<string, unknown>>(),
  registerViewport: () => {},
  unregisterViewport: () => {},
  clearSession: () => {},
  sendBotsMessage: vi.fn(async () => ({ queued: false })),
  stopSession: vi.fn(),
  interruptSession: vi.fn(async (): Promise<'interrupting' | 'no_run' | 'refused'> => 'interrupting'),
}));
vi.mock('../../lib/session-manager', () => ({ useSessionManager: () => sessionManager }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function message(id: string, seq: number): BotMessage {
  return {
    id,
    role: 'user',
    content: id,
    bot_id: null,
    bot_event: null,
    pipeline: [],
    references: [],
    reasoning: null,
    model: null,
    images: [],
    created_at: '2026-10-05T00:00:00.000Z',
    seq,
  };
}

function page(sessionId: string, messages: BotMessage[], hasMore: boolean): ConversationPage {
  const conversation = {
    session_id: sessionId,
    kind: 'direct',
    title: null,
    owner_bot_id: 'bot_a',
    lead_bot_id: 'bot_a',
    members: [],
    last_message: null,
    attention: 'idle',
    pending_requests: 0,
    last_activity_at: '2026-10-05T00:00:00.000Z',
    description: '',
    allow_bot_chat: true,
    digest: null,
    notes: [],
    requests: [],
    context: { estimated_tokens: 0, threshold: 1 },
  } satisfies BotConversationDetail;
  return { conversation, messages, has_more: hasMore };
}

let root: ReturnType<typeof createRoot> | null = null;
let latest: BotConversationController | null = null;

function Probe({ sessionId }: { sessionId: string }) {
  latest = useBotConversation(sessionId);
  return null;
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function tree(sessionId: string) {
  return createElement(I18nProvider, {
    initialLocale: 'en',
    children: createElement('div', null, createElement(Probe, { sessionId }), createElement(ToastContainer)),
  });
}

beforeEach(() => {
  api.getConversation.mockReset();
  api.markConversationRead.mockReset();
  api.markConversationRead.mockResolvedValue(undefined);
  sessionManager.activeSessions.clear();
  sessionManager.sendBotsMessage.mockReset().mockResolvedValue({ queued: false });
  sessionManager.stopSession.mockReset();
  sessionManager.interruptSession.mockReset().mockResolvedValue('interrupting');
  latest = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('useBotConversation — Load earlier', () => {
  it('drops an older page that lands after switching conversations', async () => {
    let resolveEarlier: (value: ConversationPage) => void = () => {};
    api.getConversation.mockImplementation((sessionId: string, opts: { beforeSeq?: number }) => {
      if (sessionId === 'A' && opts.beforeSeq !== undefined) {
        return new Promise<ConversationPage>((resolve) => {
          resolveEarlier = resolve;
        });
      }
      if (sessionId === 'A') return Promise.resolve(page('A', [message('a-10', 10)], true));
      return Promise.resolve(page('B', [message('b-5', 5)], false));
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(tree('A')));
    await flush();
    expect(latest?.messages.map((m) => m.id)).toEqual(['a-10']);

    // Start "Load earlier" on A, then switch to B before it answers.
    void act(() => {
      void latest?.loadEarlier();
    });
    await flush();
    expect(latest?.loadingEarlier).toBe(true);
    await act(async () => root?.render(tree('B')));
    await flush();
    expect(latest?.messages.map((m) => m.id)).toEqual(['b-5']);
    // B's button is not stuck behind A's request.
    expect(latest?.loadingEarlier).toBe(false);

    await act(async () => resolveEarlier(page('A', [message('a-1', 1)], false)));
    await flush();
    expect(latest?.messages.map((m) => m.id)).toEqual(['b-5']);
    expect(latest?.hasMore).toBe(false);
    expect(latest?.loadingEarlier).toBe(false);
  });

  it('says so when the older page cannot be loaded', async () => {
    api.getConversation.mockImplementation((_sessionId: string, opts: { beforeSeq?: number }) =>
      opts.beforeSeq !== undefined
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(page('A', [message('a-10', 10)], true)),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(tree('A')));
    await flush();

    await act(async () => {
      await latest?.loadEarlier();
    });
    await flush();
    expect(document.body.textContent).toContain('Could not load earlier messages');
    expect(latest?.loadingEarlier).toBe(false);
    expect(latest?.messages.map((m) => m.id)).toEqual(['a-10']);
  });
});

describe('useBotConversation — memory receipt states', () => {
  it('keeps what the server says about each memory, across the latest page and older ones', async () => {
    api.getConversation.mockImplementation((_sessionId: string, opts: { beforeSeq?: number }) =>
      Promise.resolve(
        opts.beforeSeq !== undefined
          ? { ...page('A', [message('a-1', 1)], false), memory_states: { '7': 'superseded' } }
          : { ...page('A', [message('a-10', 10)], true), memory_states: { '41': 'archived', '42': 'deleted' } },
      ),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(tree('A')));
    await flush();
    expect(latest?.memoryStates).toEqual({ '41': 'archived', '42': 'deleted' });

    await act(async () => {
      await latest?.loadEarlier();
    });
    await flush();
    // An older page adds its receipts' states without dropping the latest page's.
    expect(latest?.memoryStates).toEqual({ '41': 'archived', '42': 'deleted', '7': 'superseded' });
  });
});

describe('useBotConversation — stopping a run', () => {
  /** A run in progress, as SessionManager reports it. */
  function streaming(overrides: Record<string, unknown> = {}) {
    sessionManager.activeSessions.set('A', {
      sessionId: 'A',
      status: 'streaming',
      streamText: '',
      streamReasoning: '',
      streamToolCalls: [],
      botSegments: [],
      botRequests: [],
      startedAt: 1,
      ...overrides,
    });
  }

  /** What SessionManager does once the server took the soft stop. */
  function serverTookIt() {
    const session = sessionManager.activeSessions.get('A');
    if (session) session.interrupting = true;
    return 'interrupting' as const;
  }

  async function open() {
    api.getConversation.mockResolvedValue(page('A', [], false));
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(tree('A')));
    await flush();
  }

  it('first lets the current step finish, and stops at once on a second press', async () => {
    streaming();
    sessionManager.interruptSession.mockImplementation(async () => serverTookIt());
    await open();
    expect(latest?.stopPhase).toBeNull();

    await act(async () => latest?.stop());
    await flush();
    expect(sessionManager.interruptSession).toHaveBeenCalledWith('A');
    expect(sessionManager.stopSession).not.toHaveBeenCalled();
    expect(latest?.stopPhase).toBe('soft');
    expect(latest?.interrupting).toBe(true);

    await act(async () => latest?.stop());
    expect(sessionManager.stopSession).toHaveBeenCalledWith('A');
    expect(sessionManager.interruptSession).toHaveBeenCalledTimes(1);
  });

  it('already reads "stopping" while the soft stop is being asked for — a second press is the hard stop', async () => {
    streaming();
    sessionManager.interruptSession.mockImplementation(() => new Promise<'interrupting'>(() => {}));
    await open();
    await act(async () => latest?.stop());
    expect(latest?.stopPhase).toBe('soft');
    await act(async () => latest?.stop());
    expect(sessionManager.stopSession).toHaveBeenCalledWith('A');
  });

  it.each(['refused', 'no_run'] as const)(
    'falls back to the hard stop (quietly) when the soft stop comes back %s',
    async (outcome) => {
      streaming();
      sessionManager.interruptSession.mockResolvedValue(outcome);
      await open();
      await act(async () => latest?.stop());
      await flush();
      expect(sessionManager.stopSession).toHaveBeenCalledWith('A');
      expect(document.body.textContent).not.toContain("Couldn't");
    },
  );

  it('reports a hard stop under way', async () => {
    streaming({ status: 'stopping' });
    await open();
    expect(latest?.stopPhase).toBe('hard');
  });

  it('"Handle now" lets the current step finish and marks the waiting message', async () => {
    streaming();
    sessionManager.sendBotsMessage.mockResolvedValue({ queued: true });
    sessionManager.interruptSession.mockImplementation(async () => serverTookIt());
    await open();
    await act(async () => {
      await latest?.send('also check the invoices');
    });
    const [waiting] = latest?.pending ?? [];
    expect(waiting?.status).toBe('queued');

    await act(async () => {
      await latest?.handleNow(waiting!.clientId);
    });
    await flush();
    expect(sessionManager.interruptSession).toHaveBeenCalledWith('A');
    expect(latest?.pending[0]?.nudged).toBe(true);
  });

  it('says nothing when the run had already finished', async () => {
    streaming();
    sessionManager.sendBotsMessage.mockResolvedValue({ queued: true });
    sessionManager.interruptSession.mockResolvedValue('no_run');
    await open();
    await act(async () => {
      await latest?.send('also check the invoices');
    });
    await act(async () => {
      await latest?.handleNow(latest!.pending[0]!.clientId);
    });
    await flush();
    expect(document.body.textContent).not.toContain("Couldn't jump the queue");
    expect(sessionManager.stopSession).not.toHaveBeenCalled();
  });

  it('marks a waiting message picked up once a turn answers it — once, even after it settles', async () => {
    streaming({
      botSegments: [{ botId: 'bot_a', reason: 'user', status: 'streaming', text: '', reasoning: '', toolCalls: [] }],
    });
    sessionManager.sendBotsMessage.mockResolvedValue({ queued: true });
    await open();
    await act(async () => {
      await latest?.send('first');
    });
    await act(async () => {
      await latest?.send('second');
    });
    expect(latest?.pending.map((send) => send.status)).toEqual(['queued', 'queued']);

    // The run reads "first": an interjection turn starts.
    const segment = (reason: string, status = 'streaming') => ({
      botId: 'bot_a',
      reason,
      status,
      text: '',
      reasoning: '',
      toolCalls: [],
    });
    streaming({ botSegments: [segment('user', 'completed'), segment('interjection')] });
    await act(async () => root?.render(tree('A')));
    await flush();
    expect(latest?.pending.map((send) => [send.content, send.status])).toEqual([
      ['first', 'sent'],
      ['second', 'queued'],
    ]);

    // "first" settles (its persisted copy arrives): the same turn must not pick up "second".
    api.getConversation.mockResolvedValue(page('A', [{ ...message('first', 1), content: 'first' }], false));
    await act(async () => {
      await latest?.reload();
    });
    streaming({ botSegments: [segment('user', 'completed'), segment('interjection', 'completed')] });
    await act(async () => root?.render(tree('A')));
    await flush();
    expect(latest?.pending.map((send) => [send.content, send.status])).toEqual([['second', 'queued']]);
  });

  it('says so when "Handle now" does not go through, and offers it again', async () => {
    streaming();
    sessionManager.sendBotsMessage.mockResolvedValue({ queued: true });
    sessionManager.interruptSession.mockResolvedValue('refused');
    await open();
    await act(async () => {
      await latest?.send('also check the invoices');
    });
    await act(async () => {
      await latest?.handleNow(latest!.pending[0]!.clientId);
    });
    await flush();
    expect(latest?.pending[0]?.nudged).toBe(false);
    expect(document.body.textContent).toContain("Couldn't jump the queue");
    expect(sessionManager.stopSession).not.toHaveBeenCalled();
  });
});
