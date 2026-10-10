/**
 * Waking a Bot when a background process it started has ended
 * (process-watches.ts), against an in-memory store: which computers are
 * asked, what counts as ended, the wake-up itself, and that a watch is
 * settled exactly once even with two pollers.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BotComputerRow, BotProcessWatchRow } from '@greenhouse/db';
import type { ComputerProcessView } from '@greenhouse/types/bots';

import { checkProcessWatches, processEndedNote, WATCH_MAX_AGE_MS, type ProcessWatchDeps } from '../process-watches.js';
import type { InboxItem } from '../../engine/inbox-types.js';

const T0 = Date.parse('2026-10-10T08:00:00.000Z');

function job(id: string, patch: Partial<ComputerProcessView> = {}): ComputerProcessView {
  return {
    id,
    name: 'build',
    command: 'make',
    cwd: '/home/agent/work',
    status: 'running',
    exit_code: null,
    started_at: new Date(T0).toISOString(),
    ended_at: null,
    log_bytes: 10,
    ...patch,
  };
}

function setup(opts: { computers?: Record<string, BotComputerRow['state'] | null> } = {}) {
  const watches: BotProcessWatchRow[] = [];
  const computers = opts.computers ?? { u1: 'running' };
  const jobs = new Map<string, ComputerProcessView[]>();
  const delivered: Array<[string, InboxItem]> = [];
  let next = 1;
  const store: ProcessWatchDeps['store'] = {
    get: async (userId) =>
      computers[userId] ? ({ user_id: userId, state: computers[userId] } as BotComputerRow) : undefined,
    listWatchingUsers: async () => [...new Set(watches.filter((w) => w.status === 'watching').map((w) => w.user_id))],
    listWatches: async (userId) => watches.filter((w) => w.user_id === userId && w.status === 'watching'),
    settleWatch: async (id, status) => {
      const watch = watches.find((w) => w.id === id && w.status === 'watching');
      if (!watch) return undefined;
      watch.status = status;
      return { ...watch };
    },
    expireWatches: async (cutoff) => {
      let n = 0;
      for (const w of watches) if (w.status === 'watching' && w.created_at < cutoff) ((w.status = 'gone'), n++);
      return n;
    },
    dropWatches: async (userId) => {
      for (const w of watches) if (w.user_id === userId && w.status === 'watching') w.status = 'gone';
    },
  };
  const listJobs = vi.fn(async (userId: string) => (computers[userId] === 'running' ? (jobs.get(userId) ?? []) : null));
  const deps: ProcessWatchDeps = {
    store,
    listJobs,
    deliver: async (sessionId, item) => {
      delivered.push([sessionId, item]);
    },
    now: () => T0,
  };
  const watch = (userId: string, jobId: string, createdAt = T0) =>
    watches.push({
      id: next++,
      user_id: userId,
      session_id: `sess_${userId}`,
      bot_id: `bot_${userId}`,
      job_id: jobId,
      name: 'build',
      status: 'watching',
      created_at: new Date(createdAt).toISOString(),
      updated_at: new Date(createdAt).toISOString(),
    });
  return { deps, watches, jobs, delivered, listJobs, watch, computers };
}

describe('process watches', () => {
  it('wakes the Bot that started a process once it has exited, with its exit code', async () => {
    const { deps, jobs, delivered, watch, watches } = setup();
    watch('u1', 'j0000beef');
    jobs.set('u1', [job('j0000beef')]);
    expect(await checkProcessWatches(deps)).toEqual({ woken: 0 }); // still running
    jobs.set('u1', [job('j0000beef', { status: 'exited', exit_code: 2 })]);
    expect(await checkProcessWatches(deps)).toEqual({ woken: 1 });
    expect(delivered).toEqual([
      [
        'sess_u1',
        {
          kind: 'continue',
          botId: 'bot_u1',
          note: expect.stringContaining('ended with exit code 2'),
        },
      ],
    ]);
    expect(watches[0]!.status).toBe('notified');
    expect(await checkProcessWatches(deps)).toEqual({ woken: 0 }); // once
  });

  it('a process lost with its computer, or gone from the list, has ended too', async () => {
    const { deps, jobs, delivered, watch } = setup();
    watch('u1', 'j000000a1');
    watch('u1', 'j000000a2');
    jobs.set('u1', [job('j000000a1', { status: 'lost' })]);
    expect(await checkProcessWatches(deps)).toEqual({ woken: 2 });
    for (const [, item] of delivered) {
      expect(item).toMatchObject({ note: expect.stringContaining('stopped without an exit code') });
    }
  });

  it('never asks or wakes anything about a computer that is not running', async () => {
    const { deps, delivered, listJobs, watch, watches } = setup({ computers: { u1: 'absent' } });
    watch('u1', 'j0000beef');
    expect(await checkProcessWatches(deps)).toEqual({ woken: 0 });
    expect(listJobs).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
    expect(watches[0]!.status).toBe('watching'); // answered once it runs again
  });

  it('a computer that stopped between the check and the listing is asked again next round', async () => {
    const { deps, delivered, listJobs, watch, watches } = setup();
    watch('u1', 'j0000beef');
    listJobs.mockResolvedValueOnce(null);
    expect(await checkProcessWatches(deps)).toEqual({ woken: 0 });
    expect(delivered).toEqual([]);
    expect(watches[0]!.status).toBe('watching');
  });

  it('drops the watches of a member whose computer is gone, and gives up on old ones', async () => {
    const { deps, watch, watches } = setup({ computers: { u1: 'running' } });
    watch('gone', 'j0000beef');
    watch('u1', 'j000000a1', T0 - WATCH_MAX_AGE_MS - 1);
    await checkProcessWatches(deps);
    expect(watches.map((w) => w.status)).toEqual(['gone', 'gone']);
  });

  it('two pollers wake the Bot once', async () => {
    const { deps, jobs, delivered, watch } = setup();
    watch('u1', 'j0000beef');
    jobs.set('u1', [job('j0000beef', { status: 'exited', exit_code: 0 })]);
    const results = await Promise.all([checkProcessWatches(deps), checkProcessWatches(deps)]);
    expect(results.reduce((sum, r) => sum + r.woken, 0)).toBe(1);
    expect(delivered).toHaveLength(1);
  });

  it('tells the Bot to read the log and report in a few lines', () => {
    expect(
      processEndedNote({ job_id: 'j0000beef', name: 'tests' }, job('j0000beef', { status: 'exited', exit_code: 0 })),
    ).toBe(
      'Your background process "tests" (j0000beef) ended with exit code 0. Read the end of its log with process_log {id: "j0000beef"} and tell the member the outcome in a few lines.',
    );
  });
});
