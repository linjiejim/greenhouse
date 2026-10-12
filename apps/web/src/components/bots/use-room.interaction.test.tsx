/** @vitest-environment happy-dom */

/**
 * A room as the member sees it (spec 20261011-agent-first-class P5): every Agent named and drawn
 * from the room's own `profile` (no extra read), the `@` list, and what the member may take out —
 * whoever brought an Agent may, as may its owner and the room's owner.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConversationSummary, BotMemberView, BotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { useAuthStore } from '../../stores';
import { roomAgentStandIn } from './room';
import { useRoomView, type RoomView } from './use-room';

const api = vi.hoisted(() => ({ listPublicAgents: vi.fn() }));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'u1';
const SAGE: BotView = { ...roomAgentStandIn({ bot_id: 'bot_sage', owner_user_id: ME }, 'Sage'), role: 'Researcher' };

const member = (botId: string, extra: Partial<BotMemberView>): BotMemberView => ({
  bot_id: botId,
  role: 'member',
  position: 0,
  addressable: false,
  ...extra,
});

// Ana owns the room; the member brought their own Sage and Zoe's public Oracle; Ben brought his Scout.
const ROOM: BotConversationSummary = {
  session_id: 'room-1',
  kind: 'room',
  title: 'Launch',
  owner_bot_id: null,
  lead_bot_id: null,
  members: [
    member('bot_sage', {
      position: 0,
      owner_user_id: ME,
      brought_by_user_id: ME,
      addressable: true,
      profile: { name: 'Sage', role: 'Researcher', avatar: {}, template_key: null },
    }),
    member('bot_oracle', {
      position: 1,
      owner_user_id: 'u4',
      brought_by_user_id: ME,
      addressable: true,
      profile: { name: 'Oracle', role: 'Analyst', avatar: { plant: 'cactus' }, template_key: 'researcher' },
    }),
    member('bot_scout', {
      position: 2,
      owner_user_id: 'u3',
      brought_by_user_id: 'u3',
      profile: { name: 'Scout', role: 'Scout', avatar: {}, template_key: null },
    }),
  ],
  participants: [
    { user_id: 'u2', nickname: 'Ana', role: 'owner', joined_at: '' },
    { user_id: ME, nickname: 'Mia', role: 'member', joined_at: '' },
    { user_id: 'u3', nickname: 'Ben', role: 'member', joined_at: '' },
  ],
  last_message: null,
  attention: 'idle',
  pending_requests: 0,
  last_activity_at: '',
};

let root: ReturnType<typeof createRoot> | null = null;
let view: RoomView | null = null;

function Probe({ conversation, directory }: { conversation: BotConversationSummary; directory: Map<string, BotView> }) {
  view = useRoomView(conversation, directory);
  return null;
}

async function render(conversation: BotConversationSummary, directory = new Map([[SAGE.id, SAGE]])) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(I18nProvider, { initialLocale: 'en', children: createElement(Probe, { conversation, directory }) }),
    ),
  );
}

beforeEach(() => {
  api.listPublicAgents.mockReset().mockResolvedValue([]);
  useAuthStore.setState({ currentUser: { id: ME, role: 'team', nickname: 'Mia' } });
  view = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  useAuthStore.setState({ currentUser: null });
});

describe('useRoomView', () => {
  it("names and draws other people's Agents from the room's profile, without another read", async () => {
    await render(ROOM);
    expect(view?.agents.map((agent) => agent.bot.name)).toEqual(['Sage', 'Oracle', 'Scout']);
    expect(view?.faces.get('bot_oracle')).toMatchObject({
      name: 'Oracle',
      role: 'Analyst',
      avatar: { plant: 'cactus' },
      template_key: 'researcher',
      user_id: 'u4',
    });
    expect(view?.addressable.map((bot) => bot.name)).toEqual(['Sage', 'Oracle']);
    expect(api.listPublicAgents).not.toHaveBeenCalled();
  });

  it('lets the member take out what they brought or own — not what someone else brought', async () => {
    await render(ROOM);
    expect(view?.agents.map((agent) => [agent.bot.name, agent.byline, agent.removable])).toEqual([
      ['Sage', 'Yours', true],
      // Zoe's public Agent (Zoe is not here), brought in by the member.
      ['Oracle', 'Public Agent', true],
      ['Scout', "Ben's", false],
    ]);
  });

  it("stands in with the owner's name only when an older server describes nothing", async () => {
    await render({ ...ROOM, members: ROOM.members.map((m) => ({ ...m, profile: undefined })) });
    expect(view?.agents.map((agent) => agent.bot.name)).toEqual(['Sage', 'Public Agent', "Ben's Agent"]);
  });
});
