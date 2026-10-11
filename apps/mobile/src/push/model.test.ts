import { describe, expect, it } from 'vitest';

import {
  createTapLedger,
  forThread,
  hrefOf,
  planTap,
  routeOf,
  shouldPresent,
  SOFT_ASK_COOLDOWN_MS,
  softAskDue,
  staleIds,
} from './model';

const card = {
  v: 1,
  s: 'st-home',
  u: 'user-1',
  k: 'needs_you',
  sid: 'bots-dm-1',
  rid: 'brq_1',
  nid: 'ntf_1',
  url: '/bots?c=bots-dm-1&request=brq_1',
};
const reply = {
  v: 1,
  s: 'st-home',
  u: 'user-1',
  k: 'replies',
  sid: 'bots-dm-2',
  nid: 'ntf_2',
  url: '/bots?c=bots-dm-2',
};
const automation = {
  v: 1,
  s: 'st-home',
  u: 'user-1',
  k: 'done',
  sid: 'session-9',
  nid: 'ntf_3',
  url: '/chat/session-9',
};

describe('where a tap goes', () => {
  it('opens the card, the thread or the result session through the existing deep links', () => {
    expect(routeOf(card as never)).toEqual({ kind: 'thread', c: 'bots-dm-1', request: 'brq_1' });
    expect(hrefOf(routeOf(card as never))).toBe('/bots?c=bots-dm-1&request=brq_1');
    expect(hrefOf(routeOf(reply as never))).toBe('/bots?c=bots-dm-2');
    expect(hrefOf(routeOf(automation as never))).toBe('/chat/session-9');
    // no url: a card still finds its thread
    const { url: _drop, ...bare } = card;
    expect(routeOf(bare as never)).toEqual({ kind: 'thread', c: 'bots-dm-1', request: 'brq_1' });
    // anything else is not followed
    expect(routeOf({ ...automation, url: 'https://evil.example/x' } as never)).toEqual({ kind: 'home' });
    expect(routeOf({ ...card, url: '/bots?c=../../etc' } as never)).toEqual({ kind: 'home' });
  });

  it('switches to the station that sent it first, and opens only what belongs to the signed-in account', () => {
    const base = { activeStationId: 'st-home', knownStationIds: ['st-home', 'st-work'], userId: 'user-1' };
    expect(planTap({ ...base, data: card })).toEqual({
      action: 'open',
      route: { kind: 'thread', c: 'bots-dm-1', request: 'brq_1' },
    });
    expect(planTap({ ...base, data: { ...card, s: 'st-work', u: 'user-7' } })).toEqual({
      action: 'switch',
      stationId: 'st-work',
      route: { kind: 'thread', c: 'bots-dm-1', request: 'brq_1' },
    });
    // a station removed since: just the app
    expect(planTap({ ...base, data: { ...card, s: 'st-gone' } })).toEqual({ action: 'open', route: { kind: 'home' } });
    // the phone changed hands on this station
    expect(planTap({ ...base, data: { ...card, u: 'someone-else' } })).toEqual({
      action: 'open',
      route: { kind: 'home' },
    });
    expect(planTap({ ...base, data: { v: 1, s: 'st-home', u: 'user-1', k: 'test', nid: 'test' } })).toEqual({
      action: 'open',
      route: { kind: 'home' },
    });
    expect(planTap({ ...base, data: { hello: 'world' } })).toEqual({ action: 'ignore' });
  });

  it('switches even from a signed-out station, and waits for a sign-in on its own', () => {
    const signedOut = { activeStationId: 'st-new', knownStationIds: ['st-home', 'st-new'], userId: null };
    expect(planTap({ ...signedOut, data: card })).toEqual({
      action: 'switch',
      stationId: 'st-home',
      route: { kind: 'thread', c: 'bots-dm-1', request: 'brq_1' },
    });
    const home = { ...signedOut, activeStationId: 'st-home' };
    expect(planTap({ ...home, data: card })).toEqual({ action: 'wait' });
    // nothing to open there anyway: no need to wait
    expect(planTap({ ...home, data: { ...card, k: 'test', url: undefined } })).toEqual({
      action: 'open',
      route: { kind: 'home' },
    });
    // after the sign-in: the account's own opens, anyone else's goes home
    expect(planTap({ ...home, userId: 'user-1', data: card }).action).toBe('open');
    expect(planTap({ ...home, userId: 'user-9', data: card })).toEqual({ action: 'open', route: { kind: 'home' } });
  });
});

describe('in the foreground', () => {
  it('keeps the thread on screen quiet and shows everything else', () => {
    expect(shouldPresent({ data: reply, activeStationId: 'st-home', visibleThread: 'bots-dm-2' })).toBe(false);
    expect(shouldPresent({ data: reply, activeStationId: 'st-home', visibleThread: 'bots-dm-1' })).toBe(true);
    expect(shouldPresent({ data: reply, activeStationId: 'st-home', visibleThread: null })).toBe(true);
    // the same session id on another station is another conversation
    expect(
      shouldPresent({ data: { ...reply, s: 'st-work' }, activeStationId: 'st-home', visibleThread: 'bots-dm-2' }),
    ).toBe(true);
    expect(shouldPresent({ data: { foreign: true }, activeStationId: 'st-home', visibleThread: 'bots-dm-2' })).toBe(
      true,
    );
  });
});

describe('clearing banners', () => {
  const presented = [
    { id: 'n1', data: card },
    { id: 'n2', data: reply },
    { id: 'n3', data: { ...reply, s: 'st-work' } },
    { id: 'n4', data: automation },
    { id: 'n5', data: { other: 'app' } },
  ];

  it('clears a conversation’s own banners when it opens', () => {
    expect(forThread(presented, 'st-home', 'bots-dm-2')).toEqual(['n2']);
    expect(forThread(presented, 'st-home', 'bots-dm-1')).toEqual(['n1']);
  });

  it('clears cards decided elsewhere and replies read elsewhere — this station’s only', () => {
    expect(
      staleIds(presented, {
        stationId: 'st-home',
        pendingRequestIds: new Set(),
        unreadSessionIds: new Set(['bots-dm-2']),
      }),
    ).toEqual(['n1']);
    expect(
      staleIds(presented, {
        stationId: 'st-home',
        pendingRequestIds: new Set(['brq_1']),
        unreadSessionIds: new Set(),
      }),
    ).toEqual(['n2']);
  });
});

describe('the soft ask', () => {
  const now = Date.parse('2026-10-10T08:00:00.000Z');
  it('asks while the system was never asked, at most once per 14 days', () => {
    expect(softAskDue({ permission: 'undetermined', supported: true, lastAskedAt: null, now })).toBe(true);
    expect(softAskDue({ permission: 'undetermined', supported: true, lastAskedAt: now - 1000, now })).toBe(false);
    expect(
      softAskDue({ permission: 'undetermined', supported: true, lastAskedAt: now - SOFT_ASK_COOLDOWN_MS, now }),
    ).toBe(true);
    expect(softAskDue({ permission: 'denied', supported: true, lastAskedAt: null, now })).toBe(false);
    expect(softAskDue({ permission: 'granted', supported: true, lastAskedAt: null, now })).toBe(false);
    expect(softAskDue({ permission: 'undetermined', supported: false, lastAskedAt: null, now })).toBe(false);
  });
});

describe('tap ledger', () => {
  it('handles a tap once even when both the launch check and the listener report it', () => {
    const ledger = createTapLedger(2);
    expect(ledger.first('a')).toBe(true);
    expect(ledger.first('a')).toBe(false);
    expect(ledger.first('b')).toBe(true);
    expect(ledger.first('c')).toBe(true);
    expect(ledger.first('a')).toBe(true); // forgotten beyond the window
  });
});
