import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = vi.hoisted(() => ({ status: [] as Array<(status: string) => void> }));
vi.mock('../lib/ws', () => ({
  wsClient: {
    onStatusChange: (listener: (status: string) => void) => {
      listeners.status.push(listener);
      return () => {};
    },
    onEvent: () => () => {},
    connect: () => {},
    disconnect: () => {},
  },
}));
vi.mock('../components/ui', () => ({ toast: () => {} }));
vi.mock('../lib/runtime-invalidation', () => ({ notifyRuntimeInvalidated: () => {} }));

import { KNOWLEDGE_REMOTE_COALESCE_MS, useKnowledgeStore } from './knowledge-store';
import { useWsStore } from './ws-store';

describe('ws store reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useKnowledgeStore.setState({ version: 0 });
    useWsStore.getState();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('refetches knowledge after a reconnect, not on the first connect', () => {
    const emit = (status: string) => listeners.status.forEach((listener) => listener(status));
    emit('connected');
    vi.advanceTimersByTime(KNOWLEDGE_REMOTE_COALESCE_MS);
    expect(useKnowledgeStore.getState().version).toBe(0);

    emit('disconnected');
    emit('connected');
    vi.advanceTimersByTime(KNOWLEDGE_REMOTE_COALESCE_MS);
    expect(useKnowledgeStore.getState().version).toBe(1);
  });
});
