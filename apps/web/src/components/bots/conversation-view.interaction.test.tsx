/** @vitest-environment happy-dom */

/**
 * The conversation column's states: phones can always reach navigation (the
 * TopBar is hidden on #/bots), nothing renders "Deleted Bot" before the Bot
 * list lands, an archived Bot's DM is read-only with a way forward, a retired
 * group chat is a read-only record, and every send path explains a failure.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConversationDetail, BotView, SharedBotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { BotsApiError } from '../../lib/api/bots';
import { ToastContainer } from '../ui';
import { useProfileStore } from '../../stores';
import { ConversationView, isReadOnlySendError, type ConversationViewProps } from './conversation-view';
import { queueFirstSend, takeFirstSend } from './first-send';
import { resetReplyRatings, seedReplyRatings } from './reply-feedback';
import { sharedBotAsView, useBotsStore } from './bots-store';
import type { BotConversationController } from './use-bot-conversation';
import type { RoomView } from './use-room';

const api = vi.hoisted(() => ({
  listConversationTasks: vi.fn(),
  listRequests: vi.fn(),
  listBots: vi.fn(),
  updateTaskChat: vi.fn(),
  rateReply: vi.fn(),
  unrateReply: vi.fn(),
}));
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
  description: '',
  tools: null,
  connectors: null,
  max_steps: null,
  current_version: 1,
  user_id: 'u1',
  updated_at: '2026-10-05T00:00:00.000Z',
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
    rewind: vi.fn(async () => {}),
    stop: vi.fn(),
    stopPhase: null,
    interrupting: false,
    handleNow: vi.fn(async () => {}),
    ...overrides,
    // Outside a room a run on screen is always the member's to stop.
    canStop: overrides.canStop ?? overrides.streaming ?? false,
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
    expect(document.body.textContent).not.toContain('Deleted Agent');
    expect(document.querySelector('[data-testid="chat-input"]')).toBeNull();
  });

  it('shows a failed Bot list with a retry instead of guessing names', async () => {
    const onRetryBots = vi.fn();
    await render(props({ botsState: 'error', onRetryBots }));
    expect(document.body.textContent).toContain('Could not load your Agents');
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
    expect(document.querySelector('button[aria-label="Invite an Agent"]')).toBeNull();

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

describe('a retired group chat', () => {
  const FERN: BotView = { ...SAGE, id: 'bot_fern', name: 'Fern', dm_session_id: 'dm-fern' };
  const GROUP: BotConversationDetail = {
    ...DM,
    session_id: 'grp-1',
    kind: 'group',
    title: 'Launch prep',
    owner_bot_id: null,
    members: [
      { bot_id: SAGE.id, role: 'lead', position: 0 },
      { bot_id: FERN.id, role: 'member', position: 1 },
    ],
  };
  const lookup = (key: string | null | undefined) => [SAGE, FERN].find((bot) => bot.id === key);
  const said = (seq: number, botId: string, content: string) => ({
    id: `m${seq}`,
    role: 'assistant' as const,
    content,
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

  it('is a read-only record — even when its Bots are all active and the host did not say so', async () => {
    await render(
      props({
        sessionId: 'grp-1',
        controller: controller({
          conversation: GROUP,
          messages: [said(1, SAGE.id, 'Sage found three vendors.'), said(2, FERN.id, 'Fern tightened it.')],
        }),
        members: [SAGE, FERN],
        owner: undefined,
        lookup,
        title: 'Launch prep',
        readOnly: false,
      }),
    );
    // History renders as before: one speaker line per speaker.
    const speakers = [...document.querySelectorAll('[data-testid="bots-speaker"]')].map((el) => el.textContent);
    expect(speakers).toEqual(['Sage', 'Fern']);
    // …but nothing addresses its Bots any more.
    expect(document.querySelector('[data-testid="chat-input"]')).toBeNull();
    const notice = document.querySelector('[data-testid="bots-read-only"]');
    expect(notice?.textContent).toContain('Group chats were retired — this one stays as a record.');
    expect(notice?.querySelectorAll('button')).toHaveLength(0);
    expect(document.querySelector('button[aria-label="Invite an Agent"]')).toBeNull();
    // No "2 Bots · Lead: Sage" status: the header says what it is.
    expect(document.querySelector('[data-testid="bots-status-line"]')?.textContent).toBe(
      'Retired group chat — read-only',
    );
  });

  it('reads a 409 group_closed like any read-only refusal', () => {
    expect(isReadOnlySendError(new BotsApiError('Group chats are retired', 409, 'group_closed'))).toBe(true);
    expect(isReadOnlySendError(new BotsApiError('This Bot was archived', 409, 'bot_archived'))).toBe(true);
    expect(isReadOnlySendError(new BotsApiError('Busy', 409, 'deciding'))).toBe(false);
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

describe('a separate chat (kind "task")', () => {
  const TASK: BotConversationDetail = { ...DM, session_id: 'task-1', kind: 'task', title: null, model_id: 'flash' };
  const MODELS = [
    { id: 'flash', name: 'Flash' },
    { id: 'pro', name: 'Pro' },
  ];
  const row = (seq: number, role: 'user' | 'assistant', content: string) => ({
    id: `m${seq}`,
    role,
    content,
    bot_id: role === 'assistant' ? SAGE.id : null,
    bot_event: null,
    pipeline: [],
    references: [],
    reasoning: null,
    model: null,
    images: [],
    created_at: '2026-10-05T00:00:00.000Z',
    seq,
  });
  const taskProps = (overrides: Partial<BotConversationController> = {}, extra: Partial<ConversationViewProps> = {}) =>
    props({
      sessionId: 'task-1',
      title: 'New chat',
      controller: controller({ conversation: TASK, ...overrides }),
      ...extra,
    });
  const click = async (element: Element | null | undefined) => {
    await act(async () => element?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
  };
  const button = (label: string) =>
    [...document.querySelectorAll('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label,
    );
  const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  beforeEach(() => {
    useProfileStore.setState({ models: MODELS, initialized: true });
    api.updateTaskChat.mockReset().mockImplementation(async (_id: string, changes: Record<string, unknown>) => ({
      conversation: { ...TASK, ...changes },
    }));
  });
  afterEach(async () => {
    // Still mounted here (the file's own afterEach unmounts after this one).
    await act(async () => useProfileStore.setState({ models: [], initialized: false }));
    takeFirstSend('task-1');
  });

  it('is headed by its own title and its Agent, and says it is separate', async () => {
    await render(taskProps());
    const header = document.querySelector('[data-testid="bots-conversation-header"]');
    expect(header?.textContent).toContain('New chat');
    expect(document.querySelector('[data-testid="bots-status-line"]')?.textContent).toBe('Chat with Sage');
    expect(document.querySelector('[data-testid="bots-intro"]')?.textContent).toContain(
      'A separate chat with Sage, with its own context',
    );
    // A DM has neither: its Agent's own model, a name that is the Agent's.
    expect(document.body.textContent).toContain('flash');
  });

  it('picks its model in the composer, remembers it on the chat and sends it with each message', async () => {
    const send = vi.fn(async () => {});
    const setConversation = vi.fn();
    await render(taskProps({ send, setConversation }));

    await click(document.querySelector('button[aria-haspopup="listbox"]'));
    await click(
      [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes('pro')),
    );
    expect(api.updateTaskChat).toHaveBeenCalledWith('task-1', { model_id: 'pro' });
    expect(setConversation).toHaveBeenCalledWith(expect.objectContaining({ model_id: 'pro' }));

    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
    await type(input, 'Compare the vendors');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await flush();
    expect(send).toHaveBeenCalledWith('Compare the vendors', { images: [], mentions: [], model: 'pro' });
  });

  it('renames itself from the header', async () => {
    const setConversation = vi.fn();
    await render(taskProps({ setConversation }));
    await click(button('Rename chat'));
    const field = document.querySelector<HTMLInputElement>('[data-testid="bots-title-input"]')!;
    expect(field.value).toBe('New chat');
    await type(field, 'Vendor shortlist');
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await flush();
    expect(api.updateTaskChat).toHaveBeenCalledWith('task-1', { title: 'Vendor shortlist' });
    expect(setConversation).toHaveBeenCalledWith(expect.objectContaining({ title: 'Vendor shortlist' }));
  });

  it('sends the message the new-chat page handed over — once — and gives it back as a draft if refused', async () => {
    const send = vi.fn(async () => {
      throw new Error('Forbidden');
    });
    queueFirstSend('task-1', {
      content: 'Plan the launch',
      images: [{ id: 'img', url: '/img' }],
      draft: 'Plan the launch',
    });
    await render(taskProps({ send }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('Plan the launch', {
      images: [{ id: 'img', url: '/img' }],
      mentions: [],
      model: 'flash',
    });
    expect(document.body.textContent).toContain('Could not send: Forbidden');
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')?.value).toBe('Plan the launch');
  });

  it('edits the last message and answers it again — not an earlier one, not while a reply runs', async () => {
    const rewind = vi.fn(async () => {});
    const messages = [
      row(1, 'user', 'first'),
      row(2, 'assistant', 'one'),
      row(3, 'user', 'second'),
      row(4, 'assistant', 'two'),
    ];
    await render(taskProps({ rewind, messages }));

    // One "Edit" (the last member message) and one "answer again" (the last reply).
    const edits = [...document.querySelectorAll('button')].filter((candidate) => candidate.textContent === 'Edit');
    expect(edits).toHaveLength(1);
    expect(document.querySelectorAll('button[aria-label="Regenerate response"]')).toHaveLength(1);

    await click(edits[0]);
    const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="bots-transcript"] textarea')!;
    await type(editor, 'second, but shorter');
    await click(button('Save & Resend'));
    expect(rewind).toHaveBeenCalledWith('m3', 'second, but shorter');

    await click(document.querySelector('button[aria-label="Regenerate response"]'));
    await click(button('Regenerate'));
    expect(rewind).toHaveBeenLastCalledWith('m3');
  });

  it('offers neither while a reply is running', async () => {
    const messages = [row(1, 'user', 'first'), row(2, 'assistant', 'one')];
    await render(taskProps({ messages, streaming: true }));
    expect([...document.querySelectorAll('button')].some((candidate) => candidate.textContent === 'Edit')).toBe(false);
    expect(document.querySelector('button[aria-label="Regenerate response"]')).toBeNull();
  });

  it('explains a refused "answer again" and re-reads the chat', async () => {
    const reload = vi.fn(async () => {});
    const rewind = vi.fn(async () => {
      throw new BotsApiError('A reply is still running here', 409, 'busy');
    });
    const messages = [row(1, 'user', 'first'), row(2, 'assistant', 'one')];
    await render(taskProps({ rewind, reload, messages }));
    await click(document.querySelector('button[aria-label="Regenerate response"]'));
    await click(button('Regenerate'));
    expect(document.body.textContent).toContain('A reply is still running — wait for it to finish.');
    expect(reload).toHaveBeenCalled();
  });

  it('answers a form in a reply as the next message — but not while a reply is still running', async () => {
    const send = vi.fn(async () => {});
    const form = {
      ...row(2, 'assistant', 'Which region?'),
      pipeline: [
        {
          step: 1,
          tool: 'ask_user',
          input: {},
          output: {
            type: 'ask_user',
            status: 'pending',
            title: 'Pick a region',
            questions: [
              {
                id: 'region',
                label: 'Region',
                type: 'single_choice',
                required: true,
                options: [
                  { value: 'eu', label: 'EU' },
                  { value: 'us', label: 'US' },
                ],
              },
            ],
          },
          duration_ms: 1,
        },
      ],
    } as unknown as ReturnType<typeof row>;
    const messages = [row(1, 'user', 'Plan the launch'), form];
    const answer = async () => {
      await click(document.querySelector('input[type="radio"][value="eu"]'));
      await click([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Submit')));
    };

    await render(taskProps({ send, messages, streaming: true }));
    await answer();
    expect(send).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Wait for the current reply to finish');
    if (root) await act(async () => root?.unmount());
    document.body.innerHTML = '';

    await render(taskProps({ send, messages }));
    await answer();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Region**: EU'), {
      images: [],
      mentions: [],
      model: 'flash',
    });
  });

  it('keeps a DM on its Agent: no model picker, no edit, no rename', async () => {
    const messages = [row(1, 'user', 'first'), row(2, 'assistant', 'one')];
    await render(props({ controller: controller({ messages }) }));
    expect(document.querySelector('button[aria-haspopup="listbox"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Regenerate response"]')).toBeNull();
    expect(button('Rename chat')).toBeUndefined();
  });
});

describe("a DM with someone else's public Agent (P4)", () => {
  const ORACLE: SharedBotView = {
    id: 'bot_oracle',
    name: 'Oracle',
    role: 'Analyst',
    description: 'Answers revenue questions',
    avatar: { color: 'ocean' },
    template_key: null,
    owner: { id: 'u2', nickname: 'Alice' },
    dm_session_id: 'dm-oracle',
    available: true,
    computer: false,
  };
  const oracle = sharedBotAsView(ORACLE);
  const DM_ORACLE: BotConversationDetail = {
    ...DM,
    session_id: 'dm-oracle',
    owner_bot_id: ORACLE.id,
    lead_bot_id: ORACLE.id,
    members: [{ bot_id: ORACLE.id, role: 'owner', position: 0 }],
  };
  const reply = {
    id: 'm-reply',
    role: 'assistant' as const,
    content: 'Q3 revenue was up 12%.',
    bot_id: ORACLE.id,
    bot_event: null,
    pipeline: [],
    references: [],
    reasoning: null,
    model: null,
    images: [],
    created_at: '2026-10-05T00:00:00.000Z',
    seq: 2,
  };
  const sharedProps = (overrides: Partial<ConversationViewProps> = {}) =>
    props({
      sessionId: 'dm-oracle',
      controller: controller({ conversation: DM_ORACLE, messages: [reply] }),
      members: [oracle],
      owner: oracle,
      lookup: (key) => (key === ORACLE.id ? oracle : undefined),
      title: 'Oracle',
      shared: ORACLE,
      ...overrides,
    });

  beforeEach(() => {
    api.rateReply.mockReset();
    api.rateReply.mockResolvedValue({ ok: true, rating: 1 });
    api.unrateReply.mockReset();
    api.unrateReply.mockResolvedValue(undefined);
    resetReplyRatings();
  });

  afterEach(() => useBotsStore.getState().reset());

  it('names its owner, invites nobody in and hides a computer it was not granted', async () => {
    await render(sharedProps({ showComputer: false }));
    expect(document.querySelector('[data-testid="bots-status-line"]')?.textContent).toBe('Analyst · by Alice');
    expect(document.querySelector('button[aria-label="Invite an Agent"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Invite another Agent"]')).toBeNull();
    expect(document.querySelector('[data-testid="bots-computer-button"]')).toBeNull();
    expect(document.querySelector('[data-testid="chat-input"]')).not.toBeNull();
  });

  it('rates a reply: 👍 at once, 👎 with an optional line', async () => {
    await render(sharedProps());
    const feedback = document.querySelector('[data-testid="bots-reply-feedback"]')!;
    const [up, down] = [...feedback.querySelectorAll('button')];
    await act(async () => up!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(api.rateReply).toHaveBeenCalledWith('dm-oracle', 'm-reply', 1, undefined);
    expect(feedback.getAttribute('data-rating')).toBe('1');

    await act(async () => down!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    // The rating is saved first; the line is optional.
    expect(api.rateReply).toHaveBeenLastCalledWith('dm-oracle', 'm-reply', -1, undefined);
    const comment = document.querySelector<HTMLTextAreaElement>('[data-testid="bots-reply-feedback-comment"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(comment, 'Missed Q4');
      comment.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      document
        .querySelector('[data-testid="bots-reply-feedback-send"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await flush();
    expect(api.rateReply).toHaveBeenLastCalledWith('dm-oracle', 'm-reply', -1, 'Missed Q4');
    expect(document.querySelector('[data-testid="bots-reply-feedback-comment"]')).toBeNull();
  });

  it("shows the member's rating from the page, and a second press takes it back", async () => {
    // The page said: rated 👎 earlier (a reload).
    seedReplyRatings([reply], { 'm-reply': -1 });
    await render(sharedProps());
    const feedback = document.querySelector('[data-testid="bots-reply-feedback"]')!;
    expect(feedback.getAttribute('data-rating')).toBe('-1');

    const down = feedback.querySelectorAll('button')[1]!;
    await act(async () => down.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(api.unrateReply).toHaveBeenCalledWith('dm-oracle', 'm-reply');
    expect(api.rateReply).not.toHaveBeenCalled();
    expect(feedback.getAttribute('data-rating')).toBe('');
    // Taking a 👎 back asks for nothing.
    expect(document.querySelector('[data-testid="bots-reply-feedback-comment"]')).toBeNull();

    // A page asked before that landed does not bring the old rating back.
    await act(async () => seedReplyRatings([reply], { 'm-reply': -1 }));
    expect(feedback.getAttribute('data-rating')).toBe('');
  });

  it('puts the rating back when taking it back fails', async () => {
    api.unrateReply.mockRejectedValue(new BotsApiError('Internal error', 500));
    seedReplyRatings([reply], { 'm-reply': 1 });
    await render(sharedProps());
    const feedback = document.querySelector('[data-testid="bots-reply-feedback"]')!;
    const up = feedback.querySelectorAll('button')[0]!;
    await act(async () => up.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(api.unrateReply).toHaveBeenCalledTimes(1);
    expect(feedback.getAttribute('data-rating')).toBe('1');
    expect(document.body.textContent).toContain('Could not save your rating');
  });

  it("offers no rating on the member's own Agents' replies", async () => {
    await render(props({ controller: controller({ messages: [{ ...reply, bot_id: SAGE.id }] }) }));
    expect(document.querySelector('[data-testid="bots-reply-feedback"]')).toBeNull();
  });

  it('turns a 409 agent_unavailable into a read-only notice that points to other Agents', async () => {
    const onReadOnly = vi.fn();
    const send = vi.fn(async () => {
      throw new BotsApiError('This Agent is no longer available', 409, 'agent_unavailable');
    });
    expect(isReadOnlySendError(new BotsApiError('x', 409, 'agent_unavailable'))).toBe(true);
    await render(
      sharedProps({ controller: controller({ conversation: DM_ORACLE, messages: [reply], send }), onReadOnly }),
    );

    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'hello?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await flush();

    expect(onReadOnly).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('This Agent is no longer available — the conversation is read-only.');
    const notice = document.querySelector('[data-testid="bots-read-only"]')!;
    expect(notice.getAttribute('data-reason')).toBe('agent_unavailable');
    expect(notice.textContent).toContain('Oracle is no longer available');
    // No "New Agent" here — the way on is someone else's Agent.
    expect(document.querySelector('[data-testid="bots-read-only-new-bot"]')).toBeNull();
    await act(async () => notice.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(useBotsStore.getState().dialog).toEqual({ kind: 'directory' });
  });

  it('shows a reached daily allowance as a line, not an archive', async () => {
    const capped = {
      ...reply,
      id: 'm-cap',
      role: 'system' as const,
      content: '',
      bot_event: { kind: 'unavailable' as const, bot_id: ORACLE.id, reason: 'daily_cap' as const },
      seq: 3,
    };
    await render(sharedProps({ controller: controller({ conversation: DM_ORACLE, messages: [reply, capped] }) }));
    const row = document.querySelector('[data-event-kind="unavailable"]');
    expect(row?.textContent).toContain("You've used today's allowance with Oracle.");
  });
});

describe('a conversation with other people (a room, P5)', () => {
  const BEN_AGENT: BotView = { ...SAGE, id: 'bot_ben', name: "Ben's Agent", role: '', user_id: 'u3' };
  const ROOM: BotConversationDetail = {
    ...DM,
    session_id: 'room-1',
    kind: 'room',
    title: 'Launch',
    owner_bot_id: null,
    lead_bot_id: null,
    members: [
      { bot_id: SAGE.id, role: 'member', position: 0, owner_user_id: 'u1', addressable: true },
      { bot_id: BEN_AGENT.id, role: 'member', position: 1, owner_user_id: 'u3', addressable: false },
    ],
    participants: [
      { user_id: 'u1', nickname: 'Mia', role: 'owner', joined_at: '' },
      { user_id: 'u2', nickname: 'Ana', role: 'member', joined_at: '' },
      { user_id: 'u3', nickname: 'Ben', role: 'member', joined_at: '' },
    ],
  };
  const room = (extra: Partial<RoomView> = {}): RoomView => ({
    me: 'u1',
    ownerId: 'u1',
    isOwner: true,
    participants: ROOM.participants!,
    others: ROOM.participants!.slice(1),
    privateChat: false,
    agents: [
      { member: ROOM.members[0], bot: SAGE, mine: true, addressable: true, removable: true },
      { member: ROOM.members[1], bot: BEN_AGENT, mine: false, addressable: false, removable: true },
    ],
    addressable: [SAGE],
    faces: new Map([
      [SAGE.id, SAGE],
      [BEN_AGENT.id, BEN_AGENT],
    ]),
    personName: (id) => ROOM.participants!.find((p) => p.user_id === id)?.nickname ?? 'Someone who left',
    ...extra,
  });
  const roomMenu = [
    { label: 'Add people', onClick: vi.fn() },
    { label: 'Bring or remove Agents', onClick: vi.fn() },
    { label: 'Leave conversation', onClick: vi.fn(), danger: true },
  ];
  const roomProps = (overrides: Partial<ConversationViewProps> = {}) =>
    props({
      sessionId: ROOM.session_id,
      controller: controller({ conversation: ROOM }),
      members: [SAGE, BEN_AGENT],
      owner: undefined,
      lookup: (key) => (key === SAGE.id ? SAGE : key === BEN_AGENT.id ? BEN_AGENT : undefined),
      title: 'Launch',
      room: room(),
      roomMenu,
      onRenameRoom: vi.fn(async () => {}),
      onBringAgent: vi.fn(),
      ...overrides,
    });
  const header = () => document.querySelector<HTMLElement>('[data-testid="bots-conversation-header"]')!;
  const status = () => document.querySelector('[data-testid="bots-status-line"]')?.textContent;
  const menuLabels = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);

  it('heads it with its people and how many are here, and manages it from a menu — no invite, no computer', async () => {
    await render(roomProps());
    expect(header().querySelectorAll('[data-testid="person-avatar"]')).toHaveLength(2);
    expect(status()).toBe('3 people · 2 Agents');
    expect(document.querySelector('[data-testid="bots-computer-button"]')).toBeNull();
    expect(header().querySelector('button[aria-label="Invite an Agent"]')).toBeNull();

    await act(async () => document.querySelector<HTMLElement>('[data-testid="room-manage"]')!.click());
    expect(menuLabels()).toEqual(['Rename', 'Add people', 'Bring or remove Agents', 'Leave conversation']);
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][0].click());
    expect(document.querySelector<HTMLInputElement>('[data-testid="bots-title-input"]')?.value).toBe('Launch');
  });

  it('says so when the member is the only one left', async () => {
    const alone = ROOM.participants!.slice(0, 1);
    await render(
      roomProps({
        controller: controller({ conversation: { ...ROOM, members: ROOM.members.slice(0, 1), participants: alone } }),
        room: room({ participants: alone, others: [], agents: room().agents.slice(0, 1) }),
      }),
    );
    expect(status()).toBe('Only you · 1 Agent');
  });

  it('calls a private chat that, names the other person, and offers no rename', async () => {
    const ana = ROOM.participants!.slice(0, 2);
    await render(
      roomProps({
        controller: controller({ conversation: { ...ROOM, title: null, members: [], participants: ana } }),
        members: [],
        title: 'Ana',
        room: room({ privateChat: true, participants: ana, others: ana.slice(1), agents: [], addressable: [] }),
      }),
    );
    expect(status()).toBe('Private chat');
    expect(header().querySelectorAll('[data-testid="person-avatar"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="bots-intro"]')?.textContent).toContain(
      'the beginning of your private chat with Ana',
    );
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')?.placeholder).toBe('Message Ana…');
    await act(async () => document.querySelector<HTMLElement>('[data-testid="room-manage"]')!.click());
    expect(menuLabels()).not.toContain('Rename');
  });

  it('offers only the Agents the member may address in the @ list, and says they answer only then', async () => {
    await render(roomProps());
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
    expect(input.placeholder).toBe('Message Launch — Agents answer only when you @ them');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '@');
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const options = [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    expect(options.some((text) => text?.includes('Sage'))).toBe(true);
    expect(options.some((text) => text?.includes("Ben's Agent"))).toBe(false);
  });

  it("offers Stop only for a run the member may stop — never someone else's", async () => {
    await render(roomProps({ controller: controller({ conversation: ROOM, streaming: true, canStop: false }) }));
    expect(document.querySelector('[data-testid="bots-stop"]')).toBeNull();
    if (root) await act(async () => root?.unmount());
    document.body.innerHTML = '';
    await render(roomProps({ controller: controller({ conversation: ROOM, streaming: true, canStop: true }) }));
    expect(document.querySelector('[data-testid="bots-stop"]')).not.toBeNull();
  });

  it("puts other people's messages on the left under their names, and the member's own on the right", async () => {
    const at = '2026-10-12T00:00:00.000Z';
    const row = (id: string, author: string, content: string, seq: number) => ({
      id,
      role: 'user' as const,
      content,
      bot_id: null,
      bot_event: null,
      author_user_id: author,
      pipeline: [],
      references: [],
      reasoning: null,
      model: null,
      images: [],
      created_at: at,
      seq,
    });
    await render(
      roomProps({
        controller: controller({
          conversation: ROOM,
          messages: [row('m1', 'u2', 'morning all', 1), row('m2', 'u2', 'agenda?', 2), row('m3', 'u1', 'here', 3)],
        }),
      }),
    );
    const names = [...document.querySelectorAll('[data-testid="room-person-name"]')].map((el) => el.textContent);
    expect(names).toEqual(['Ana']); // once, while she keeps talking
    const bubbles = [...document.querySelectorAll('[data-transcript-kind]')].map((el) =>
      el.getAttribute('data-transcript-kind'),
    );
    expect(bubbles).toEqual(['person', 'person', 'user']);
    const sides = [...document.querySelectorAll('[data-transcript-kind] .animate-fade-in')].map((el) =>
      el.className.includes('justify-start') ? 'left' : 'right',
    );
    expect(sides).toEqual(['left', 'left', 'right']);
  });

  it('offers Retry only on an Agent the member may ask again', async () => {
    const failed = (id: string, botId: string, seq: number) => ({
      id,
      role: 'system' as const,
      content: '',
      bot_id: botId,
      bot_event: { kind: 'turn_error' as const, bot_id: botId, error: 'x' },
      author_user_id: null,
      pipeline: [],
      references: [],
      reasoning: null,
      model: null,
      images: [],
      created_at: '2026-10-12T00:00:00.000Z',
      seq,
    });
    await render(
      roomProps({
        controller: controller({
          conversation: ROOM,
          messages: [failed('e1', BEN_AGENT.id, 1), failed('e2', SAGE.id, 2)],
        }),
      }),
    );
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="bots-event"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).not.toContain('Retry');
    expect(rows[1].textContent).toContain('Retry');
  });
});
