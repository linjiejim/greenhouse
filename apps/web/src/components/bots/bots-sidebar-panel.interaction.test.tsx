/**
 * @vitest-environment happy-dom
 *
 * The Agent threads of the conversations sidebar: Sprouty's DM — the main thread — under
 * "Main thread", the other Agents' DMs by activity under "Agents", retired group chats and
 * archived Agents' DMs under "Archived"; the sidebar's one search box filters titles, Agent
 * names and the last message (spec 20261011-agent-first-class §3.1).
 *
 * Sidebar conversation rows: a retired group row's overlapped avatar chips are separated
 * by a ring painted in the row's own colour, so the ring has to follow the row
 * through every state — at rest, under the pointer, active — or it shows as a
 * halo around each chip. A DM nobody can answer any more shows its Bot asleep.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConversationSummary, BotView, SharedBotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { useAuthStore } from '../../stores';
import { useBotsStore } from './bots-store';
import { BotsThreadsSection } from './bots-sidebar-panel';

const api = vi.hoisted(() => ({ bootstrapBots: vi.fn() }));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  bootstrapBots: api.bootstrapBots,
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
    updated_at: '2026-10-05T00:00:00.000Z',
    dm_session_id: `dm-${id}`,
    last_active_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
    ...extra,
  };
}

function conversation(
  session_id: string,
  kind: 'direct' | 'group',
  botIds: string[],
  extra: Partial<BotConversationSummary> = {},
): BotConversationSummary {
  return {
    session_id,
    kind,
    title: kind === 'group' ? 'Launch prep' : null,
    owner_bot_id: kind === 'direct' ? botIds[0] : null,
    lead_bot_id: botIds[0],
    members: botIds.map((bot_id, position) => ({ bot_id, role: position === 0 ? 'owner' : 'member', position })),
    last_message: null,
    attention: 'idle',
    pending_requests: 0,
    last_activity_at: '2026-10-05T00:00:00.000Z',
    ...extra,
  } as BotConversationSummary;
}

const sprouty = bot('bot_sprouty', 'Sprouty', { template_key: 'sprouty', avatar: { plant: 'sprout' } });
const sage = bot('bot_sage', 'Sage');
const fern = bot('bot_fern', 'Fern');
const moss = bot('bot_moss', 'Moss', { status: 'archived' });
const GROUP = 'group-1';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // Loaded already: the panel's mount-time refresh must not reach for the network.
  api.bootstrapBots.mockReset();
  useBotsStore.setState({
    bots: [sprouty, sage, fern],
    archivedBots: [moss],
    // By activity: Sprouty's DM is the quietest, and still comes first.
    conversations: [
      conversation(GROUP, 'group', [sage.id, fern.id], {
        last_message: { role: 'assistant', bot_id: fern.id, preview: 'Draft is ready', created_at: '' },
      } as Partial<BotConversationSummary>),
      conversation('dm-bot_sage', 'direct', [sage.id]),
      conversation('dm-bot_moss', 'direct', [moss.id]),
      conversation('dm-bot_sprouty', 'direct', [sprouty.id], { last_activity_at: '2026-10-01T00:00:00.000Z' }),
    ],
    botsLoaded: true,
    conversationsLoaded: true,
    loadBots: async () => {},
    loadConversations: async () => {},
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useBotsStore.setState({ ...useBotsStore.getInitialState() });
  window.location.hash = '';
});

function mount(currentHash: string, query = '') {
  window.location.hash = currentHash;
  act(() =>
    root.render(
      createElement(I18nProvider, { initialLocale: 'en', children: createElement(BotsThreadsSection, { query }) }),
    ),
  );
}

const row = (sessionId: string) =>
  host.querySelector<HTMLElement>(`[data-testid="bots-conversation-row"][data-session-id="${sessionId}"]`)!;
/** The ring classes on each overlapped chip of a (retired) group row. */
const chipRings = (sessionId: string) =>
  [...row(sessionId).querySelectorAll('[data-testid="plant-avatar-stack"] > span')].map((chip) =>
    chip.className.split(/\s+/).filter((name) => name.includes('ring-') && name !== 'ring-2'),
  );

describe('<BotsThreadsSection/> retired group rows', () => {
  it("paints chip rings the row's resting colour, and its hover fill under the pointer", () => {
    mount('#/bots?c=dm-bot_sage');
    expect(row(GROUP).className.split(/\s+/)).toContain('group');
    expect(row(GROUP).className).toContain('hover:bg-surface-muted');
    const rings = chipRings(GROUP);
    expect(rings).toHaveLength(2);
    for (const ring of rings) expect(ring).toEqual(['ring-surface-chrome', 'group-hover:ring-surface-muted']);
  });

  it('paints chip rings the opaque active fill when the row is the open conversation', () => {
    mount(`#/bots?c=${GROUP}`);
    expect(row(GROUP).className).toContain('sidebar-active-item');
    // Not `primary-subtle-hover`: in dark that is a translucent overlay, which composites over
    // the chip it overlaps instead of over the chrome and shows as a lighter halo.
    for (const ring of chipRings(GROUP)) expect(ring).toEqual(['ring-sidebar-active']);
  });
});

describe('<BotsThreadsSection/> DM rows', () => {
  it("shows an archived Agent's DM asleep and a live one at rest, both still", () => {
    mount('#/bots');
    const svg = (sessionId: string) => row(sessionId).querySelector('svg')!.getAttribute('class') ?? '';
    expect(svg('dm-bot_moss')).toContain('pa-s-sleep');
    expect(svg('dm-bot_sage')).toContain('pa-s-idle');
    expect(host.querySelectorAll('[data-testid="bots-conversation-row"] .pa-mo')).toHaveLength(0);
  });
});

describe('<BotsThreadsSection/> list', () => {
  const order = () =>
    [...host.querySelectorAll<HTMLElement>('[data-testid="bots-conversation-row"]')].map((el) => el.dataset.sessionId);

  it("is one list: the main thread (Sprouty's DM) first, then by activity, archived last", () => {
    mount('#/bots');
    expect(order()).toEqual(['dm-bot_sprouty', 'dm-bot_sage', GROUP, 'dm-bot_moss']);
    expect(row('dm-bot_sprouty').dataset.pinned).toBe('true');
    expect(row(GROUP).dataset.pinned).toBeUndefined();
    expect(api.bootstrapBots).not.toHaveBeenCalled(); // Sprouty is here already
  });

  it('groups the main Agent and other Agents together above People', () => {
    mount('#/bots');
    const labels = [...host.querySelectorAll<HTMLElement>('[data-testid^="sidebar-section-"]')];
    expect(labels.map((el) => el.firstElementChild?.textContent)).toEqual(['Agents', 'People']);
    const [agents, people] = labels;
    const follows = (label: HTMLElement, sessionId: string) =>
      !!(label.compareDocumentPosition(row(sessionId)) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(agents, 'dm-bot_sprouty') && !follows(people, 'dm-bot_sprouty')).toBe(true);
    expect(follows(agents, 'dm-bot_sage')).toBe(true);
  });

  it('keeps creation actions in their own headings and opens Custom directly', () => {
    mount('#/bots');
    const agents = host.querySelector('[data-testid="sidebar-section-agents"]')!;
    const people = host.querySelector('[data-testid="sidebar-section-people"]')!;
    act(() => agents.querySelector<HTMLButtonElement>('[data-testid="sidebar-new-agent"]')!.click());
    expect(useBotsStore.getState().dialog).toEqual({ kind: 'new-bot', customOnly: true });
    act(() => people.querySelector<HTMLButtonElement>('[data-testid="sidebar-new-room"]')!.click());
    expect(useBotsStore.getState().dialog).toEqual({ kind: 'new-room' });
  });

  it('files a retired group chat under Archived, dimmed, even with every Agent in it active', () => {
    mount('#/bots');
    const label = [...host.querySelectorAll('nav span')].find((el) => el.textContent === 'Archived')!;
    expect(label).toBeDefined();
    // Everything after the label is a record: the group and the archived Bot's DM.
    const after = [...host.querySelectorAll<HTMLElement>('[data-testid="bots-conversation-row"]')].filter(
      (el) => label.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(after.map((el) => el.dataset.sessionId)).toEqual([GROUP, 'dm-bot_moss']);
    expect(row(GROUP).className).toContain('opacity-70');
    expect(row('dm-bot_sage').className).not.toContain('opacity-70');
  });

  it('never lists a separate chat as a thread — it belongs with the chats', () => {
    useBotsStore.setState({
      conversations: [
        ...useBotsStore.getState().conversations,
        { ...conversation('task-1', 'direct', [sage.id]), kind: 'task', title: 'Vendor shortlist' },
      ],
    });
    mount('#/bots?c=task-1');
    expect(order()).toEqual(['dm-bot_sprouty', 'dm-bot_sage', GROUP, 'dm-bot_moss']);
  });

  it("filters by the sidebar's search: titles, Agent names and the last message", () => {
    mount('#/bots', 'draft');
    expect(order()).toEqual([GROUP]); // last message
    mount('#/bots', 'SAGE');
    expect(order()).toEqual(['dm-bot_sage', GROUP]); // a member's name, case-insensitive
    mount('#/bots', 'sprout');
    expect(order()).toEqual(['dm-bot_sprouty']);
    mount('#/bots', 'nobody');
    // Nothing matches: the threads step aside (no empty labels) and the chats below speak for the list.
    expect(order()).toEqual([]);
    expect(host.querySelectorAll('[data-testid^="sidebar-section-"]')).toHaveLength(0);
  });

  it('makes sure a member whose Bots predate Sprouty gets it', async () => {
    api.bootstrapBots.mockResolvedValue({ bot: sprouty, dm_session_id: 'dm-bot_sprouty', created: true });
    useBotsStore.setState({ bots: [sage, fern] });
    mount('#/bots');
    await act(async () => {});
    expect(api.bootstrapBots).toHaveBeenCalledTimes(1);
  });

  it('gives a Sprouty that Chat created without a thread its DM', async () => {
    useBotsStore.getState().reset(); // a fresh page load: the once-per-load guard is clear
    api.bootstrapBots.mockResolvedValue({ bot: sprouty, dm_session_id: 'dm-bot_sprouty', created: false });
    useBotsStore.setState({ bots: [{ ...sprouty, dm_session_id: null }, sage, fern], botsLoaded: true });
    mount('#/bots');
    await act(async () => {});
    expect(api.bootstrapBots).toHaveBeenCalledTimes(1);
  });
});

describe("<BotsThreadsSection/> other members' public Agents (P4)", () => {
  const oracle: SharedBotView = {
    id: 'bot_oracle',
    name: 'Oracle',
    role: 'Analyst',
    description: '',
    avatar: { color: 'ocean' },
    template_key: null,
    owner: { id: 'u2', nickname: 'Alice' },
    dm_session_id: 'dm-bot_oracle',
    available: true,
    computer: false,
  };
  const order = () =>
    [...host.querySelectorAll<HTMLElement>('[data-testid="bots-conversation-row"]')].map((el) => el.dataset.sessionId);

  beforeEach(() => {
    useBotsStore.setState({
      sharedBots: [oracle],
      conversations: [
        conversation('dm-bot_oracle', 'direct', [oracle.id], { last_activity_at: '2026-10-06T00:00:00.000Z' }),
        ...useBotsStore.getState().conversations,
      ],
    });
  });

  it("lists its DM with the member's Agents, by name, saying whose it is", () => {
    mount('#/bots');
    expect(order()).toEqual(['dm-bot_sprouty', 'dm-bot_oracle', 'dm-bot_sage', GROUP, 'dm-bot_moss']);
    const oracleRow = row('dm-bot_oracle');
    expect(oracleRow.textContent).toContain('Oracle');
    expect(oracleRow.querySelector('[data-testid="bots-conversation-row-owner"]')?.textContent).toBe('by Alice');
    expect(oracleRow.className).not.toContain('opacity-70');
    // Its publisher's name finds it too.
    mount('#/bots', 'alice');
    expect(order()).toEqual(['dm-bot_oracle']);
  });

  it('files it under Archived, asleep, once it is no longer offered', () => {
    useBotsStore.setState({ sharedBots: [{ ...oracle, available: false }] });
    mount('#/bots');
    // Archived keeps the list's activity order: Oracle's DM is the most recent record.
    expect(order()).toEqual(['dm-bot_sprouty', 'dm-bot_sage', 'dm-bot_oracle', GROUP, 'dm-bot_moss']);
    expect(row('dm-bot_oracle').className).toContain('opacity-70');
    expect(row('dm-bot_oracle').querySelector('svg')!.getAttribute('class')).toContain('pa-s-sleep');
  });
});

describe('<BotsThreadsSection/> conversations with people (P5)', () => {
  const ME = 'u1';
  const privateChat = conversation('room-ana', 'direct', [], {
    kind: 'room',
    title: null,
    owner_bot_id: null,
    lead_bot_id: null,
    members: [],
    participants: [
      { user_id: ME, nickname: 'Mia', role: 'owner', joined_at: '' },
      { user_id: 'u2', nickname: 'Ana', role: 'member', joined_at: '' },
    ],
    last_message: { role: 'user', bot_id: null, author_user_id: 'u2', preview: 'lunch?', created_at: '' },
    attention: 'unread',
    last_activity_at: '2026-10-07T00:00:00.000Z',
  });
  const launch = conversation('room-launch', 'direct', [], {
    kind: 'room',
    title: 'Launch plan',
    owner_bot_id: null,
    lead_bot_id: null,
    members: [
      {
        bot_id: sage.id,
        role: 'member',
        position: 0,
        owner_user_id: ME,
        brought_by_user_id: ME,
        addressable: true,
        profile: { name: sage.name, role: '', avatar: {}, template_key: null },
      },
      {
        bot_id: 'bot_ben',
        role: 'member',
        position: 1,
        owner_user_id: 'u3',
        brought_by_user_id: 'u3',
        addressable: false,
        profile: { name: 'Scout', role: 'Researcher', avatar: {}, template_key: null },
      },
    ],
    participants: [
      { user_id: ME, nickname: 'Mia', role: 'owner', joined_at: '' },
      { user_id: 'u2', nickname: 'Ana', role: 'member', joined_at: '' },
      { user_id: 'u3', nickname: 'Ben', role: 'member', joined_at: '' },
    ],
    last_message: { role: 'assistant', bot_id: 'bot_ben', author_user_id: null, preview: 'Shipped', created_at: '' },
    last_activity_at: '2026-10-06T12:00:00.000Z',
  });
  const order = () =>
    [...host.querySelectorAll<HTMLElement>('[data-testid="bots-conversation-row"]')].map((el) => el.dataset.sessionId);

  beforeEach(() => {
    useAuthStore.setState({ currentUser: { id: ME, role: 'team', nickname: 'Mia' } });
    useBotsStore.setState({
      conversations: [privateChat, launch, ...useBotsStore.getState().conversations],
    });
  });
  afterEach(() => useAuthStore.setState({ currentUser: null }));

  it('lists them under People, after all the Agents, by activity', () => {
    mount('#/bots');
    expect(order()).toEqual(['dm-bot_sprouty', 'dm-bot_sage', 'room-ana', 'room-launch', GROUP, 'dm-bot_moss']);
    const people = host.querySelector<HTMLElement>('[data-testid="sidebar-section-people"]')!;
    const agents = host.querySelector<HTMLElement>('[data-testid="sidebar-section-agents"]')!;
    for (const id of ['room-ana', 'room-launch']) {
      expect(people.compareDocumentPosition(row(id)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(agents.compareDocumentPosition(row(id)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('names a private chat after the other person, with their initial, and says who spoke last', () => {
    mount('#/bots');
    const ana = row('room-ana');
    expect(ana.dataset.kind).toBe('room');
    expect(ana.textContent).toContain('Ana');
    expect(ana.textContent).toContain('Ana: lunch?');
    expect(ana.querySelector('[data-testid="person-avatar"]')?.textContent).toBe('A');
    // Someone else's message is news: unread.
    expect(ana.querySelector('span[title="Ana"]')?.className).toContain('font-semibold');
  });

  it("names a titled room by its title, and another person's Agent as the room describes it", () => {
    mount('#/bots');
    const room = row('room-launch');
    expect(room.textContent).toContain('Launch plan');
    expect(room.textContent).toContain('Scout: Shipped');
    // The other two people, overlapped — not a plant.
    expect(room.querySelectorAll('[data-testid="person-avatar"]')).toHaveLength(2);
    expect(room.querySelector('[data-testid="plant-avatar-stack"]')).toBeNull();
  });

  it("falls back to the owner's name for an Agent an older server does not describe", () => {
    useBotsStore.setState({
      conversations: [
        { ...launch, members: launch.members.map((member) => ({ ...member, profile: undefined })) },
        ...useBotsStore.getState().conversations.filter((c) => c.session_id !== launch.session_id),
      ],
    });
    mount('#/bots');
    expect(row('room-launch').textContent).toContain("Ben's Agent: Shipped");
  });

  it('says "You" for the member\'s own last message', () => {
    useBotsStore.setState({
      conversations: [
        { ...privateChat, last_message: { ...privateChat.last_message!, author_user_id: ME, preview: 'on my way' } },
      ],
    });
    mount('#/bots');
    expect(row('room-ana').textContent).toContain('You: on my way');
  });

  it("searches people's names too, and the names of other people's Agents", () => {
    mount('#/bots', 'ben');
    expect(order()).toEqual(['room-launch']);
    mount('#/bots', 'scout');
    expect(order()).toEqual(['room-launch']);
  });

  it('offers a People heading icon that opens its dialog', () => {
    mount('#/bots');
    const entry = host.querySelector<HTMLButtonElement>('[data-testid="sidebar-new-room"]')!;
    expect(entry.getAttribute('aria-label')).toContain('New conversation with people');
    expect(entry.closest('[data-testid="sidebar-section-people"]')).not.toBeNull();
    act(() => entry.click());
    expect(useBotsStore.getState().dialog).toEqual({ kind: 'new-room' });
  });

  it('keeps the entry when the member has no conversation with people yet', () => {
    useBotsStore.setState({ conversations: useBotsStore.getState().conversations.filter((c) => c.kind !== 'room') });
    mount('#/bots');
    expect(host.querySelector('[data-testid="sidebar-section-people"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="sidebar-new-room"]')).not.toBeNull();
  });
});
