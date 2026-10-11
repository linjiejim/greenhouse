/** @vitest-environment happy-dom */

/**
 * Separate Agent chats in the chats list (spec 20261011-agent-first-class D21): with Agents on
 * the list asks for them (`include=agent_chats`), a row with `channel: 'bots'` opens in its own
 * view and is highlighted while open, its menu drops what does not apply, and an Agent chat
 * changing server-side refreshes the list. Without Agents the list is the chats, as before.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n';
import { useAuthStore } from '../../../stores';
import { useBotsStore } from '../../bots/bots-store';
import { ChatHistoryPanel } from './chat-history-panel';

const api = vi.hoisted(() => ({
  listSessions: vi.fn(),
  listSessionTags: vi.fn(async () => []),
  listSessionGroups: vi.fn(async () => []),
  regenerateTitle: vi.fn(),
}));
vi.mock('../../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api')>()),
  ...api,
}));
const ws = vi.hoisted(() => ({ listeners: [] as Array<(event: { type: string; sessionId?: string }) => void> }));
vi.mock('../../../lib/ws', () => ({
  wsClient: {
    onEvent: (listener: (event: { type: string; sessionId?: string }) => void) => {
      ws.listeners.push(listener);
      return () => {
        ws.listeners = ws.listeners.filter((candidate) => candidate !== listener);
      };
    },
    onStatusChange: () => () => {},
  },
}));
vi.mock('../../../lib/session-manager', () => ({
  useSessionManager: () => ({
    activeSessions: new Map(),
    unreadSessions: new Set(),
    importantSessions: new Set(),
    remoteStreamingSessions: new Set(),
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date().toISOString();
const session = (id: string, title: string, channel = 'web') => ({
  id,
  title,
  status: 'active',
  rating: null,
  comment: null,
  feedback: null,
  profile_id: 'sprouty',
  channel,
  metadata: '{}',
  created_at: NOW,
  updated_at: NOW,
  is_owner: true,
});

let host: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(props: Partial<Parameters<typeof ChatHistoryPanel>[0]> = {}) {
  await act(async () =>
    root.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ChatHistoryPanel, {
          currentSessionId: null,
          onSelectSession: vi.fn(),
          ...props,
        }),
      }),
    ),
  );
  await flush();
}

const row = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="chat-history-row"][data-session-id="${id}"]`);
const click = async (element: Element | null) => {
  await act(async () => element?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
};

beforeEach(() => {
  vi.useRealTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  ws.listeners = [];
  api.listSessions
    .mockReset()
    .mockResolvedValue([session('chat-1', 'Old chat'), session('task-1', 'Vendor shortlist', 'bots')]);
  useAuthStore.setState({
    currentUser: { id: 'u1', role: 'team', nickname: 'Mia', features: { bots: true } } as never,
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useBotsStore.setState({ ...useBotsStore.getInitialState() });
});

describe('ChatHistoryPanel with Agent chats', () => {
  it('asks for Agent chats and opens one in its own view, highlighted while it is open', async () => {
    const onSelectSession = vi.fn();
    const onOpen = vi.fn();
    await mount({ onSelectSession, agentChats: { currentId: 'task-1', onOpen } });

    expect(api.listSessions).toHaveBeenCalledWith('active', false, 500, 'mine', { includeAgentChats: true });
    expect(row('task-1')?.dataset.agentChat).toBe('true');
    expect(row('task-1')?.getAttribute('aria-current')).toBe('page');
    expect(row('chat-1')?.getAttribute('aria-current')).toBeNull();

    await click(row('task-1'));
    expect(onOpen).toHaveBeenCalledWith('task-1');
    expect(onSelectSession).not.toHaveBeenCalled();

    // An ordinary chat still opens in the chat engine.
    await click(row('chat-1'));
    expect(onSelectSession).toHaveBeenCalledWith('chat-1');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps rename / pin / folder / tags / archive / delete on an Agent chat, but not "Regenerate Title"', async () => {
    await mount({ agentChats: { currentId: null, onOpen: vi.fn() } });
    const menuOf = async (id: string) => {
      await click(row(id)!.querySelector('button[aria-label^="More actions"]'));
      const labels = [...document.querySelectorAll('.fixed.z-50 button')].map((button) => button.textContent?.trim());
      // Close it again.
      await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
      await flush();
      return labels;
    };
    const agentMenu = await menuOf('task-1');
    expect(agentMenu).toEqual(expect.arrayContaining(['Rename', 'Archive', 'Delete', 'Tags']));
    expect(agentMenu).not.toContain('Regenerate Title');
    expect(await menuOf('chat-1')).toContain('Regenerate Title');
  });

  it('refreshes when an Agent chat changes server-side — not on every Agent thread push', async () => {
    await mount({ agentChats: { currentId: null, onOpen: vi.fn() } });
    useBotsStore.setState({
      conversations: [{ session_id: 'dm-sage' } as never],
    });
    api.listSessions.mockClear();

    // A thread (a DM) talking: not this list's business.
    await act(async () =>
      ws.listeners.forEach((listener) => listener({ type: 'bots:conversation', sessionId: 'dm-sage' })),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    expect(api.listSessions).not.toHaveBeenCalled();

    // A chat this list has never seen (just created / opened by an Agent's card): reload.
    await act(async () =>
      ws.listeners.forEach((listener) => listener({ type: 'bots:conversation', sessionId: 'task-2' })),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    expect(api.listSessions).toHaveBeenCalledTimes(1);

    // A listed one renamed or titled after its first reply: reload.
    await act(async () =>
      ws.listeners.forEach((listener) => listener({ type: 'bots:conversation', sessionId: 'task-1' })),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    expect(api.listSessions).toHaveBeenCalledTimes(2);
  });

  it('is the chats alone without Agents', async () => {
    api.listSessions.mockResolvedValue([session('chat-1', 'Old chat')]);
    await mount();
    expect(api.listSessions).toHaveBeenCalledWith('active', false, 500, 'mine', { includeAgentChats: false });
    expect(ws.listeners).toHaveLength(0);
  });
});
