/**
 * ChatRun registry unit tests — buffer/replay/subscribe semantics, the
 * one-run-per-session claim, stop/abort wiring, retention eviction and the
 * graceful-shutdown drain. Pure in-memory; no DB.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatRun, chatRunRegistry } from '../chat/runs.js';

let seq = 0;
const uniqueSession = () => `session-${++seq}-${Math.random().toString(36).slice(2)}`;

function collect() {
  const events: Array<Record<string, unknown>> = [];
  let endedWith: string | null = null;
  return {
    events,
    get endedWith() {
      return endedWith;
    },
    sub: {
      onEvent: (e: Record<string, unknown>) => events.push(e),
      onEnd: (status: string) => {
        endedWith = status;
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ChatRun buffering + subscription', () => {
  it('assigns monotonically increasing seq and fans out live events', () => {
    const run = new ChatRun(uniqueSession(), 'u1');
    const a = collect();
    run.subscribe(-1, a.sub);
    run.emit({ type: 'text-delta', text: 'x' });
    run.emit({ type: 'text-delta', text: 'y' });

    expect(a.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(a.events[0]).not.toHaveProperty('replayed');
  });

  it('replays only events after the requested seq, tagged replayed', () => {
    const run = new ChatRun(uniqueSession(), 'u1');
    run.emit({ type: 'text-delta', text: 'a' }); // seq 0
    run.emit({ type: 'text-delta', text: 'b' }); // seq 1

    const late = collect();
    run.subscribe(0, late.sub);
    expect(late.events).toEqual([{ type: 'text-delta', text: 'b', seq: 1, replayed: true }]);

    // Live events after the replay are untagged and in order.
    run.emit({ type: 'finish' }); // seq 2
    expect(late.events[1]).toMatchObject({ type: 'finish', seq: 2 });
    expect(late.events[1]).not.toHaveProperty('replayed');
  });

  it('a subscriber joining after end gets the replay plus an immediate onEnd', () => {
    const run = new ChatRun(uniqueSession(), 'u1');
    run.emit({ type: 'text-delta', text: 'a' });
    run.end('completed');

    const late = collect();
    run.subscribe(-1, late.sub);
    expect(late.events).toHaveLength(1);
    expect(late.endedWith).toBe('completed');
  });

  it('unsubscribe stops delivery; a broken subscriber cannot break the run', () => {
    const run = new ChatRun(uniqueSession(), 'u1');
    const a = collect();
    const unsubscribe = run.subscribe(-1, a.sub);
    run.subscribe(-1, {
      onEvent: () => {
        throw new Error('boom');
      },
      onEnd: () => {},
    });

    run.emit({ type: 'text-delta', text: 'a' });
    unsubscribe();
    run.emit({ type: 'text-delta', text: 'b' });
    expect(a.events).toHaveLength(1);
  });

  it('emit after end is a no-op', () => {
    const run = new ChatRun(uniqueSession(), 'u1');
    run.end('error');
    run.emit({ type: 'text-delta', text: 'late' });
    const late = collect();
    run.subscribe(-1, late.sub);
    expect(late.events).toHaveLength(0);
    expect(late.endedWith).toBe('error');
  });

  it('drops oldest events on buffer overflow but keeps streaming live', () => {
    const run = new ChatRun(uniqueSession(), 'u1');
    const live = collect();
    run.subscribe(-1, live.sub);

    const megabyte = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 10; i++) run.emit({ type: 'text-delta', text: megabyte });

    // Live subscriber saw everything regardless of the buffer cap.
    expect(live.events).toHaveLength(10);

    // A late replay starts from a later seq (the head was dropped).
    const late = collect();
    run.subscribe(-1, late.sub);
    expect(late.events.length).toBeLessThan(10);
    expect(late.events[0]!.seq).toBeGreaterThan(0);
  });
});

describe('stop/abort wiring', () => {
  it('requestStop records the first reason and fires the abort signal', () => {
    const run = new ChatRun(uniqueSession(), 'u1');
    expect(run.signal.aborted).toBe(false);
    run.requestStop('user');
    run.requestStop('shutdown');
    expect(run.signal.aborted).toBe(true);
    expect(run.stopReason).toBe('user');
  });

  it('resolves `ended` when the run ends', async () => {
    const run = new ChatRun(uniqueSession(), 'u1');
    let resolved = false;
    void run.ended.then(() => {
      resolved = true;
    });
    run.end('completed');
    await run.ended;
    expect(resolved).toBe(true);
  });
});

describe('registry claim semantics', () => {
  it('one running claim per session; released or finished claims free the slot', () => {
    const sessionId = uniqueSession();
    const run = chatRunRegistry.claim(sessionId, 'u1');
    expect(run).not.toBeNull();
    expect(chatRunRegistry.claim(sessionId, 'u1')).toBeNull();

    chatRunRegistry.release(run!);
    const second = chatRunRegistry.claim(sessionId, 'u1');
    expect(second).not.toBeNull();

    chatRunRegistry.finish(second!, 'completed');
    const third = chatRunRegistry.claim(sessionId, 'u1');
    expect(third).not.toBeNull();
    chatRunRegistry.finish(third!, 'completed');
  });

  it('getActive only returns running runs; get keeps the retained ended run', () => {
    const sessionId = uniqueSession();
    const run = chatRunRegistry.claim(sessionId, 'u1')!;
    expect(chatRunRegistry.getActive(sessionId)).toBe(run);

    chatRunRegistry.finish(run, 'completed');
    expect(chatRunRegistry.getActive(sessionId)).toBeUndefined();
    expect(chatRunRegistry.get(sessionId)).toBe(run);
  });

  it('evicts ended runs after the retention window', () => {
    vi.useFakeTimers();
    const sessionId = uniqueSession();
    const run = chatRunRegistry.claim(sessionId, 'u1')!;
    chatRunRegistry.finish(run, 'completed');
    expect(chatRunRegistry.get(sessionId)).toBe(run);

    vi.advanceTimersByTime(61_000);
    expect(chatRunRegistry.get(sessionId)).toBeUndefined();
  });

  it('lists only the caller’s running session runs; detached runs never appear', () => {
    const s1 = uniqueSession();
    const s2 = uniqueSession();
    const mine = chatRunRegistry.claim(s1, 'user-a')!;
    const theirs = chatRunRegistry.claim(s2, 'user-b')!;
    const detached = chatRunRegistry.createDetached('user-a');

    const listed = chatRunRegistry.listActiveForUser('user-a');
    expect(listed).toContain(mine);
    expect(listed).not.toContain(theirs);
    expect(listed).not.toContain(detached);

    chatRunRegistry.finish(mine, 'completed');
    chatRunRegistry.finish(theirs, 'completed');
    chatRunRegistry.finish(detached, 'completed');
    expect(chatRunRegistry.listActiveForUser('user-a')).toHaveLength(0);
  });

  it('shutdown aborts active runs and waits for their end', async () => {
    const sessionId = uniqueSession();
    const run = chatRunRegistry.claim(sessionId, 'u1')!;
    // Simulate the pump: persistence finishes shortly after the abort arrives.
    run.signal.addEventListener('abort', () => {
      setTimeout(() => chatRunRegistry.finish(run, 'error'), 10);
    });

    await chatRunRegistry.shutdown(2000);
    expect(run.status).toBe('error');
    expect(run.stopReason).toBe('shutdown');
  });
});
