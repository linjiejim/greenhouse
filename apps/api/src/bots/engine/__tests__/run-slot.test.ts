/**
 * Switching the `bots` feature off stops the member's in-process Bots runs —
 * and only those: their ordinary chats and other members' runs keep going.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { chatRunRegistry, type ChatRun } from '../../../chat/runs.js';
import { stopBotsRunsForUser } from '../run-slot.js';

const channels = new Map<string, string>([
  ['s-bots-1', 'bots'],
  ['s-bots-2', 'bots'],
  ['s-web', 'web'],
  ['s-bots-other', 'bots'],
]);

const db = {
  sessions: {
    getById: async (id: string) => (channels.has(id) ? { id, channel: channels.get(id) } : undefined),
  },
} as unknown as DatabaseProvider;

const claimed: ChatRun[] = [];

function claim(sessionId: string, userId: string): ChatRun {
  const run = chatRunRegistry.claim(sessionId, userId)!;
  claimed.push(run);
  return run;
}

afterEach(() => {
  for (const run of claimed.splice(0)) chatRunRegistry.release(run);
});

describe('stopBotsRunsForUser', () => {
  it('stops the member’s Bots runs only', async () => {
    const bots1 = claim('s-bots-1', 'u1');
    const bots2 = claim('s-bots-2', 'u1');
    const web = claim('s-web', 'u1');
    const other = claim('s-bots-other', 'u2');

    expect(await stopBotsRunsForUser(db, 'u1')).toBe(2);
    expect(bots1.signal.aborted).toBe(true);
    expect(bots1.stopReason).toBe('account-security');
    expect(bots2.signal.aborted).toBe(true);
    expect(web.signal.aborted).toBe(false);
    expect(other.signal.aborted).toBe(false);
  });

  it('keeps going when a session lookup fails, and never throws', async () => {
    const run = claim('s-bots-1', 'u3');
    const broken = {
      sessions: {
        getById: async () => {
          throw new Error('db down');
        },
      },
    } as unknown as DatabaseProvider;
    await expect(stopBotsRunsForUser(broken, 'u3')).resolves.toBe(0);
    expect(run.signal.aborted).toBe(false);
  });
});
