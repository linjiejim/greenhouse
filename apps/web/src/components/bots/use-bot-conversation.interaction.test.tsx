/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConversationDetail } from '@greenhouse/types/bots';
import type { BotMessage, ConversationPage } from '../../lib/api/bots';
import { I18nProvider } from '../../lib/i18n';
import { ToastContainer } from '../ui';
import { useAuthStore } from '../../stores';
import { ReplyFeedback, resetReplyRatings } from './reply-feedback';
import { useBotConversation, type BotConversationController } from './use-bot-conversation';

const api = vi.hoisted(() => ({ getConversation: vi.fn(), markConversationRead: vi.fn() }));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));
vi.mock('../../lib/ws', () => ({ wsClient: { onEvent: () => () => {}, onStatusChange: () => () => {} } }));
const runs = vi.hoisted(() => ({ getChatRun: vi.fn() }));
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  ...runs,
}));
const sessionManager = vi.hoisted(() => ({
  activeSessions: new Map<string, Record<string, unknown>>(),
  registerViewport: () => {},
  unregisterViewport: () => {},
  clearSession: () => {},
  sendBotsMessage: vi.fn(async () => ({ queued: false })),
  rewindBotsMessage: vi.fn(async (_sessionId: string, _options: { messageId: string; content?: string }) => {}),
  stopSession: vi.fn(),
  interruptSession: vi.fn(async (): Promise<'interrupting' | 'no_run' | 'refused'> => 'interrupting'),
  attachSession: vi.fn(),
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
  sessionManager.rewindBotsMessage.mockReset().mockResolvedValue(undefined);
  sessionManager.stopSession.mockReset();
  sessionManager.interruptSession.mockReset().mockResolvedValue('interrupting');
  sessionManager.attachSession.mockReset();
  runs.getChatRun.mockReset().mockResolvedValue({ active: false });
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

describe('useBotConversation — the member’s ratings (P4)', () => {
  const reply = (id: string, seq: number): BotMessage => ({ ...message(id, seq), role: 'assistant', bot_id: 'bot_a' });
  const ratingOf = (id: string) =>
    document.querySelector(`[data-message="${id}"] [data-testid="bots-reply-feedback"]`)?.getAttribute('data-rating');

  beforeEach(() => resetReplyRatings());

  it('shows each reply’s rating from the latest page and older ones, and forgets one no longer there', async () => {
    api.getConversation.mockImplementation((_sessionId: string, opts: { beforeSeq?: number }) =>
      Promise.resolve(
        opts.beforeSeq !== undefined
          ? { ...page('A', [reply('r-1', 1)], false), my_ratings: { 'r-1': -1 } }
          : { ...page('A', [reply('r-9', 9), reply('r-10', 10)], true), my_ratings: { 'r-10': 1 } },
      ),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const feedback = (id: string) =>
      createElement(
        'div',
        { key: id, 'data-message': id },
        createElement(ReplyFeedback, { sessionId: 'A', messageId: id }),
      );
    await act(async () =>
      root?.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(
            'div',
            null,
            createElement(Probe, { sessionId: 'A' }),
            ...['r-1', 'r-9', 'r-10'].map(feedback),
          ),
        }),
      ),
    );
    await flush();
    expect([ratingOf('r-10'), ratingOf('r-9'), ratingOf('r-1')]).toEqual(['1', '', '']);

    await act(async () => {
      await latest?.loadEarlier();
    });
    await flush();
    expect(ratingOf('r-1')).toBe('-1');

    // Taken back elsewhere: the next read of the page no longer carries it.
    api.getConversation.mockResolvedValue(page('A', [reply('r-9', 9), reply('r-10', 10)], true));
    await act(async () => {
      await latest?.reload();
    });
    expect([ratingOf('r-10'), ratingOf('r-1')]).toEqual(['', '-1']);
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

describe('useBotConversation — edit / answer again (a separate chat)', () => {
  const reply = (id: string, seq: number): BotMessage => ({ ...message(id, seq), role: 'assistant', bot_id: 'bot_a' });

  async function open() {
    api.getConversation.mockResolvedValue(
      page('T', [message('u1', 1), reply('a1', 2), message('u2', 3), reply('a2', 4), reply('a3', 5)], false),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(tree('T')));
    await flush();
  }

  it('takes what the run replaces off the screen at once, with the edit in place', async () => {
    await open();
    await act(async () => {
      await latest?.rewind('u2', 'u2, shorter');
    });
    expect(sessionManager.rewindBotsMessage).toHaveBeenCalledWith('T', { messageId: 'u2', content: 'u2, shorter' });
    expect(latest?.messages.map((m) => [m.id, m.content])).toEqual([
      ['u1', 'u1'],
      ['a1', 'a1'],
      ['u2', 'u2, shorter'],
    ]);
  });

  it('answers again without an edit, and puts everything back when refused', async () => {
    await open();
    sessionManager.rewindBotsMessage.mockRejectedValue(new Error('busy'));
    let error: unknown = null;
    await act(async () => {
      error = await latest?.rewind('u2').catch((err: unknown) => err);
    });
    expect(sessionManager.rewindBotsMessage).toHaveBeenCalledWith('T', { messageId: 'u2' });
    expect(error).toBeInstanceOf(Error);
    expect(latest?.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'a3']);
  });
});

describe('useBotConversation — a room (P5)', () => {
  const ROOM_ID = 'room-1';
  function roomPage(messages: BotMessage[]): ConversationPage {
    const base = page(ROOM_ID, messages, false);
    return {
      ...base,
      conversation: {
        ...base.conversation,
        kind: 'room',
        owner_bot_id: null,
        lead_bot_id: null,
        members: [
          { bot_id: 'bot_mine', role: 'member', position: 0, owner_user_id: 'u1', addressable: true },
          { bot_id: 'bot_ben', role: 'member', position: 1, owner_user_id: 'u3', addressable: false },
          { bot_id: 'bot_public', role: 'member', position: 2, owner_user_id: 'u4', addressable: true },
        ],
        participants: [
          { user_id: 'u1', nickname: 'Mia', role: 'owner', joined_at: '' },
          { user_id: 'u3', nickname: 'Ben', role: 'member', joined_at: '' },
        ],
      },
    };
  }
  const authored = (id: string, seq: number, author: string, content: string): BotMessage => ({
    ...message(id, seq),
    content,
    author_user_id: author,
  });

  async function open(messages: BotMessage[] = []) {
    api.getConversation.mockResolvedValue(roomPage(messages));
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(tree(ROOM_ID)));
    await flush();
  }

  beforeEach(() => useAuthStore.setState({ currentUser: { id: 'u1', role: 'team', nickname: 'Mia' } }));
  afterEach(() => useAuthStore.setState({ currentUser: null }));

  it('shows an accepted message (202) as said — never "read after the current reply"', async () => {
    await open();
    sessionManager.sendBotsMessage.mockResolvedValue({ queued: true });
    await act(async () => {
      await latest?.send('hello all', { mentions: [] });
    });
    expect(latest?.pending.map((send) => send.status)).toEqual(['sent']);
  });

  it("settles a send only with the member's own message, not someone else's identical one", async () => {
    await open();
    sessionManager.sendBotsMessage.mockResolvedValue({ queued: true });
    await act(async () => {
      await latest?.send('ok', { mentions: [] });
    });
    api.getConversation.mockResolvedValue(roomPage([authored('m1', 1, 'u3', 'ok')]));
    await act(async () => {
      await latest?.reload();
    });
    expect(latest?.pending).toHaveLength(1);
    api.getConversation.mockResolvedValue(roomPage([authored('m1', 1, 'u3', 'ok'), authored('m2', 2, 'u1', 'ok')]));
    await act(async () => {
      await latest?.reload();
    });
    expect(latest?.pending).toHaveLength(0);
  });

  it("probes for a run on open and follows one already going (someone else's is not in the runs seed)", async () => {
    runs.getChatRun.mockResolvedValue({ active: true });
    await open();
    expect(runs.getChatRun).toHaveBeenCalledWith(ROOM_ID);
    expect(sessionManager.attachSession).toHaveBeenCalledWith(ROOM_ID);
  });

  it('does not probe outside a room', async () => {
    api.getConversation.mockResolvedValue(page('dm', [], false));
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(tree('dm')));
    await flush();
    expect(runs.getChatRun).not.toHaveBeenCalled();
  });

  it("lets the member stop a run their own Agent answers, or one they @-mentioned — never another person's", async () => {
    const streaming = (botId: string) =>
      sessionManager.activeSessions.set(ROOM_ID, {
        sessionId: ROOM_ID,
        status: 'streaming',
        botSegments: [{ botId, reason: 'user', status: 'streaming', text: '', reasoning: '', toolCalls: [] }],
        botRequests: [],
        startedAt: 1,
      });
    streaming('bot_ben');
    await open();
    expect(latest?.streaming).toBe(true);
    expect(latest?.canStop).toBe(false);

    streaming('bot_mine');
    await act(async () => root?.render(tree(ROOM_ID)));
    expect(latest?.canStop).toBe(true);

    // A public Agent: theirs to stop only when they asked it.
    streaming('bot_public');
    await act(async () => root?.render(tree(ROOM_ID)));
    expect(latest?.canStop).toBe(false);
    sessionManager.sendBotsMessage.mockResolvedValue({ queued: true });
    await act(async () => {
      await latest?.send('@Oracle numbers?', { mentions: ['bot_public'] });
    });
    expect(latest?.canStop).toBe(true);
  });
});
