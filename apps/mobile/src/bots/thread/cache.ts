/**
 * The last few Bots threads, in memory, so switching back to one shows it at
 * once while the fresh page loads (spec §2.7.6 "打开" 1, D19).
 *
 * Memory only — a private conversation never touches the disk and nothing
 * here is logged. LRU of `THREAD_CACHE_LIMIT` threads, each holding at most
 * the newest `PAGE_SIZE × 2` messages. Entries are stamped with the Bots
 * store's `generation`, which `reset()` bumps on sign-out, a different
 * account or a station switch: an entry from another generation is never
 * served, and the first look under a new one empties the cache.
 */

import type { BotConversationDetail, BotMessage } from '../../shared/bots';
import { PAGE_SIZE } from '../vendor/web-helpers';

export const THREAD_CACHE_LIMIT = 6;
/** Messages kept per thread: the two newest pages. */
export const CACHED_MESSAGES = PAGE_SIZE * 2;

export interface CachedThread {
  conversation: BotConversationDetail;
  /** `seq` ascending, the newest `CACHED_MESSAGES` at most. */
  messages: BotMessage[];
  hasMore: boolean;
  memoryStates: Record<string, string>;
}

export class ThreadCache {
  private entries = new Map<string, CachedThread>();
  private generation: number | null = null;
  private readonly limit: number;

  constructor(limit = THREAD_CACHE_LIMIT) {
    this.limit = limit;
  }

  /** The cached thread, freshened as most recently used; null on a miss or under another generation. */
  get(sessionId: string, generation: number): CachedThread | null {
    this.sameGeneration(generation);
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
    return entry;
  }

  put(sessionId: string, generation: number, thread: CachedThread): void {
    this.sameGeneration(generation);
    const cut = thread.messages.length > CACHED_MESSAGES;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, {
      ...thread,
      messages: cut ? thread.messages.slice(-CACHED_MESSAGES) : thread.messages,
      // Older pages were dropped: the screen offers "load earlier" again.
      hasMore: thread.hasMore || cut,
    });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private sameGeneration(generation: number) {
    if (this.generation === generation) return;
    this.entries.clear();
    this.generation = generation;
  }
}

/** The app's one cache (the engine's default). */
export const threadCache = new ThreadCache();
