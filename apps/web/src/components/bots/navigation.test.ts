import { describe, expect, it } from 'vitest';
import type { BotView } from '@greenhouse/types/bots';
import { conversationReplyable } from './bots-store';
import { botsConversationHash, conversationTitle } from './navigation';

const bots = new Map<string, BotView>(
  (
    [
      ['bot_ivy', 'Ivy', 'active'],
      ['bot_sage', 'Sage', 'active'],
      ['bot_old', 'Old', 'archived'],
    ] as const
  ).map(([id, name, status]) => [id, { id, name, status } as BotView]),
);
const copy = { unknownBot: 'Deleted Bot', group: 'Group', archived: (name: string) => `${name} (archived)` };
const member = (bot_id: string, position: number) => ({ bot_id, role: 'member' as const, position });

describe('Bots navigation helpers', () => {
  it('addresses a conversation by query parameter, encoded', () => {
    expect(botsConversationHash('abc123')).toBe('#/bots?c=abc123');
    expect(botsConversationHash('a/b')).toBe('#/bots?c=a%2Fb');
  });

  it('names a DM after its Bot, an archived owner as archived, and an unknown one by the given fallback', () => {
    expect(conversationTitle({ kind: 'direct', title: null, owner_bot_id: 'bot_ivy', members: [] }, bots, copy)).toBe(
      'Ivy',
    );
    expect(conversationTitle({ kind: 'direct', title: null, owner_bot_id: 'bot_old', members: [] }, bots, copy)).toBe(
      'Old (archived)',
    );
    expect(conversationTitle({ kind: 'direct', title: null, owner_bot_id: 'bot_gone', members: [] }, bots, copy)).toBe(
      'Deleted Bot',
    );
    // While the Bot list is still loading, callers pass '' — never "Deleted Bot".
    expect(
      conversationTitle({ kind: 'direct', title: null, owner_bot_id: 'bot_gone', members: [] }, new Map(), {
        ...copy,
        unknownBot: '',
      }),
    ).toBe('');
  });

  it('names a group by its title, else by its roster', () => {
    const members = [member('bot_ivy', 0), member('bot_sage', 1), member('bot_gone', 2)];
    expect(conversationTitle({ kind: 'group', title: ' Launch ', owner_bot_id: null, members }, bots, copy)).toBe(
      'Launch',
    );
    expect(conversationTitle({ kind: 'group', title: null, owner_bot_id: null, members }, bots, copy)).toBe(
      'Ivy, Sage',
    );
    expect(conversationTitle({ kind: 'group', title: '', owner_bot_id: null, members: [] }, bots, copy)).toBe('Group');
  });

  it('treats a DM with an archived Bot, or a group with no active Bot, as read-only', () => {
    const active = new Set(['bot_ivy', 'bot_sage']);
    expect(conversationReplyable({ kind: 'direct', owner_bot_id: 'bot_ivy', members: [] }, active)).toBe(true);
    expect(conversationReplyable({ kind: 'direct', owner_bot_id: 'bot_old', members: [] }, active)).toBe(false);
    expect(conversationReplyable({ kind: 'group', owner_bot_id: null, members: [member('bot_old', 0)] }, active)).toBe(
      false,
    );
    expect(
      conversationReplyable(
        { kind: 'group', owner_bot_id: null, members: [member('bot_old', 0), member('bot_sage', 1)] },
        active,
      ),
    ).toBe(true);
  });
});
