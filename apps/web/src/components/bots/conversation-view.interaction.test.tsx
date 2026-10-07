/** @vitest-environment happy-dom */

/**
 * The conversation column's states: phones can always reach navigation (the
 * TopBar is hidden on #/bots), nothing renders "Deleted Bot" before the Bot
 * list lands, an archived Bot's DM is read-only with a way forward, and every
 * send path explains a failure.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConversationDetail, BotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { BotsApiError } from '../../lib/api/bots';
import { ToastContainer } from '../ui';
import { ConversationView, type ConversationViewProps } from './conversation-view';
import type { BotConversationController } from './use-bot-conversation';

const api = vi.hoisted(() => ({ listConversationTasks: vi.fn(), listRequests: vi.fn(), listBots: vi.fn() }));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));
vi.mock('../../lib/ws', () => ({ wsClient: { onEvent: () => () => {}, onStatusChange: () => () => {} } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAGE: BotView = {
  id: 'bot_sage',
  name: 'Sage',
  role: 'Researcher',
  instructions: '',
  avatar: { color: 'ocean' },
  model_id: null,
  template_key: null,
  status: 'active',
  dm_session_id: 'dm-sage',
  last_active_at: null,
  created_at: '2026-10-05T00:00:00.000Z',
};

const DM: BotConversationDetail = {
  session_id: 'dm-sage',
  kind: 'direct',
  title: null,
  owner_bot_id: SAGE.id,
  lead_bot_id: SAGE.id,
  members: [{ bot_id: SAGE.id, role: 'owner', position: 0 }],
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
};

function controller(overrides: Partial<BotConversationController> = {}): BotConversationController {
  return {
    state: 'ready',
    error: null,
    conversation: DM,
    setConversation: vi.fn(),
    messages: [],
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(async () => {}),
    pending: [],
    managed: undefined,
    streaming: false,
    runError: null,
    dismissRunError: vi.fn(),
    requests: new Map(),
    applyRequest: vi.fn(),
    memoryStates: {},
    reload: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    stop: vi.fn(),
    stopPhase: null,
    interrupting: false,
    handleNow: vi.fn(async () => {}),
    ...overrides,
  };
}

function props(overrides: Partial<ConversationViewProps> = {}): ConversationViewProps {
  return {
    sessionId: 'dm-sage',
    controller: controller(),
    members: [SAGE],
    owner: SAGE,
    lookup: (key) => (key === SAGE.id ? SAGE : undefined),
    title: 'Sage',
    botsState: 'ready',
    onRetryBots: vi.fn(),
    readOnly: false,
    onReadOnly: vi.fn(),
    vaultAvailable: false,
    computerPhase: null,
    activePane: null,
    onPane: vi.fn(),
    onInvite: vi.fn(),
    onNewBot: vi.fn(),
    onOpenProfile: vi.fn(),
    ...overrides,
  };
}

let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(p: ConversationViewProps) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement('div', null, createElement(ConversationView, p), createElement(ToastContainer)),
      }),
    ),
  );
  await flush();
}

const navButton = () => document.querySelector('button[aria-label="Navigation"]');

beforeEach(() => {
  api.listConversationTasks.mockReset();
  api.listConversationTasks.mockResolvedValue({ tasks: [] });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('ConversationView on a phone', () => {
  it.each([
    ['loading', props({ controller: controller({ state: 'loading', conversation: null }) })],
    ['Bot list still loading', props({ botsState: 'loading' })],
    ['load failed', props({ controller: controller({ state: 'error', conversation: null, error: 'HTTP 500' }) })],
    ['not found', props({ controller: controller({ state: 'not_found', conversation: null }) })],
    ['Bot list failed', props({ botsState: 'error' })],
  ])('offers the navigation button while %s', async (_label, p) => {
    await render(p);
    expect(navButton()).not.toBeNull();
  });
});

describe('ConversationView before the Bot list lands', () => {
  it('shows a skeleton — never "Deleted Bot" — until the Bot list arrives', async () => {
    await render(props({ botsState: 'loading', owner: undefined, members: [], title: '' }));
    expect(document.querySelector('[data-testid="bots-conversation-loading"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Deleted Bot');
    expect(document.querySelector('[data-testid="chat-input"]')).toBeNull();
  });

  it('shows a failed Bot list with a retry instead of guessing names', async () => {
    const onRetryBots = vi.fn();
    await render(props({ botsState: 'error', onRetryBots }));
    expect(document.body.textContent).toContain('Could not load your Bots');
    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Try again');
    await act(async () => retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onRetryBots).toHaveBeenCalledTimes(1);
  });
});

describe('an archived Bot’s DM', () => {
  const archived = { ...SAGE, status: 'archived' as const };

  it('is read-only: no composer, an explanation, and a way to start a new Bot', async () => {
    const onNewBot = vi.fn();
    await render(props({ owner: archived, members: [], title: 'Sage (archived)', readOnly: true, onNewBot }));
    expect(document.querySelector('[data-testid="chat-input"]')).toBeNull();
    const notice = document.querySelector('[data-testid="bots-read-only"]');
    expect(notice?.textContent).toContain('Sage is archived and no longer replies');
    expect(document.querySelector('[data-testid="bots-conversation-header"]')?.textContent).toContain(
      'Sage (archived)',
    );
    // No guests in a DM nobody leads any more.
    expect(document.querySelector('button[aria-label="Invite a Bot"]')).toBeNull();

    await act(async () =>
      document
        .querySelector('[data-testid="bots-read-only-new-bot"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onNewBot).toHaveBeenCalledTimes(1);
  });

  it('turns a refused send (409 read-only) into a re-read and a plain explanation', async () => {
    const onReadOnly = vi.fn();
    const send = vi.fn(async () => {
      throw new BotsApiError('This Bot is archived', 409, 'bot_archived');
    });
    await render(props({ controller: controller({ send }), onReadOnly }));

    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'are you there?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(onReadOnly).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('this conversation is read-only');
    // The notice replaces the composer at once — before (or even without) the
    // re-read: the host's `readOnly` is still false here.
    expect(document.querySelector('[data-testid="chat-input"]')).toBeNull();
    expect(document.querySelector('[data-testid="bots-read-only"]')?.textContent).toContain(
      'Sage is archived and no longer replies',
    );
  });
});

describe('a group nobody can answer in', () => {
  const GROUP: BotConversationDetail = {
    ...DM,
    session_id: 'grp-1',
    kind: 'group',
    title: 'Launch prep',
    owner_bot_id: null,
    members: [{ bot_id: SAGE.id, role: 'lead', position: 0 }],
  };

  async function sendRefused(onInvite = vi.fn(), onReadOnly = vi.fn()) {
    const send = vi.fn(async () => {
      throw new BotsApiError('No Bot in this conversation can reply', 409, 'no_active_members');
    });
    await render(
      props({
        sessionId: 'grp-1',
        controller: controller({ send, conversation: GROUP }),
        owner: undefined,
        title: 'Launch prep',
        onInvite,
        onReadOnly,
      }),
    );
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'status?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await flush();
    return { onInvite, onReadOnly };
  }

  it('prompts to invite a Bot when the API says no one here can reply', async () => {
    const { onInvite, onReadOnly } = await sendRefused();
    expect(onReadOnly).toHaveBeenCalledTimes(1);
    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('No Bot here can reply — invite one to continue.');
    const notice = document.querySelector('[data-testid="bots-read-only"]');
    expect(notice?.textContent).toContain('No Bot here can reply');
    expect([...(notice?.querySelectorAll('button') ?? [])].some((b) => b.textContent?.includes('Invite a Bot'))).toBe(
      true,
    );
  });
});

describe('one-click lines', () => {
  it('reports a failed "Retry" instead of failing silently', async () => {
    const send = vi.fn(async () => {
      throw new Error('Forbidden');
    });
    const failed = {
      id: 'm1',
      role: 'system' as const,
      content: "Sage couldn't reply",
      bot_id: SAGE.id,
      bot_event: { kind: 'turn_error' as const, bot_id: SAGE.id, error: 'boom' },
      pipeline: [],
      references: [],
      reasoning: null,
      model: null,
      images: [],
      created_at: '2026-10-05T00:00:00.000Z',
      seq: 1,
    };
    await render(props({ controller: controller({ send, messages: [failed] }) }));

    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Retry'));
    expect(retry).toBeDefined();
    await act(async () => retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Could not send: Forbidden');
  });
});

describe('the status line', () => {
  it('waits for a hand-back, not a take-over, on a card the computer raised itself', async () => {
    const implicit = {
      id: 'brq_take',
      session_id: 'dm-sage',
      bot_id: SAGE.id,
      kind: 'takeover' as const,
      status: 'pending' as const,
      payload: { implicit: true, reason: 'waiting' } as unknown as BotConversationDetail['requests'][number]['payload'],
      result: null,
      expires_at: null,
      created_at: '2026-10-05T00:00:00.000Z',
    };
    await render(props({ controller: controller({ requests: new Map([[implicit.id, implicit]]) }) }));
    expect(document.querySelector('[data-testid="bots-status-line"]')?.textContent).toBe(
      'Waiting for you to hand the computer back',
    );
  });
});
