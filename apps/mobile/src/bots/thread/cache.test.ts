/**
 * The in-memory thread cache (./cache.ts): LRU of six, the two newest pages
 * per thread, and nothing served across a store generation (another account /
 * station).
 */

import { describe, expect, it } from 'vitest';
import { CACHED_MESSAGES, ThreadCache, THREAD_CACHE_LIMIT } from './cache';
import { conversation, message } from './test-fakes';

const thread = (sessionId: string, count = 1) => ({
  conversation: conversation(sessionId),
  messages: Array.from({ length: count }, (_, i) => message(i)),
  hasMore: false,
  memoryStates: {},
});

describe('ThreadCache', () => {
  it('keeps the six most recently used threads', () => {
    const cache = new ThreadCache();
    for (let i = 0; i < THREAD_CACHE_LIMIT; i += 1) cache.put(`s${i}`, 1, thread(`s${i}`));
    // Touch the oldest: it becomes the newest.
    expect(cache.get('s0', 1)).not.toBeNull();
    cache.put('s6', 1, thread('s6'));
    expect(cache.size).toBe(THREAD_CACHE_LIMIT);
    expect(cache.get('s1', 1)).toBeNull();
    expect(cache.get('s0', 1)?.conversation.session_id).toBe('s0');
  });

  it('keeps only the two newest pages, and then offers "load earlier"', () => {
    const cache = new ThreadCache();
    cache.put('s1', 1, thread('s1', CACHED_MESSAGES + 30));
    const cached = cache.get('s1', 1);
    expect(cached?.messages).toHaveLength(CACHED_MESSAGES);
    expect(cached?.messages[0].seq).toBe(30);
    expect(cached?.hasMore).toBe(true);
    cache.put('s2', 1, thread('s2', 3));
    expect(cache.get('s2', 1)?.hasMore).toBe(false);
  });

  it('serves nothing from another generation, and empties itself on the first look under a new one', () => {
    const cache = new ThreadCache();
    cache.put('s1', 1, thread('s1'));
    expect(cache.get('s1', 2)).toBeNull();
    expect(cache.size).toBe(0);
    expect(cache.get('s1', 1)).toBeNull();
  });
});
