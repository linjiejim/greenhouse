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
  activeSessions: new Map(),
  registerViewport: () => {},
  unregisterViewport: () => {},
  clearSession: () => {},
  sendBotsMessage: async () => ({ queued: false }),
  stopSession: () => {},
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
