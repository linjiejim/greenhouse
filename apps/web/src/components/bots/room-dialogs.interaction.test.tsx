/** @vitest-environment happy-dom */

/**
 * Rooms (spec 20261011-agent-first-class P5): "New conversation with people" (pick people, an
 * optional title, optional Agents — one person alone is the pair's private chat), adding people to
 * a room, and bringing / taking out Agents. Refusals read in the member's words.
 */

import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConversationDetail, BotView, SharedBotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { BotsApiError } from '../../lib/api/bots';
import { useAuthStore } from '../../stores';
import { ToastContainer } from '../ui';
import { useBotsStore } from './bots-store';
import { AddPeopleDialog, NewRoomDialog, RoomAgentsDialog } from './room-dialogs';
import type { RoomView } from './use-room';

const api = vi.hoisted(() => ({
  listRoomPeople: vi.fn(),
  createRoom: vi.fn(),
  addRoomPerson: vi.fn(),
  addRoomAgent: vi.fn(),
  removeRoomAgent: vi.fn(),
  listPublicAgents: vi.fn(),
  listConversations: vi.fn(),
}));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function bot(id: string, name: string, extra: Partial<BotView> = {}): BotView {
  return {
    id,
    name,
    role: '',
    instructions: '',
    avatar: { color: 'forest' },
    model_id: null,
    template_key: null,
    status: 'active',
    description: '',
    tools: null,
    connectors: null,
    max_steps: null,
    current_version: 1,
    user_id: 'u1',
    updated_at: '',
    dm_session_id: null,
    last_active_at: null,
    created_at: '',
    ...extra,
  };
}

const SAGE = bot('bot_sage', 'Sage', { role: 'Researcher' });
const FERN = bot('bot_fern', 'Fern');
const PEOPLE = [
  { id: 'u2', nickname: 'Ana', email: 'ana@example.com' },
  { id: 'u3', nickname: 'Ben', email: 'ben@example.com' },
];

const ROOM: BotConversationDetail = {
  session_id: 'room-1',
  kind: 'room',
  title: 'Launch',
  owner_bot_id: null,
  lead_bot_id: null,
  members: [
    {
      bot_id: SAGE.id,
      role: 'member',
      position: 0,
      owner_user_id: 'u1',
      brought_by_user_id: 'u1',
      addressable: true,
      profile: { name: SAGE.name, role: SAGE.role, avatar: SAGE.avatar, template_key: null },
    },
    {
      bot_id: 'bot_ben',
      role: 'member',
      position: 1,
      owner_user_id: 'u3',
      brought_by_user_id: 'u3',
      addressable: false,
      profile: { name: 'Scout', role: '', avatar: {}, template_key: null },
    },
  ],
  participants: [
    { user_id: 'u1', nickname: 'Mia', role: 'member', joined_at: '' },
    { user_id: 'u2', nickname: 'Ana', role: 'owner', joined_at: '' },
  ],
  last_message: null,
  attention: 'idle',
  pending_requests: 0,
  last_activity_at: '',
  description: '',
  allow_bot_chat: true,
  digest: null,
  notes: [],
  requests: [],
  context: { estimated_tokens: 0, threshold: 1 },
};

let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(element: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement('div', null, element, createElement(ToastContainer)),
      }),
    ),
  );
  await flush();
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click');
  await act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
}

const byLabel = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const button = (testId: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.listRoomPeople.mockResolvedValue(PEOPLE);
  api.listPublicAgents.mockResolvedValue([]);
  api.listConversations.mockResolvedValue({ conversations: [] });
  useBotsStore.setState({ bots: [SAGE, FERN], botsLoaded: true });
  useAuthStore.setState({ currentUser: { id: 'u1', role: 'team', nickname: 'Mia' } });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  useBotsStore.setState({ ...useBotsStore.getInitialState() });
  useAuthStore.setState({ currentUser: null });
  window.location.hash = '';
});

describe('<NewRoomDialog/>', () => {
  it('starts a private chat with one person, and a titled room with Agents', async () => {
    const onClose = vi.fn();
    api.createRoom.mockResolvedValue({ conversation: { ...ROOM, session_id: 'room-new' }, created: true });
    await render(createElement(NewRoomDialog, { open: true, onClose }));

    const create = button('room-create')!;
    expect(create.disabled).toBe(true); // nobody picked yet
    expect(document.querySelectorAll('[data-testid="room-person-option"]')).toHaveLength(2);

    await click(byLabel('Ana'));
    expect(document.querySelector('[data-testid="room-private-hint"]')?.textContent).toContain(
      'your private chat with them',
    );
    expect(create.textContent).toBe('Open private chat');

    await typeInto(document.querySelector<HTMLInputElement>('[data-testid="room-title-field"]')!, 'Launch plan');
    await click(byLabel('Sage'));
    expect(create.textContent).toBe('Start conversation');
    expect(document.querySelector('[data-testid="room-private-hint"]')).toBeNull();

    await click(create);
    expect(api.createRoom).toHaveBeenCalledWith({ userIds: ['u2'], title: 'Launch plan', botIds: [SAGE.id] });
    expect(onClose).toHaveBeenCalled();
    expect(window.location.hash).toBe('#/bots?c=room-new');
  });

  it('searches people by name or email', async () => {
    await render(createElement(NewRoomDialog, { open: true, onClose: vi.fn() }));
    await typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Search people…"]')!, 'ben@');
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="room-person-option"]')];
    expect(rows.map((row) => row.dataset.userId)).toEqual(['u3']);
  });

  it("explains a refusal in the member's words and stays open", async () => {
    const onClose = vi.fn();
    api.createRoom.mockRejectedValue(new BotsApiError('nope', 409));
    await render(createElement(NewRoomDialog, { open: true, onClose }));
    await click(byLabel('Ana'));
    await click(byLabel('Fern'));
    await click(button('room-create'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'That Agent isn’t shared with everyone in this conversation.',
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('<AddPeopleDialog/>', () => {
  it('offers only people not in the room yet, and adds each picked one', async () => {
    const onChanged = vi.fn();
    const onClose = vi.fn();
    const after = { ...ROOM, title: 'after' };
    api.addRoomPerson.mockResolvedValue(after);
    await render(createElement(AddPeopleDialog, { open: true, conversation: ROOM, onClose, onChanged }));
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="room-person-option"]')];
    expect(rows.map((row) => row.dataset.userId)).toEqual(['u3']); // Ana is here already
    await click(byLabel('Ben'));
    await click(button('room-add-people'));
    expect(api.addRoomPerson).toHaveBeenCalledWith('room-1', 'u3');
    expect(onChanged).toHaveBeenCalledWith(after);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('<RoomAgentsDialog/>', () => {
  const view = (extra: Partial<RoomView> = {}): RoomView => ({
    me: 'u1',
    ownerId: 'u2',
    isOwner: false,
    participants: ROOM.participants!,
    others: [ROOM.participants![1]],
    privateChat: false,
    agents: [
      { member: ROOM.members[0], bot: SAGE, mine: true, byline: 'Yours', addressable: true, removable: true },
      {
        member: ROOM.members[1],
        bot: bot('bot_ben', 'Scout', { user_id: 'u3' }),
        mine: false,
        byline: "Ben's",
        addressable: false,
        removable: false,
      },
    ],
    addressable: [SAGE],
    faces: new Map(),
    personName: (id) => (id === 'u3' ? 'Ben' : 'Ana'),
    ...extra,
  });

  it('lists who is here — removable only where the member may — and brings their own or a public Agent', async () => {
    const shared: SharedBotView = {
      id: 'bot_oracle',
      name: 'Oracle',
      role: 'Analyst',
      description: '',
      avatar: {},
      template_key: null,
      owner: { id: 'u4', nickname: 'Zoe' },
      dm_session_id: null,
      available: true,
      computer: false,
    };
    api.listPublicAgents.mockResolvedValue([shared]);
    api.addRoomAgent.mockResolvedValue(ROOM);
    const onChanged = vi.fn();
    await render(
      createElement(RoomAgentsDialog, { open: true, conversation: ROOM, room: view(), onClose: vi.fn(), onChanged }),
    );
    const here = [...document.querySelectorAll<HTMLElement>('[data-testid="room-agent-row"]')];
    expect(here.map((row) => row.dataset.botId)).toEqual([SAGE.id, 'bot_ben']);
    expect(here[0].querySelector('[data-testid="room-agent-remove"]')).not.toBeNull();
    expect(here[1].querySelector('[data-testid="room-agent-remove"]')).toBeNull();
    expect(here[1].textContent).toContain('Scout');
    expect(here[1].textContent).toContain("Ben's");

    const candidates = [...document.querySelectorAll<HTMLElement>('[data-testid="room-agent-candidate"]')];
    expect(candidates.map((row) => row.dataset.botId)).toEqual([FERN.id, 'bot_oracle']);
    await click(candidates[1].querySelector('[data-testid="room-agent-bring"]'));
    expect(api.addRoomAgent).toHaveBeenCalledWith('room-1', 'bot_oracle');
    expect(onChanged).toHaveBeenCalledWith(ROOM);
  });

  it('takes out an Agent and asks the page to re-read', async () => {
    api.removeRoomAgent.mockResolvedValue(undefined);
    const onChanged = vi.fn();
    await render(
      createElement(RoomAgentsDialog, { open: true, conversation: ROOM, room: view(), onClose: vi.fn(), onChanged }),
    );
    await click(document.querySelector('[data-testid="room-agent-remove"]'));
    expect(api.removeRoomAgent).toHaveBeenCalledWith('room-1', SAGE.id);
    expect(onChanged).toHaveBeenCalledWith(null);
  });
});
