/**
 * Rooms on the phone (./rooms.ts — spec docs/specs/20261011-agent-first-class.md §5d P5): the
 * drawer row's preview and search, people's faces and colours, names for Agents the member's lists
 * don't know, who can be @-mentioned, which ids are worth learning, the ⋯ menu's Agents, the
 * status, the new-conversation sheet's list and request, and whose live run it is. Root vitest, no
 * React Native.
 */

import { describe, expect, it } from 'vitest';
import type { BotConversationSummary, BotMemberView, RoomParticipantView, SharedBotView } from '../shared/bots';
import {
  PERSON_TINTS,
  bringableAgents,
  createRoomInput,
  lastOneIn,
  learnableIds,
  mentionableAgents,
  needsOffered,
  peopleRows,
  personTint,
  removableAgents,
  roomDirectory,
  roomFaces,
  roomPreview,
  roomRunMine,
  roomSearchText,
  roomStatus,
} from './rooms';
import { bot, conversation } from './thread/test-fakes';

const ME = 'u_me';
const person = (user_id: string, nickname: string, role: 'owner' | 'member' = 'member'): RoomParticipantView => ({
  user_id,
  nickname,
  role,
  joined_at: '2026-10-12T00:00:00.000Z',
});
const member = (bot_id: string, owner_user_id: string, addressable: boolean, position = 0): BotMemberView => ({
  bot_id,
  role: 'member',
  position,
  owner_user_id,
  addressable,
});

function room(partial: Partial<BotConversationSummary> = {}): BotConversationSummary {
  return conversation('s_room', {
    kind: 'room',
    owner_bot_id: null,
    lead_bot_id: null,
    members: [],
    participants: [person(ME, 'Me', 'owner'), person('u_ana', 'Ana'), person('u_bo', 'Bo')],
    ...partial,
  });
}

function offered(id: string, name: string): SharedBotView {
  return {
    id,
    name,
    role: 'Helper',
    description: '',
    avatar: {},
    template_key: null,
    owner: { id: 'u_bo', nickname: 'Bo' },
    dm_session_id: null,
    available: true,
    computer: false,
  };
}

const COPY = {
  noMessages: 'No messages yet',
  youSaid: (text: string) => `You: ${text}`,
  botSaid: (name: string, text: string) => `${name}: ${text}`,
};
const AGENT_COPY = { agentOf: (name: string) => `${name}’s Agent`, someAgent: 'An Agent' };

describe('the drawer row', () => {
  const last = (partial: Partial<NonNullable<BotConversationSummary['last_message']>>) =>
    room({ last_message: { preview: 'ship  it\n', bot_id: null, role: 'user', created_at: '', ...partial } });

  it('previews who wrote last, whitespace collapsed', () => {
    const name = (id: string) => (id === 'b_sage' ? 'Sage' : null);
    expect(roomPreview(last({ author_user_id: ME }), ME, name, COPY)).toBe('You: ship it');
    // a member message without an author is the member's (single-member rows)
    expect(roomPreview(last({}), ME, name, COPY)).toBe('You: ship it');
    expect(roomPreview(last({ author_user_id: 'u_ana' }), ME, name, COPY)).toBe('Ana: ship it');
    expect(roomPreview(last({ author_user_id: 'u_left' }), ME, name, COPY)).toBe('ship it');
    expect(roomPreview(last({ role: 'assistant', bot_id: 'b_sage' }), ME, name, COPY)).toBe('Sage: ship it');
    expect(roomPreview(last({ role: 'assistant', bot_id: 'b_who' }), ME, name, COPY)).toBe('ship it');
    expect(roomPreview(last({ role: 'system' }), ME, name, COPY)).toBe('ship it');
    expect(roomPreview(room(), ME, name, COPY)).toBe('No messages yet');
  });

  it('is searched by its title, its people and the last preview', () => {
    const text = roomSearchText(last({ author_user_id: 'u_ana' }));
    expect(text).toContain('ana');
    expect(text).toContain('bo');
    expect(text).toContain('ship');
    expect(roomSearchText(room({ title: 'Launch Plan' }))).toContain('launch plan');
  });

  it('shows the other people (a private chat: the other one); everyone else gone: the member', () => {
    expect(roomFaces(room(), ME).map((p) => p.nickname)).toEqual(['Ana', 'Bo']);
    expect(roomFaces(room({ participants: [person(ME, 'Me')] }), ME).map((p) => p.nickname)).toEqual(['Me']);
  });

  it('gives each person one colour wherever they appear — never the accent', () => {
    expect(personTint('u_ana')).toBe(personTint('u_ana'));
    const seen = new Set(['u_a', 'u_b', 'u_c', 'u_d', 'u_e', 'u_f', 'u_g', 'u_h'].map(personTint));
    for (const tint of seen) expect(PERSON_TINTS).toContain(tint);
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('who the Agents are', () => {
  const SAGE = bot('b_sage', { name: 'Sage', user_id: ME });
  const withAgents = room({
    members: [
      member('b_sage', ME, true, 0),
      member('b_pub', 'u_bo', true, 1),
      member('b_ana', 'u_ana', false, 2),
      member('b_gone', 'u_left', false, 3),
    ],
  });

  it('names an Agent the lists don’t know: an offered one as itself, else after its owner', () => {
    const out = roomDirectory({
      byId: { b_sage: SAGE },
      room: withAgents,
      offered: [offered('b_pub', 'Pixel')],
      speakers: ['b_old'],
      copy: AGENT_COPY,
    });
    expect(out.byId.b_sage).toBe(SAGE);
    expect(out.byId.b_pub.name).toBe('Pixel');
    expect(out.byId.b_ana.name).toBe('Ana’s Agent');
    expect(out.byId.b_ana.user_id).toBe('u_ana');
    // its owner left too; an Agent that spoke and left
    expect(out.byId.b_gone.name).toBe('An Agent');
    expect(out.byId.b_old.name).toBe('An Agent');
    expect([...out.guessed].sort()).toEqual(['b_ana', 'b_gone', 'b_old']);
  });

  it('leaves the directory alone when nothing is missing', () => {
    const byId = { b_sage: SAGE };
    const out = roomDirectory({
      byId,
      room: room({ members: [member('b_sage', ME, true)] }),
      offered: [],
      copy: AGENT_COPY,
    });
    expect(out.byId).toBe(byId);
    expect(out.guessed.size).toBe(0);
  });

  it('offers @ only for Agents the member may address, known by their own name and active', () => {
    const { byId, guessed } = roomDirectory({
      byId: { b_sage: SAGE },
      room: withAgents,
      offered: [],
      copy: AGENT_COPY,
    });
    // b_pub is addressable but unknown (a stand-in named after its owner): not offered yet
    expect(mentionableAgents(withAgents, byId, guessed).map((b) => b.id)).toEqual(['b_sage']);
    expect(needsOffered(withAgents, { b_sage: SAGE }, [])).toBe(true);
    expect(needsOffered(withAgents, { b_sage: SAGE }, [offered('b_pub', 'Pixel')])).toBe(false);
    const known = roomDirectory({
      byId: { b_sage: SAGE },
      room: withAgents,
      offered: [offered('b_pub', 'Pixel')],
      copy: AGENT_COPY,
    });
    expect(mentionableAgents(withAgents, known.byId, known.guessed).map((b) => b.id)).toEqual(['b_sage', 'b_pub']);
    const archived = { b_sage: { ...SAGE, status: 'archived' as const } };
    expect(mentionableAgents(withAgents, archived)).toEqual([]);
  });

  it('never asks the member’s Bot list for another person’s own Agent', () => {
    expect(learnableIds(withAgents, ['b_sage', 'b_ana', 'b_pub', 'b_left_room'])).toEqual([
      'b_sage',
      'b_pub',
      'b_left_room',
    ]);
    expect(learnableIds(conversation('s1'), ['b_ana'])).toEqual(['b_ana']);
    expect(learnableIds(null, ['b_x'])).toEqual(['b_x']);
  });

  it('⋯: brings the member’s own active Agents not here yet; takes out theirs — any, when the room is theirs', () => {
    const FERN = bot('b_fern', { name: 'Fern', user_id: ME });
    const OLD = bot('b_old', { name: 'Old', user_id: ME, status: 'archived' });
    expect(bringableAgents(withAgents, [SAGE, FERN, OLD]).map((b) => b.id)).toEqual(['b_fern']);
    // the member created this room: every Agent
    expect(removableAgents(withAgents, ME).map((m) => m.bot_id)).toEqual(['b_sage', 'b_pub', 'b_ana', 'b_gone']);
    const theirs = room({
      members: withAgents.members,
      participants: [person('u_ana', 'Ana', 'owner'), person(ME, 'Me')],
    });
    expect(removableAgents(theirs, ME).map((m) => m.bot_id)).toEqual(['b_sage']);
    expect(removableAgents(theirs, null)).toEqual([]);
  });
});

describe('status and leaving', () => {
  it('a private chat is two people, no title, no Agents', () => {
    const pair = room({ participants: [person(ME, 'Me'), person('u_ana', 'Ana')] });
    expect(roomStatus(pair)).toEqual({ privateChat: true, people: 2, agents: 0 });
    expect(roomStatus({ ...pair, title: 'Us' }).privateChat).toBe(false);
    expect(roomStatus({ ...pair, members: [member('b_sage', ME, true)] })).toEqual({
      privateChat: false,
      people: 2,
      agents: 1,
    });
    expect(roomStatus(room()).people).toBe(3);
  });

  it('the last one in deletes it by leaving', () => {
    expect(lastOneIn(room(), ME)).toBe(false);
    expect(lastOneIn(room({ participants: [person(ME, 'Me')] }), ME)).toBe(true);
    expect(lastOneIn(room({ participants: [person('u_ana', 'Ana')] }), ME)).toBe(false);
  });
});

describe('the new-conversation sheet', () => {
  const PEOPLE = [
    { id: 'u_ana', nickname: 'Ana', email: 'ana@x.test' },
    { id: 'u_bo', nickname: 'Bo', email: 'bo@x.test' },
    { id: 'u_cy', nickname: 'Cy', email: 'cyrus@x.test' },
  ];

  it('lists who is not in the room yet, searched by name or email, in the server’s order', () => {
    expect(peopleRows(PEOPLE, '').map((p) => p.id)).toEqual(['u_ana', 'u_bo', 'u_cy']);
    expect(peopleRows(PEOPLE, '  CYRUS ').map((p) => p.id)).toEqual(['u_cy']);
    expect(peopleRows(PEOPLE, 'b').map((p) => p.id)).toEqual(['u_bo']);
    expect(peopleRows(PEOPLE, '', new Set(['u_ana'])).map((p) => p.id)).toEqual(['u_bo', 'u_cy']);
  });

  it('asks for the picked people, a title only when typed, Agents only when picked', () => {
    expect(createRoomInput({ people: ['u_ana', 'u_ana'], title: '  ', agents: [] })).toEqual({ user_ids: ['u_ana'] });
    expect(createRoomInput({ people: ['u_ana', 'u_bo'], title: ' Launch ', agents: ['b_sage'] })).toEqual({
      user_ids: ['u_ana', 'u_bo'],
      title: 'Launch',
      bot_ids: ['b_sage'],
    });
  });
});

describe('whose run it is (only its asker may stop it)', () => {
  const members = [member('b_mine', ME, true, 0), member('b_pub', 'u_bo', true, 1), member('b_ana', 'u_ana', false, 2)];
  const ownPrivate = (id: string) => id === 'b_mine';
  const ask = (...bots: string[]) => ({ at: 0, bots: new Set(bots) });
  const mine = (firstSpeaker: string | null, open: ReturnType<typeof ask> | null) =>
    roomRunMine({ viewerId: ME, members, firstSpeaker, ownPrivate, ask: open });

  it('an Agent the member may not address can’t be answering them', () => {
    expect(mine('b_ana', ask('b_ana'))).toBe(false);
  });

  it('one of their own private Agents can only be answering them', () => {
    expect(mine('b_mine', null)).toBe(true);
  });

  it('a public Agent, or no one speaking yet: this device’s open ask decides', () => {
    expect(mine(null, null)).toBe(false);
    expect(mine(null, ask('b_pub'))).toBe(true);
    expect(mine('b_pub', null)).toBe(false);
    expect(mine('b_pub', ask('b_pub'))).toBe(true);
    // the open ask named another Agent: someone else asked this one
    expect(mine('b_pub', ask('b_mine'))).toBe(false);
    // the member's own public Agent: anyone it is offered to may ask it
    expect(roomRunMine({ viewerId: ME, members, firstSpeaker: 'b_mine', ownPrivate: () => false, ask: null })).toBe(
      false,
    );
  });
});
