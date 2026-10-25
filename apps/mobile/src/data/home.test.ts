import { describe, expect, it } from 'vitest';
import type { ChatSession } from '../shared/greenhouse-types';
import {
  conversationAgent,
  DEFAULT_HOME_RECENT,
  EGG_TAPS,
  EGG_WINDOW_MS,
  greetingFor,
  NO_SPROUT_TAPS,
  tapSprout,
  homeRecentOf,
  orderConversations,
  parseSessions,
  withPinned,
} from './home';

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
    const list = [
      s('old', '2026-10-01T00:00:00Z'),
      s('new', '2026-10-20T00:00:00Z'),
      s('p2', '2026-09-01T00:00:00Z', true, 2),
      s('p1', '2026-09-02T00:00:00Z', true, 1),
    ];
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

describe('home recent count', () => {
  it('reads a saved choice and refuses anything else', () => {
    expect(DEFAULT_HOME_RECENT).toBe(3);
    expect(homeRecentOf('0')).toBe(0);
    expect(homeRecentOf('10')).toBe(10);
    expect(homeRecentOf('4')).toBeNull();
    expect(homeRecentOf('')).toBeNull();
    expect(homeRecentOf(null)).toBeNull();
    expect(homeRecentOf('three')).toBeNull();
  });
});

describe('tapping the greeting sprout', () => {
  it('answers each tap with the next face', () => {
    let taps = NO_SPROUT_TAPS;
    const faces: string[] = [];
    for (const at of [0, 3000, 6000, 9000]) {
      const next = tapSprout(taps, at);
      taps = next.taps;
      faces.push(next.reaction);
      expect(next.egg).toBe(false);
    }
    expect(faces).toEqual(['done', 'hello', 'speaking', 'done']);
  });

  it('makes the easter egg from quick taps, then counts again', () => {
    let taps = NO_SPROUT_TAPS;
    const eggs: boolean[] = [];
    for (let i = 0; i < EGG_TAPS + 1; i++) {
      const next = tapSprout(taps, i * 200);
      taps = next.taps;
      eggs.push(next.egg);
    }
    expect(eggs).toEqual([false, false, false, false, true, false]);
    expect(taps.recent).toHaveLength(1);
  });

  it('forgets taps older than the window', () => {
    let taps = NO_SPROUT_TAPS;
    for (let i = 0; i < EGG_TAPS - 1; i++) taps = tapSprout(taps, i * 100).taps;
    expect(tapSprout(taps, EGG_WINDOW_MS + 500).egg).toBe(false);
  });
});
