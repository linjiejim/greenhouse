/**
 * Membership rules behind the conversation-info and invite sheets
 * (./group-model.ts — the pure half of ./use-conversation-info.ts; spec
 * docs/specs/20261008-mobile-bots.md §2.5.7): who can be removed, who can be
 * invited, the lead choices, the optimistic edits matching the server's
 * role rules, and the shared notes' order.
 */

import { describe, expect, it } from 'vitest';
import type { BotConversationDetail, BotMemberView, BotSharedNoteView, BotView } from '../../shared/bots';
import {
  canInviteMore,
  inviteCandidates,
  leadChoices,
  memberLabel,
  memberRemovable,
  orderedNotes,
  sortedMembers,
  withLead,
  withoutMember,
} from './group-model';

const member = (bot_id: string, role: BotMemberView['role'], position: number): BotMemberView => ({
  bot_id,
  role,
  position,
});
const bot = (id: string, status: BotView['status'] = 'active') => ({ id, status }) as BotView;

function detail(over: Partial<BotConversationDetail>): BotConversationDetail {
  return {
    session_id: 's1',
    kind: 'group',
    title: null,
    owner_bot_id: null,
    lead_bot_id: 'a',
    members: [member('a', 'lead', 0), member('b', 'member', 1), member('c', 'member', 2)],
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

describe('memberRemovable', () => {
  it('a group: anyone but the lead, while more than two remain', () => {
    const group = detail({});
    expect(memberRemovable(group, group.members[0]!)).toBe(false);
    expect(memberRemovable(group, group.members[1]!)).toBe(true);
    const pair = detail({ members: [member('a', 'lead', 0), member('b', 'member', 1)] });
    expect(memberRemovable(pair, pair.members[1]!)).toBe(false);
  });

  it('a DM: guests only, never the owner', () => {
    const dm = detail({
      kind: 'direct',
      owner_bot_id: 'a',
      members: [member('a', 'owner', 0), member('g', 'guest', 1)],
    });
    expect(memberRemovable(dm, dm.members[0]!)).toBe(false);
    expect(memberRemovable(dm, dm.members[1]!)).toBe(true);
  });
});

describe('inviting', () => {
  it('offers active Bots not already here, up to six members', () => {
    const group = detail({});
    expect(inviteCandidates([bot('a'), bot('d'), bot('e', 'archived')], group).map((b) => b.id)).toEqual(['d']);
    expect(canInviteMore(group)).toBe(true);
    const full = detail({ members: ['1', '2', '3', '4', '5', '6'].map((id, i) => member(id, 'member', i)) });
    expect(canInviteMore(full)).toBe(false);
  });
});

describe('roles and leads', () => {
  it('labels archived Bots as archived, everyone else by role', () => {
    expect(memberLabel(member('a', 'lead', 0), bot('a'))).toBe('lead');
    expect(memberLabel(member('a', 'owner', 0), bot('a', 'archived'))).toBe('archived');
    expect(memberLabel(member('a', 'guest', 0), undefined)).toBe('guest');
  });

  it('lead choices are the active members in seat order', () => {
    const group = detail({ members: [member('c', 'member', 2), member('a', 'lead', 0), member('b', 'member', 1)] });
    const byId = { a: bot('a'), b: bot('b', 'archived'), c: bot('c') };
    expect(sortedMembers(group.members).map((m) => m.bot_id)).toEqual(['a', 'b', 'c']);
    expect(leadChoices(group, byId).map((b) => b.id)).toEqual(['a', 'c']);
  });

  it('withLead moves the lead role, like the server', () => {
    const next = withLead(detail({}), 'c');
    expect(next.lead_bot_id).toBe('c');
    expect(next.members.map((m) => [m.bot_id, m.role])).toEqual([
      ['a', 'member'],
      ['b', 'member'],
      ['c', 'lead'],
    ]);
  });

  it('withoutMember drops the member and keeps the rest', () => {
    expect(withoutMember(detail({}), 'b').members.map((m) => m.bot_id)).toEqual(['a', 'c']);
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
