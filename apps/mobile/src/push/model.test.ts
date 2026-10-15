import { describe, expect, it } from 'vitest';

import {
  createTapLedger,
  forConversation,
  parsePushData,
  planTap,
  routeOf,
  shouldPresent,
  SOFT_ASK_COOLDOWN_MS,
  softAskDue,
  staleIds,
} from './model';

/** As apps/api/src/modules/channels/push.ts `pushData` writes them. */
const card = {
  v: 1,
  s: 'st-home',
  u: 'user-1',
  k: 'needs_you',
  nid: 'ntf_1',
  sid: 'conv-1',
  rid: 'req_1',
  url: '/c/conv-1',
};
const reply = {
  v: 1,
  s: 'st-home',
  u: 'user-1',
  k: 'replies',
  nid: 'ntf_2',
  sid: 'conv-2',
  url: '/c/conv-2',
};
const runDone = {
  v: 1,
  s: 'st-home',
  u: 'user-1',
  k: 'done',
  nid: 'ntf_3',
  url: '/runs/run-9',
  run: 'run-9',
  st: 'succeeded',
};

describe('reading a push', () => {
  it('keeps ids only, and refuses anything that is not ours', () => {
    expect(parsePushData(runDone)).toEqual(runDone);
    expect(parsePushData({ ...card, s: null })).toMatchObject({ s: null, sid: 'conv-1' });
    expect(parsePushData({ ...card, v: 2 })).toBeNull();
    expect(parsePushData({ ...card, k: 'gossip' })).toBeNull();
    expect(parsePushData({ ...card, sid: '../../etc' })).toBeNull();
    expect(parsePushData({ ...runDone, st: 'exploded' })).toBeNull();
    expect(parsePushData([card])).toBeNull();
  });
});

describe('where a tap goes', () => {
  it('opens the conversation at its card, a run, or the notification center for what has no screen here', () => {
    expect(routeOf(parsePushData(card)!)).toEqual({ kind: 'conversation', id: 'conv-1', request: 'req_1' });
    expect(routeOf(parsePushData(reply)!)).toEqual({ kind: 'conversation', id: 'conv-2', request: '' });
    expect(routeOf(parsePushData(runDone)!)).toEqual({ kind: 'place', route: { kind: 'run', id: 'run-9' } });
    // no conversation id: the url still finds it (and only a card scrolls to its card)
    const { sid: _drop, ...bare } = card;
    expect(routeOf(parsePushData(bare)!)).toEqual({ kind: 'conversation', id: 'conv-1', request: 'req_1' });
    expect(
      routeOf(parsePushData({ v: 1, s: 'st-home', u: 'user-1', k: 'other', nid: 'n', url: '/knowledge/doc-1' })!),
    ).toEqual({ kind: 'place', route: { kind: 'knowledge', id: 'doc-1' } });
    // anything else is not followed
    expect(routeOf(parsePushData({ ...runDone, url: 'https://evil.example/x' })!)).toEqual({ kind: 'home' });
    expect(routeOf(parsePushData({ ...runDone, url: '/runs/../../etc' })!)).toEqual({ kind: 'home' });
    expect(routeOf(parsePushData({ ...card, k: 'test' })!)).toEqual({ kind: 'home' });
  });

  it('switches to the station that sent it first, and opens only what belongs to the signed-in account', () => {
    const base = { activeStationId: 'st-home', knownStationIds: ['st-home', 'st-work'], userId: 'user-1' };
    const toCard = { kind: 'conversation', id: 'conv-1', request: 'req_1' };
    expect(planTap({ ...base, data: card })).toEqual({ action: 'open', route: toCard });
    expect(planTap({ ...base, data: { ...card, s: 'st-work', u: 'user-7' } })).toEqual({
      action: 'switch',
      stationId: 'st-work',
      route: toCard,
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
    expect(planTap({ ...signedOut, data: card })).toMatchObject({ action: 'switch', stationId: 'st-home' });
    const home = { ...signedOut, activeStationId: 'st-home' };
    expect(planTap({ ...home, data: card })).toEqual({ action: 'wait' });
    // nothing to open there anyway: no need to wait
    expect(planTap({ ...home, data: { ...card, k: 'test' } })).toEqual({ action: 'open', route: { kind: 'home' } });
    // after the sign-in: the account's own opens, anyone else's goes home
    expect(planTap({ ...home, userId: 'user-1', data: card }).action).toBe('open');
    expect(planTap({ ...home, userId: 'user-9', data: card })).toEqual({ action: 'open', route: { kind: 'home' } });
  });
});

describe('in the foreground', () => {
  it('keeps the conversation on screen quiet and shows everything else', () => {
    const at = (visibleConversation: string | null, data: unknown = reply) =>
      shouldPresent({ data, activeStationId: 'st-home', visibleConversation });
    expect(at('conv-2')).toBe(false);
    expect(at('conv-1')).toBe(true);
    expect(at(null)).toBe(true);
    // the same id on another station is another conversation
    expect(at('conv-2', { ...reply, s: 'st-work' })).toBe(true);
    expect(at('conv-2', { foreign: true })).toBe(true);
    expect(at('conv-2', runDone)).toBe(true);
  });
});

describe('clearing banners', () => {
  const presented = [
    { id: 'n1', data: card },
    { id: 'n2', data: reply },
    { id: 'n3', data: { ...reply, s: 'st-work' } },
    { id: 'n4', data: runDone },
    { id: 'n5', data: { other: 'app' } },
  ];

  it('clears a conversation’s own banners when it opens', () => {
    expect(forConversation(presented, 'st-home', 'conv-2')).toEqual(['n2']);
    expect(forConversation(presented, 'st-home', 'conv-1')).toEqual(['n1']);
  });

  it('clears cards decided elsewhere and replies read elsewhere — this station’s only', () => {
    expect(
      staleIds(presented, {
        stationId: 'st-home',
        pendingRequestIds: new Set(),
        unreadConversationIds: new Set(['conv-2']),
      }),
    ).toEqual(['n1']);
    expect(
      staleIds(presented, {
        stationId: 'st-home',
        pendingRequestIds: new Set(['req_1']),
        unreadConversationIds: new Set(),
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

it('opens a one-off reminder push in its conversation without carrying its text',()=>{
  const push={v:1,s:'station-u2',u:'member-u2',k:'other',nid:'notification-u2',sid:'conversation-u2',url:'/c/conversation-u2'};
  expect(parsePushData(push)).toEqual(push);
  expect(routeOf(parsePushData(push)!)).toEqual({kind:'conversation',id:'conversation-u2',request:''});
  expect(shouldPresent({data:push,activeStationId:'station-u2',visibleConversation:'conversation-u2'})).toBe(false);
});
