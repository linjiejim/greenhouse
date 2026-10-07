/**
 * The polling fallback (./polling.ts): silent while the socket is open, a beat
 * only after it has been down for the grace period while active, the grace
 * counted from the later of "went down" and "became active".
 */

import { describe, expect, it } from 'vitest';
import { createFallbackPoller, POLL_GRACE_MS } from './polling';
import { FakeClock, FakeRealtime } from './test-fakes';

function setup(status: 'open' | 'backoff' = 'open') {
  const time = new FakeClock();
  const rt = new FakeRealtime(time.clock.now, status);
  const beats: number[] = [];
  const poller = createFallbackPoller({
    realtime: rt,
    clock: time.clock,
    intervalMs: 8_000,
    tick: (n) => beats.push(n),
  });
  return { time, rt, beats, poller };
}

describe('createFallbackPoller', () => {
  it('never beats while the socket is open', async () => {
    const t = setup('open');
    t.poller.setActive(true);
    await t.time.advance(10 * 60_000);
    expect(t.beats).toEqual([]);
    expect(t.time.pending()).toEqual([]);
  });

  it('beats after the grace, then on the interval; stops the moment the socket is back', async () => {
    const t = setup('open');
    t.poller.setActive(true);
    t.rt.setStatus('connecting');
    await t.time.advance(POLL_GRACE_MS - 1);
    expect(t.beats).toEqual([]);
    // Moving between down states keeps the countdown.
    t.rt.setStatus('backoff');
    await t.time.advance(1);
    expect(t.beats).toEqual([1]);
    await t.time.advance(16_000);
    expect(t.beats).toEqual([1, 2, 3]);
    t.rt.setStatus('open');
    await t.time.advance(60_000);
    expect(t.beats).toEqual([1, 2, 3]);
    // Down again: a fresh count.
    t.rt.setStatus('cooling');
    await t.time.advance(POLL_GRACE_MS);
    expect(t.beats).toEqual([1, 2, 3, 1]);
  });

  it('counts the grace from becoming active when the socket went down long before', async () => {
    const t = setup('backoff');
    await t.time.advance(5 * 60_000);
    expect(t.beats).toEqual([]);
    t.poller.setActive(true);
    await t.time.advance(POLL_GRACE_MS - 1);
    expect(t.beats).toEqual([]);
    await t.time.advance(1);
    expect(t.beats).toEqual([1]);
    t.poller.setActive(false);
    await t.time.advance(60_000);
    expect(t.beats).toEqual([1]);
  });

  it('dispose stops everything', async () => {
    const t = setup('backoff');
    t.poller.setActive(true);
    t.poller.dispose();
    t.rt.setStatus('connecting');
    await t.time.advance(60_000);
    expect(t.beats).toEqual([]);
  });
});
