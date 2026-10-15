import { describe, expect, it } from 'vitest';
import type { Agent, Conversation, PublicAgent } from '../shared/contract';
import { badgeOf, directorySections, moodOf, patchConversations, signalOf, upsertConversation } from './directory';

function agent(id: string, partial: Partial<Agent> = {}): Agent {
  return {
    id,
    handle: id,
    name: id[0]!.toUpperCase() + id.slice(1),
    role: `${id} role`,
    description: '',
    avatar: {},
    is_main: false,
    owner_id: 'me',
    visibility: 'private',
    published_version: null,
    paused_at: null,
    template_key: null,
    current_version: 1,
    archived_at: null,
    last_active_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...partial,
  };
}

function conv(id: string, partial: Partial<Conversation> = {}): Conversation {
  return {
    id,
    kind: 'chat',
    title: id,
    agent_id: null,
    model: null,
    origin: 'app',
    read_only: false,
    last_seq: 1,
    last_read_seq: 1,
    unread: 0,
    pinned: false,
    archived: false,
    muted: false,
    working: false,
    pending_requests: 0,
    last_activity_at: '2026-10-14T03:00:00.000Z',
    created_at: '2026-10-01T00:00:00.000Z',
    ...partial,
  };
}

const shared: PublicAgent = {
  ...agent('scout', { owner_id: 'ana', visibility: 'public' }),
  owner: { id: 'ana', name: 'Ana', email: 'ana@example.com', avatar_url: null },
  daily_cap: 0,
};

const now = Date.parse('2026-10-14T06:00:00.000Z');
const input = {
  agents: [
    agent('greeny', { is_main: true }),
    agent('sage'),
    agent('old', { archived_at: '2026-10-02T00:00:00.000Z' }),
  ],
  publicAgents: [shared],
  conversations: [
    conv('main', { kind: 'main', agent_id: 'greeny' }),
    conv('t-sage', { kind: 'direct', agent_id: 'sage' }),
    conv('t-scout', { kind: 'direct', agent_id: 'scout' }),
    conv('room', { kind: 'room', title: 'Launch' }),
    conv('pinned', { pinned: true, last_activity_at: '2026-10-01T00:00:00.000Z' }),
    conv('today', { title: '' }),
    conv('earlier', { last_activity_at: '2026-10-12T00:00:00.000Z' }),
    conv('gone', { archived: true }),
  ],
  untitled: 'New chat',
  mainTitle: '主线',
  now,
  timeZone: 'UTC',
};

describe('directorySections (PRD §6.2)', () => {
  it('puts the main Agent first, then my Agents, then public Agents I talk to; rooms; chats by day', () => {
    const s = directorySections(input);
    expect(s.main?.agent.id).toBe('greeny');
    expect(s.main?.conversation?.id).toBe('main');
    expect(s.agents.map((row) => [row.agent.id, row.conversation?.id])).toEqual([['sage', 't-sage']]);
    expect(s.shared.map((row) => row.agent.id)).toEqual(['scout']);
    expect(s.rooms.map((c) => c.id)).toEqual(['room']);
    expect(s.pinned.map((c) => c.id)).toEqual(['pinned']);
    expect(s.today.map((c) => c.id)).toEqual(['today']);
    expect(s.earlier.map((c) => c.id)).toEqual(['earlier']);
  });

  it('narrows every section by name (Agents also by role), an untitled chat by its placeholder', () => {
    const s = directorySections({ ...input, query: 'sage ROLE' });
    expect(s.main).toBeNull();
    expect(directorySections({ ...input, query: ' 主线 ' }).main?.agent.id).toBe('greeny');
    expect(s.agents.map((row) => row.agent.id)).toEqual(['sage']);
    expect(s.rooms).toEqual([]);
    expect(directorySections({ ...input, query: 'new' }).today.map((c) => c.id)).toEqual(['today']);
  });
});

describe('row signals and the bell', () => {
  it('shows one signal: needs you > muted > running > unread', () => {
    expect(signalOf(conv('x', { pending_requests: 2, muted: true, unread: 3 }))).toEqual({ kind: 'needs', count: 2 });
    expect(signalOf(conv('x', { muted: true, working: true }))).toEqual({ kind: 'muted' });
    expect(signalOf(conv('x', { working: true, unread: 1 }))).toEqual({ kind: 'running' });
    expect(signalOf(conv('x', { unread: 1 }))).toEqual({ kind: 'unread' });
    expect(signalOf(null)).toBeNull();
    expect(moodOf(conv('x', { working: true, pending_requests: 1 }))).toBe('thinking');
    expect(moodOf(conv('x', { pending_requests: 1 }))).toBe('waiting');
  });

  it('the bell counts what needs you, else a dot for anything unread', () => {
    expect(badgeOf({ needs_you: 3, unread: 9 })).toEqual({ kind: 'count', text: '3' });
    expect(badgeOf({ needs_you: 120, unread: 0 })).toEqual({ kind: 'count', text: '99+' });
    expect(badgeOf({ needs_you: 0, unread: 2 })).toEqual({ kind: 'dot' });
    expect(badgeOf({ needs_you: 0, unread: 0 })).toBeNull();
    expect(badgeOf(null)).toBeNull();
  });
});

describe('list edits', () => {
  it('patches by id and inserts new conversations on top', () => {
    const list = [conv('a'), conv('b')];
    expect(patchConversations(list, 'b', { unread: 4 })[1]!.unread).toBe(4);
    expect(upsertConversation(list, conv('c')).map((c) => c.id)).toEqual(['c', 'a', 'b']);
    expect(upsertConversation(list, conv('a', { title: 'renamed' }))[0]!.title).toBe('renamed');
  });
});
