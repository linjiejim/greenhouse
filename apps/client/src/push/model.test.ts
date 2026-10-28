import { describe, expect, it } from 'vitest';

import {
  createTapLedger,
  parsePushData,
  planTap,
  readBanners,
  stationBanners,
  routeOf,
  shouldPresent,
  SOFT_ASK_COOLDOWN_MS,
  softAskDue,
} from './model';

/** As apps/api/src/notifications/push/deliver.ts writes them. */
const push = {
  v: 1,
  s: 'st-home',
  u: 'user-1',
  k: 'needs_you',
  nid: 'ntf_1',
  url: '/notification?id=ntf_1',
};
const test = { v: 1, s: 'st-home', u: 'user-1', k: 'test', nid: 'test' };

describe('push data', () => {
  it('reads what the server sends and nothing else', () => {
    expect(parsePushData(push)).toEqual(push);
    expect(parsePushData({ ...push, v: 2 })).toBeNull();
    expect(parsePushData({ ...push, k: 'replies' })).toBeNull();
    expect(parsePushData({ ...push, nid: 'has space' })).toBeNull();
    expect(parsePushData({ ...push, url: 'https://evil.example/notification?id=ntf_1' })).toBeNull();
    expect(parsePushData('nope')).toBeNull();
  });

  it('routes to the notification it is about, never to a url that names another', () => {
    expect(routeOf(push)).toEqual({ kind: 'notification', id: 'ntf_1' });
    expect(routeOf({ ...push, url: undefined })).toEqual({ kind: 'notification', id: 'ntf_1' });
    expect(routeOf({ ...push, url: '/notification?id=ntf_2' })).toEqual({ kind: 'home' });
    expect(routeOf({ ...push, url: '/settings' })).toEqual({ kind: 'home' });
    expect(routeOf(test)).toEqual({ kind: 'home' });
  });
});

describe('planTap', () => {
  const base = { activeStationId: 'st-home', knownStationIds: ['st-home', 'st-work'], userId: 'user-1' };

  it('opens its notification on its own station for its own member', () => {
    expect(planTap({ ...base, data: push })).toEqual({
      action: 'open',
      route: { kind: 'notification', id: 'ntf_1' },
    });
  });

  it('switches to the station that sent it first, or lands home for a removed station', () => {
    expect(planTap({ ...base, activeStationId: 'st-work', data: push })).toEqual({
      action: 'switch',
      stationId: 'st-home',
      route: { kind: 'notification', id: 'ntf_1' },
    });
    expect(planTap({ ...base, knownStationIds: ['st-work'], activeStationId: 'st-work', data: push })).toEqual({
      action: 'open',
      route: { kind: 'home' },
    });
  });

  it('waits for a sign-in, and never opens someone else’s notification', () => {
    expect(planTap({ ...base, userId: null, data: push })).toEqual({ action: 'wait' });
    expect(planTap({ ...base, userId: 'user-2', data: push })).toEqual({ action: 'open', route: { kind: 'home' } });
  });

  it('ignores what is not ours and opens the app for a test push', () => {
    expect(planTap({ ...base, data: { hello: 'world' } })).toEqual({ action: 'ignore' });
    expect(planTap({ ...base, data: test })).toEqual({ action: 'open', route: { kind: 'home' } });
  });
});

describe('foreground and banners', () => {
  it('keeps the notification on screen quiet', () => {
    expect(shouldPresent({ data: push, activeStationId: 'st-home', visibleNotification: 'ntf_1' })).toBe(false);
    expect(shouldPresent({ data: push, activeStationId: 'st-home', visibleNotification: 'ntf_9' })).toBe(true);
    expect(shouldPresent({ data: push, activeStationId: 'st-work', visibleNotification: 'ntf_1' })).toBe(true);
    expect(shouldPresent({ data: push, activeStationId: 'st-home', visibleNotification: null })).toBe(true);
  });

  it('clears the banners of read notifications on this station only', () => {
    const shown = [
      { id: 'a', data: push },
      { id: 'b', data: { ...push, nid: 'ntf_2', url: '/notification?id=ntf_2' } },
      { id: 'c', data: { ...push, s: 'st-work', nid: 'ntf_3', url: undefined } },
      { id: 'd', data: test },
      { id: 'e', data: { other: 'app' } },
    ];
    expect(readBanners(shown, { stationId: 'st-home', readIds: new Set(['ntf_1']) })).toEqual(['a']);
    // a notification the phone has not loaded is never assumed read
    expect(readBanners(shown, { stationId: 'st-home', readIds: new Set() })).toEqual([]);
    expect(readBanners(shown, { stationId: 'st-home', readIds: new Set(['ntf_1', 'ntf_2', 'ntf_3']) })).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('after marking everything read', () => {
  it('clears every banner of this station, loaded in the list or not, and nothing else', () => {
    const shown = [
      { id: 'a', data: push },
      { id: 'b', data: { ...push, nid: 'ntf_999', url: '/notification?id=ntf_999' } },
      { id: 'c', data: { ...push, s: 'st-work', nid: 'ntf_3', url: undefined } },
      { id: 'e', data: { other: 'app' } },
    ];
    expect(stationBanners(shown, 'st-home')).toEqual(['a', 'b']);
  });
});

describe('the soft ask', () => {
  const now = Date.parse('2026-10-23T08:00:00Z');
  it('asks only while the system was never asked, the station pushes, and not too often', () => {
    expect(softAskDue({ permission: 'undetermined', supported: true, lastAskedAt: null, now })).toBe(true);
    expect(softAskDue({ permission: 'granted', supported: true, lastAskedAt: null, now })).toBe(false);
    expect(softAskDue({ permission: 'undetermined', supported: false, lastAskedAt: null, now })).toBe(false);
    expect(softAskDue({ permission: 'undetermined', supported: true, lastAskedAt: now - 1000, now })).toBe(false);
    expect(
      softAskDue({ permission: 'undetermined', supported: true, lastAskedAt: now - SOFT_ASK_COOLDOWN_MS, now }),
    ).toBe(true);
  });

  it('waits until the app comes back after a sign-in, so it never stacks on Save Password', () => {
    const base = { permission: 'undetermined', supported: true, lastAskedAt: null, now } as const;
    // signed in during this foreground session (launch at now - 60 s, sign-in at now - 10 s)
    expect(softAskDue({ ...base, signedInAt: now - 10_000, foregroundAt: now - 60_000 })).toBe(false);
    // the app went away and came back after that sign-in
    expect(softAskDue({ ...base, signedInAt: now - 10_000, foregroundAt: now - 1_000 })).toBe(true);
    // a restored session (no sign-in on this phone in this run)
    expect(softAskDue({ ...base, signedInAt: null, foregroundAt: now - 60_000 })).toBe(true);
  });
});

it('handles each tap once', () => {
  const ledger = createTapLedger(2);
  expect(ledger.first('a')).toBe(true);
  expect(ledger.first('a')).toBe(false);
  ledger.first('b');
  ledger.first('c');
  expect(ledger.first('a')).toBe(true);
});
