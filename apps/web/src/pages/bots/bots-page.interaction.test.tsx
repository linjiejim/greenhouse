/** @vitest-environment happy-dom */

/**
 * The Bots page as a whole: where the member lands, what a phone can reach
 * when nothing loads, and the host-level hand-back guard on the computer pane.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BotConversationDetail,
  BotConversationSummary,
  BotView,
  ComputerStatusView,
} from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { BotsApiError } from '../../lib/api/bots';
import { useAuthStore, useProfileStore } from '../../stores';
import { ToastContainer } from '../../components/ui';
import { useBotsStore } from '../../components/bots/bots-store';
import { browserTimeZone, resetComputerTimezoneSyncForTest } from '../../components/bots/computer-phase';
import { BotsPage } from './index';

const api = vi.hoisted(() => ({
  listBots: vi.fn(),
  listConversations: vi.fn(),
  bootstrapBots: vi.fn(),
  getConversation: vi.fn(),
  markConversationRead: vi.fn(),
  listConversationTasks: vi.fn(),
  listRequests: vi.fn(),
  fetchComputerStatus: vi.fn(),
  handbackComputer: vi.fn(),
  createComputerViewToken: vi.fn(),
  updateComputerSettings: vi.fn(),
}));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));
vi.mock('../../lib/ws', () => ({ wsClient: { onEvent: () => () => {}, onStatusChange: () => () => {} } }));
vi.mock('../../lib/novnc/loader', () => ({
  loadRfb: async () =>
    class {
      viewOnly = true;
      addEventListener() {}
      removeEventListener() {}
      disconnect() {}
      focus() {}
      blur() {}
      sendKey() {}
    },
}));
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

function bot(id: string, name: string, status: 'active' | 'archived', dm: string): BotView {
  return {
    id,
    name,
    role: 'Researcher',
    instructions: '',
    avatar: { color: 'ocean' },
    model_id: null,
    template_key: null,
    status,
    description: '',
    tools: null,
    max_steps: null,
    current_version: 1,
    user_id: 'u1',
    updated_at: '2026-10-05T00:00:00.000Z',
    dm_session_id: dm,
    last_active_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
  };
}

const SAGE = bot('bot_sage', 'Sage', 'active', 'dm-sage');
const OLD = bot('bot_old', 'Old', 'archived', 'dm-old');

function summary(sessionId: string, owner: BotView): BotConversationSummary {
  return {
    session_id: sessionId,
    kind: 'direct',
    title: null,
    owner_bot_id: owner.id,
    lead_bot_id: owner.id,
    members: [{ bot_id: owner.id, role: 'owner', position: 0 }],
    last_message: null,
    attention: 'idle',
    pending_requests: 0,
    last_activity_at: '2026-10-05T00:00:00.000Z',
  };
}

function detail(sessionId: string, owner: BotView): BotConversationDetail {
  return {
    ...summary(sessionId, owner),
    description: '',
    allow_bot_chat: true,
    digest: null,
    notes: [],
    requests: [],
    context: { estimated_tokens: 0, threshold: 1 },
  };
}

function computer(overrides: Partial<ComputerStatusView>): ComputerStatusView {
  return {
    runtime: { state: 'ready', reason: null, hardened: false },
    state: 'running',
    state_reason: null,
    controller: 'bot',
    controller_since: null,
    last_active_at: null,
    queue_position: null,
    disk_bytes: null,
    // Already on the browser's clock: only the timezone tests below make the page store it.
    timezone: browserTimeZone(),
    lang: 'zh-CN',
    ...overrides,
  };
}

let root: ReturnType<typeof createRoot> | null = null;

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPage(query: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(
          'div',
          null,
          createElement(BotsPage, { params: new URLSearchParams(query) }),
          createElement(ToastContainer),
        ),
      }),
    ),
  );
  await flush();
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error(`Missing element in: ${document.body.textContent}`);
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  useBotsStore.getState().reset();
  useAuthStore.setState({ currentUser: { id: 'u1', role: 'team', nickname: 'Mia' } as never });
  useProfileStore.setState({ profiles: [], models: [], fetchProfiles: async () => {} });
  api.listBots.mockResolvedValue({
    bots: [SAGE],
    archived_bots: [OLD],
    computer: { state: 'ready', reason: null, hardened: false },
    vault_available: false,
    pending_requests: 0,
  });
  api.listConversations.mockResolvedValue({ conversations: [summary('dm-old', OLD), summary('dm-sage', SAGE)] });
  api.markConversationRead.mockResolvedValue(undefined);
  api.listConversationTasks.mockResolvedValue({ tasks: [] });
  api.listRequests.mockResolvedValue({ requests: [] });
  api.createComputerViewToken.mockResolvedValue({ token: 't', expires_at: '2026-10-05T00:00:00.000Z' });
  api.updateComputerSettings.mockImplementation(async ({ timezone }: { timezone: string }) => computer({ timezone }));
  resetComputerTimezoneSyncForTest();
  window.location.hash = '#/bots';
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Bots landing', () => {
  it('lands on the latest conversation someone can still answer in — not an archived Bot’s DM', async () => {
    await renderPage('');
    expect(window.location.hash).toBe('#/bots?c=dm-sage');
    expect(api.bootstrapBots).not.toHaveBeenCalled();
  });

  it('never lands in a retired group chat, however recent', async () => {
    const group: BotConversationSummary = {
      ...summary('grp-1', SAGE),
      kind: 'group',
      title: 'Launch prep',
      owner_bot_id: null,
      members: [{ bot_id: SAGE.id, role: 'lead', position: 0 }],
    };
    api.listConversations.mockResolvedValue({
      conversations: [group, summary('dm-old', OLD), summary('dm-sage', SAGE)],
    });
    await renderPage('');
    expect(window.location.hash).toBe('#/bots?c=dm-sage');
  });

  it('gives a phone its menu button when Bots are not available (403)', async () => {
    api.listBots.mockRejectedValue(new BotsApiError('Forbidden', 403));
    await renderPage('');
    expect(document.body.textContent).toContain('Bots are not available');
    expect(document.querySelector('button[aria-label="Navigation"]')).not.toBeNull();
  });

  it('gives a phone its menu button while loading', async () => {
    api.listBots.mockReturnValue(new Promise(() => {}));
    await renderPage('');
    expect(document.querySelector('button[aria-label="Navigation"]')).not.toBeNull();
  });
});

describe('Bots workspace', () => {
  it('titles an archived Bot’s DM as archived and offers no composer', async () => {
    api.getConversation.mockResolvedValue({ conversation: detail('dm-old', OLD), messages: [], has_more: false });
    api.fetchComputerStatus.mockResolvedValue(computer({ state: 'absent' }));
    await renderPage('c=dm-old');

    expect(document.querySelector('[data-testid="bots-conversation-header"]')?.textContent).toContain('Old (archived)');
    expect(document.querySelector('[data-testid="bots-read-only"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="chat-input"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Deleted Bot');
  });

  it('keeps a retired group chat readable — speakers by their real names — and closed to messages', async () => {
    const group: BotConversationDetail = {
      ...detail('grp-1', SAGE),
      kind: 'group',
      title: 'Launch prep',
      owner_bot_id: null,
      members: [
        { bot_id: SAGE.id, role: 'lead', position: 0 },
        { bot_id: OLD.id, role: 'member', position: 1 },
      ],
    };
    const said = (id: string, botId: string, seq: number) => ({
      id,
      role: 'assistant' as const,
      content: `hello from ${botId}`,
      bot_id: botId,
      bot_event: null,
      pipeline: [],
      references: [],
      reasoning: null,
      model: null,
      images: [],
      created_at: '2026-10-05T00:00:00.000Z',
      seq,
    });
    api.getConversation.mockResolvedValue({
      conversation: group,
      messages: [said('m1', OLD.id, 1), said('m2', SAGE.id, 2)],
      has_more: false,
    });
    api.fetchComputerStatus.mockResolvedValue(computer({ state: 'absent' }));
    await renderPage('c=grp-1');

    const speakers = [...document.querySelectorAll('[data-testid="bots-speaker"]')].map((el) => el.textContent);
    expect(speakers).toEqual(['Old', 'Sage']);
    expect(document.body.textContent).not.toContain('Deleted Bot');
    // Sage is still active, yet the group takes no message: group chats were retired.
    expect(document.querySelector('[data-testid="chat-input"]')).toBeNull();
    expect(document.querySelector('[data-testid="bots-read-only"]')?.textContent).toContain(
      'Group chats were retired — this one stays as a record.',
    );
  });

  it('shares one computer status between the header and the pane', async () => {
    api.getConversation.mockResolvedValue({ conversation: detail('dm-sage', SAGE), messages: [], has_more: false });
    api.fetchComputerStatus.mockResolvedValue(computer({}));
    await renderPage('c=dm-sage');
    expect(api.fetchComputerStatus).toHaveBeenCalledTimes(1);

    await click(document.querySelector('[data-testid="bots-computer-button"]'));
    expect(document.querySelector('[data-testid="computer-pane"]')).not.toBeNull();
    // Opening the pane starts no second status poller.
    expect(api.fetchComputerStatus).toHaveBeenCalledTimes(1);
  });

  it('asks to hand back before the header’s Info button closes the computer the member controls', async () => {
    api.getConversation.mockResolvedValue({ conversation: detail('dm-sage', SAGE), messages: [], has_more: false });
    api.fetchComputerStatus.mockResolvedValue(
      computer({ controller: 'user', controller_since: '2026-10-05T00:00:00.000Z' }),
    );
    api.handbackComputer.mockResolvedValue(computer({}));
    await renderPage('c=dm-sage');

    await click(document.querySelector('[data-testid="bots-computer-button"]'));
    expect(document.querySelector('[data-testid="bots-computer-host"]')).not.toBeNull();

    await click(document.querySelector('[data-testid="bots-info-button"]'));
    expect(document.body.textContent).toContain('Hand back before closing?');
    expect(document.querySelector('[data-testid="bots-computer-host"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="bots-info-pane"]')).toBeNull();

    await click(document.querySelector('[data-testid="confirm-dialog-confirm"]'));
    expect(api.handbackComputer).toHaveBeenCalledTimes(1);
    // The conversation beside the computer: its single waiting card (if any) is answered.
    expect(api.handbackComputer).toHaveBeenCalledWith({ note: '', requestId: undefined, sessionId: 'dm-sage' });
    expect(document.querySelector('[data-testid="bots-computer-host"]')).toBeNull();
    expect(document.querySelector('[data-testid="bots-info-pane"]')).not.toBeNull();
  });
});

describe('the computer keeps the member’s clock', () => {
  const zone = browserTimeZone();

  it('stores the browser’s timezone once per page load when the computer’s differs', async () => {
    expect(zone).toBeTruthy();
    api.getConversation.mockResolvedValue({ conversation: detail('dm-sage', SAGE), messages: [], has_more: false });
    api.fetchComputerStatus.mockResolvedValue(computer({ timezone: null }));
    await renderPage('c=dm-sage');
    expect(api.updateComputerSettings).toHaveBeenCalledTimes(1);
    expect(api.updateComputerSettings).toHaveBeenCalledWith({ timezone: zone });

    // Back on the page (another conversation, a remount): not asked again this page load.
    await act(async () => root?.unmount());
    root = null;
    await renderPage('c=dm-sage');
    expect(api.updateComputerSettings).toHaveBeenCalledTimes(1);
  });

  it('leaves a computer already on the browser’s timezone alone', async () => {
    api.getConversation.mockResolvedValue({ conversation: detail('dm-sage', SAGE), messages: [], has_more: false });
    api.fetchComputerStatus.mockResolvedValue(computer({ timezone: zone }));
    await renderPage('c=dm-sage');
    expect(api.updateComputerSettings).not.toHaveBeenCalled();
  });

  it('stays quiet when the server refuses (the next page load tries again)', async () => {
    api.getConversation.mockResolvedValue({ conversation: detail('dm-sage', SAGE), messages: [], has_more: false });
    api.fetchComputerStatus.mockResolvedValue(computer({ timezone: 'Etc/UTC' === zone ? null : 'Etc/UTC' }));
    api.updateComputerSettings.mockRejectedValueOnce(new BotsApiError('nope', 400, 'invalid'));
    await renderPage('c=dm-sage');
    expect(api.updateComputerSettings).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('nope');
  });
});
