/**
 * Membership and notes rules behind a Bot's profile (./member-model.ts — the
 * pure half of ./use-conversation-info.ts and ./profile-tabs.tsx): who can be
 * removed, and the shared notes' order. A conversation is a Bot's DM with
 * guests; an old group is a closed record.
 */

import { describe, expect, it } from 'vitest';
import type { BotConversationDetail, BotMemberView, BotSharedNoteView } from '../../shared/bots';
import { memberRemovable, orderedNotes, sortedMembers, withoutMember } from './member-model';

const member = (bot_id: string, role: BotMemberView['role'], position: number): BotMemberView => ({
  bot_id,
  role,
  position,
});

function detail(over: Partial<BotConversationDetail>): BotConversationDetail {
  return {
    session_id: 's1',
    kind: 'direct',
    title: null,
    owner_bot_id: 'a',
    lead_bot_id: 'a',
    members: [member('a', 'owner', 0), member('g', 'guest', 1)],
    last_message: null,
    attention: 'idle',
    pending_requests: 0,
    last_activity_at: '2026-10-08T00:00:00.000Z',
    description: '',
    allow_bot_chat: true,
    digest: null,
    notes: [],
    requests: [],
    context: { estimated_tokens: 0, threshold: 1 },
    ...over,
  };
}

const closedGroup = () =>
  detail({
    kind: 'group',
    owner_bot_id: null,
    members: [member('a', 'lead', 0), member('b', 'member', 1), member('c', 'member', 2)],
  });

describe('memberRemovable', () => {
  it('a DM: guests only, never the owner', () => {
    const dm = detail({});
    expect(memberRemovable(dm, dm.members[0]!)).toBe(false);
    expect(memberRemovable(dm, dm.members[1]!)).toBe(true);
  });

  it('a closed group: nobody', () => {
    const group = closedGroup();
    expect(group.members.some((m) => memberRemovable(group, m))).toBe(false);
  });
});

describe('members', () => {
  it('sorts by seat and drops a removed guest', () => {
    const dm = detail({ members: [member('g', 'guest', 1), member('a', 'owner', 0)] });
    expect(sortedMembers(dm.members).map((m) => m.bot_id)).toEqual(['a', 'g']);
    expect(withoutMember(detail({}), 'g').members.map((m) => m.bot_id)).toEqual(['a']);
  });
});

describe('orderedNotes', () => {
  const note = (id: number, over: Partial<BotSharedNoteView>): BotSharedNoteView => ({
    id,
    title: `n${id}`,
    body: '',
    author_bot_id: null,
    status: 'open',
    pinned: false,
    updated_at: '2026-10-01T00:00:00.000Z',
    ...over,
  });

  it('puts open before done, pinned first, then the newest', () => {
    const notes = [
      note(1, { status: 'done', pinned: true }),
      note(2, { updated_at: '2026-10-03T00:00:00.000Z' }),
      note(3, { pinned: true }),
      note(4, { updated_at: '2026-10-05T00:00:00.000Z' }),
    ];
    expect(orderedNotes(notes).map((n) => n.id)).toEqual([3, 4, 2, 1]);
  });
});
