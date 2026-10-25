import { describe, expect, it } from 'vitest';
import type { ChatSession } from '../shared/greenhouse-types';
import { conversationAgent, greetingFor, orderConversations, parseSessions, withPinned } from './home';

const s = (id: string, updated: string, pinned = false, pin_sort?: number): ChatSession => ({
  id,
  title: id,
  status: 'active',
  profile_id: null,
  created_at: updated,
  updated_at: updated,
  pinned,
  pin_sort,
});

describe('home', () => {
  it('names an agent only when the conversation was not with Sprouty', () => {
    expect([null, '', 'sprouty', 'team', 'desktop'].map(conversationAgent)).toEqual([null, null, null, null, null]);
    expect(conversationAgent('custom:01ABC@3')).toBe('custom:01ABC');
    expect(conversationAgent('custom:01ABC')).toBe('custom:01ABC');
  });

  it('greets by the hour', () => {
    expect([6, 12, 15, 20, 2].map(greetingFor)).toEqual(['morning', 'noon', 'afternoon', 'evening', 'night']);
  });

  it('lists pinned conversations first, then the newest', () => {
    const list = [s('old', '2026-10-01T00:00:00Z'), s('new', '2026-10-20T00:00:00Z'), s('p2', '2026-09-01T00:00:00Z', true, 2), s('p1', '2026-09-02T00:00:00Z', true, 1)];
    expect(orderConversations(list).map((x) => x.id)).toEqual(['p1', 'p2', 'new', 'old']);
  });

  it('pins at the top at once', () => {
    const list = withPinned([s('a', '2026-10-20T00:00:00Z'), s('b', '2026-10-01T00:00:00Z', true, 1)], 'a', true);
    expect(orderConversations(list).map((x) => x.id)).toEqual(['a', 'b']);
    expect(withPinned(list, 'a', false).find((x) => x.id === 'a')?.pinned).toBe(false);
  });

  it('reads a saved list', () => {
    expect(parseSessions([s('a', 'x'), { id: 3 }])?.map((x) => x.id)).toEqual(['a']);
    expect(parseSessions({})).toBeNull();
  });
});
