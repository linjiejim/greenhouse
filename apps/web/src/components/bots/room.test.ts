import { describe, expect, it } from 'vitest';
import type { BotConversationSummary, BotMemberView, BotView } from '@greenhouse/types/bots';
import {
  canRemoveRoomAgent,
  isPrivateChat,
  personName,
  roomAgentCard,
  roomAgentStandIn,
  roomOthers,
  roomTitle,
} from './room';

const people = [
  { user_id: 'u1', nickname: 'Mia', role: 'owner' as const, joined_at: '' },
  { user_id: 'u2', nickname: 'Ana', role: 'member' as const, joined_at: '' },
];

function room(extra: Partial<BotConversationSummary> = {}): BotConversationSummary {
  return {
    session_id: 'r1',
    kind: 'room',
    title: null,
    owner_bot_id: null,
    lead_bot_id: null,
    members: [],
    participants: people,
    last_message: null,
    attention: 'idle',
    pending_requests: 0,
    last_activity_at: '',
    ...extra,
  };
}

const agent = (extra: Partial<BotMemberView> = {}): BotMemberView => ({
  bot_id: 'bot_x',
  role: 'member',
  position: 0,
  owner_user_id: 'u2',
  brought_by_user_id: 'u2',
  addressable: false,
  profile: { name: 'Scout', role: 'Researcher', avatar: { plant: 'fern' }, template_key: 'researcher' },
  ...extra,
});

const card = (id: string, name: string, extra: Partial<BotView> = {}): BotView => ({
  ...roomAgentStandIn({ bot_id: id, owner_user_id: 'u1' }, name),
  description: 'kept',
  dm_session_id: 'dm-1',
  ...extra,
});

describe('room helpers', () => {
  it('names a room by its title, else the other people, else the fallback', () => {
    expect(roomTitle(room({ title: '  Launch  ' }), 'u1', 'Conversation')).toBe('Launch');
    expect(roomTitle(room(), 'u1', 'Conversation')).toBe('Ana');
    expect(roomTitle(room({ participants: [people[0]] }), 'u1', 'Conversation')).toBe('Conversation');
    expect(roomOthers(room(), 'u1').map((p) => p.nickname)).toEqual(['Ana']);
  });

  it('is a private chat with two people, no title and no Agents', () => {
    expect(isPrivateChat(room())).toBe(true);
    expect(isPrivateChat(room({ title: 'x' }))).toBe(false);
    expect(isPrivateChat(room({ members: [agent()] }))).toBe(false);
    expect(isPrivateChat(room({ kind: 'direct' }))).toBe(false);
  });

  it('lets whoever brought the Agent, its owner or the room’s owner take it out — the server’s rule', () => {
    // Ana's Agent, brought by Ana, in Mia's room.
    expect(canRemoveRoomAgent(agent(), 'u2', 'u1')).toBe(true);
    expect(canRemoveRoomAgent(agent(), 'u1', 'u1')).toBe(true);
    expect(canRemoveRoomAgent(agent(), 'u3', 'u1')).toBe(false);
    // A public Agent of Zoe's that Ben brought into Mia's room: Ben, Zoe and Mia — nobody else.
    const brought = agent({ owner_user_id: 'u4', brought_by_user_id: 'u3' });
    expect(canRemoveRoomAgent(brought, 'u3', 'u1')).toBe(true);
    expect(canRemoveRoomAgent(brought, 'u4', 'u1')).toBe(true);
    expect(canRemoveRoomAgent(brought, 'u2', 'u1')).toBe(false);
    expect(canRemoveRoomAgent(agent(), null, 'u1')).toBe(false);
  });

  it('shows another person’s Agent as the room describes it, over any copy the member has', () => {
    expect(roomAgentCard(agent(), 'u1', new Map())).toMatchObject({
      id: 'bot_x',
      name: 'Scout',
      role: 'Researcher',
      avatar: { plant: 'fern' },
      template_key: 'researcher',
      user_id: 'u2',
    });
    // A public Agent the member also talks to: the room's face, the directory's DM and description.
    const directory = new Map([['bot_x', card('bot_x', 'Old name', { user_id: 'u2' })]]);
    expect(roomAgentCard(agent(), 'u1', directory)).toMatchObject({
      name: 'Scout',
      description: 'kept',
      dm_session_id: 'dm-1',
    });
  });

  it('shows the member’s own Agent from their directory (their latest edits)', () => {
    const mine = agent({ owner_user_id: 'u1', brought_by_user_id: 'u1' });
    const directory = new Map([['bot_x', card('bot_x', 'Renamed just now')]]);
    expect(roomAgentCard(mine, 'u1', directory)?.name).toBe('Renamed just now');
    expect(roomAgentCard(mine, 'u1', new Map())?.name).toBe('Scout');
  });

  it('knows nothing of an Agent an older server does not describe, unless the directory does', () => {
    const bare = agent({ profile: undefined });
    expect(roomAgentCard(bare, 'u1', new Map())).toBeNull();
    expect(roomAgentCard(bare, 'u1', new Map([['bot_x', card('bot_x', 'Oracle')]]))?.name).toBe('Oracle');
  });

  it('stands in for an Agent nothing describes, keeping its id (and so its plant)', () => {
    const bot = roomAgentStandIn(agent(), "Ana's Agent");
    expect(bot).toMatchObject({ id: 'bot_x', name: "Ana's Agent", user_id: 'u2', status: 'active' });
    expect(personName(room(), 'u2')).toBe('Ana');
    expect(personName(room(), 'u9')).toBeNull();
  });
});
