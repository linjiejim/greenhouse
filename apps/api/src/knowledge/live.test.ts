/** `knowledge.changed` fan-out: ids only, and a failing audience lookup never reaches the writer. */

import { describe, expect, it, vi } from 'vitest';

const listeners = vi.hoisted(() => [] as Array<(change: unknown) => void>);
vi.mock('@greenhouse/db', () => ({
  onKnowledgeDocChange: (listener: (change: unknown) => void) => {
    listeners.push(listener);
    return () => listeners.splice(listeners.indexOf(listener), 1);
  },
}));
const ws = vi.hoisted(() => ({ broadcast: vi.fn(), sendToUser: vi.fn() }));
vi.mock('../ws/connection-manager.js', () => ({ connectionManager: ws }));
vi.mock('@greenhouse/utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { startKnowledgeLiveUpdates } from './live.js';

const doc = (over: Record<string, unknown> = {}) => ({
  id: 7,
  visibility: 'private',
  owner_user_id: 'owner',
  title: 'secret title',
  content: 'secret body',
  ...over,
});

describe('startKnowledgeLiveUpdates', () => {
  it('sends ids and the change kind only — never the title or body', async () => {
    const shares = { userIdsWithAccess: vi.fn(async () => ['reader']) };
    const stop = startKnowledgeLiveUpdates({ knowledgeShares: shares } as never);
    listeners[0]!({ kind: 'archived', doc: doc() });
    await vi.waitFor(() => expect(ws.sendToUser).toHaveBeenCalledTimes(2));
    for (const [, event] of ws.sendToUser.mock.calls) {
      expect(event).toEqual({ type: 'knowledge.changed', docId: 7, change: 'archived' });
    }
    expect(ws.broadcast).not.toHaveBeenCalled();
    stop();
    expect(listeners).toHaveLength(0);
  });

  it('swallows an audience lookup failure (logged, not thrown into the write)', async () => {
    ws.sendToUser.mockClear();
    const shares = { userIdsWithAccess: vi.fn(async () => Promise.reject(new Error('db down'))) };
    const stop = startKnowledgeLiveUpdates({ knowledgeShares: shares } as never);
    expect(() => listeners[0]!({ kind: 'updated', doc: doc() })).not.toThrow();
    await vi.waitFor(() => expect(shares.userIdsWithAccess).toHaveBeenCalled());
    expect(ws.sendToUser).not.toHaveBeenCalled();
    stop();
  });
});
