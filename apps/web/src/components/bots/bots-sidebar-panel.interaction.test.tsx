/**
 * @vitest-environment happy-dom
 *
 * Sidebar conversation rows: a group row's overlapped avatar chips are separated
 * by a ring painted in the row's own colour, so the ring has to follow the row
 * through every state — at rest, under the pointer, active — or it shows as a
 * halo around each chip. A DM nobody can answer any more shows its Bot asleep.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotConversationSummary, BotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { useBotsStore } from './bots-store';
import { BotsSidebarPanel } from './bots-sidebar-panel';

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
  useBotsStore.setState({
    bots: [sage, fern],
    archivedBots: [moss],
    conversations: [
      conversation(GROUP, 'group', [sage.id, fern.id]),
      conversation('dm-bot_sage', 'direct', [sage.id]),
      conversation('dm-bot_moss', 'direct', [moss.id]),
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

function mount(currentHash: string) {
  window.location.hash = currentHash;
  act(() =>
    root.render(createElement(I18nProvider, { initialLocale: 'en', children: createElement(BotsSidebarPanel) })),
  );
}

const row = (sessionId: string) =>
  host.querySelector<HTMLElement>(`[data-testid="bots-conversation-row"][data-session-id="${sessionId}"]`)!;
/** The ring classes on each overlapped chip of a group row. */
const chipRings = (sessionId: string) =>
  [...row(sessionId).querySelectorAll('[data-testid="plant-avatar-stack"] > span')].map((chip) =>
    chip.className.split(/\s+/).filter((name) => name.includes('ring-') && name !== 'ring-2'),
  );

describe('<BotsSidebarPanel/> group rows', () => {
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

describe('<BotsSidebarPanel/> DM rows', () => {
  it("shows an archived Bot's DM asleep and a live one at rest, both still", () => {
    mount('#/bots');
    const svg = (sessionId: string) => row(sessionId).querySelector('svg')!.getAttribute('class') ?? '';
    expect(svg('dm-bot_moss')).toContain('pa-s-sleep');
    expect(svg('dm-bot_sage')).toContain('pa-s-idle');
    expect(host.querySelectorAll('[data-testid="bots-conversation-row"] .pa-mo')).toHaveLength(0);
  });
});
