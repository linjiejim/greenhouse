import { describe, expect, it } from 'vitest';
import type { BotConversationSummary, BotMemberView } from '@greenhouse/types/bots';
import { canRemoveRoomAgent, isPrivateChat, personName, roomAgentStandIn, roomOthers, roomTitle } from './room';

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
  addressable: false,
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

  it('lets the Agent’s owner or the room’s owner take it out', () => {
    expect(canRemoveRoomAgent(agent({ owner_user_id: 'u2' }), 'u2', 'u1')).toBe(true);
    expect(canRemoveRoomAgent(agent({ owner_user_id: 'u2' }), 'u1', 'u1')).toBe(true);
    expect(canRemoveRoomAgent(agent({ owner_user_id: 'u2' }), 'u3', 'u1')).toBe(false);
    expect(canRemoveRoomAgent(agent(), null, 'u1')).toBe(false);
  });

  it('stands in for an Agent the member has no card for, keeping its id (and so its plant)', () => {
    const bot = roomAgentStandIn(agent(), "Ana's Agent");
    expect(bot).toMatchObject({ id: 'bot_x', name: "Ana's Agent", user_id: 'u2', status: 'active' });
    expect(personName(room(), 'u2')).toBe('Ana');
    expect(personName(room(), 'u9')).toBeNull();
  });
});
