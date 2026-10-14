/**
 * A resync hint (./sync.ts): the server sends `conversation.resync` instead of an event too big
 * to pass between its processes. Runs in the ROOT vitest unit project with the stores faked (no
 * React Native module loads).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  threads: {} as Record<string, unknown>,
  catchUp: vi.fn(async (_id: string) => undefined),
  refreshConversations: vi.fn(async () => undefined),
}));

vi.mock('../store/threads', () => ({
  useThreads: { getState: () => ({ threads: fake.threads, catchUp: fake.catchUp }) },
}));
vi.mock('../store/workspace', () => ({
  useWorkspace: { getState: () => ({ refreshConversations: fake.refreshConversations }) },
}));
vi.mock('../data/streams', () => ({
  appendDelta: vi.fn(),
  endStream: vi.fn(),
  forgetStream: vi.fn(),
  upsertStep: vi.fn(),
}));

import { applyEvent } from './sync';

beforeEach(() => {
  vi.useFakeTimers();
  fake.catchUp.mockClear();
  fake.refreshConversations.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('a resync hint', () => {
  it('catches an open conversation up and refreshes the list once', () => {
    fake.threads = { c1: { status: 'ready' } };
    applyEvent({ type: 'conversation.resync', data: { conversation_id: 'c1', after_seq: 4 } });
    applyEvent({ type: 'conversation.resync', data: { conversation_id: 'c2', after_seq: 1 } });
    // Only the conversation this phone has open is fetched; the list refreshes once for both.
    expect(fake.catchUp.mock.calls).toEqual([['c1']]);
    vi.runAllTimers();
    expect(fake.refreshConversations).toHaveBeenCalledTimes(1);
  });
});
