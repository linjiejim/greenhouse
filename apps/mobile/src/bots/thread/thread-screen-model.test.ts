/**
 * The thread screen's bookkeeping (./thread-screen-model.ts): row geometry that outlives its
 * row, anchors left waiting by runs that never replied, an earlier page landing while a reply
 * streams, a deep-linked card on a cached open, the ☰ badge's label. Root vitest, pure fixtures.
 */

import { describe, expect, it } from 'vitest';
import {
  deepLinkStep,
  drawerButtonLabel,
  expectOnRunSettled,
  expectOnRunStarted,
  menuBadge,
  prependStep,
  pruneRowGeometry,
  showsFreshPage,
  type ExpectAnchor,
  hintFits,
  textEm,
} from './thread-screen-model';

describe('pruneRowGeometry', () => {
  it("forgets a run's live reply once its row is gone, so the next run's segment:0 is measured afresh", () => {
    const geo = new Map([
      ['user:m1', { y: 0, h: 40 }],
      ['segment:0', { y: 420, h: 300 }],
    ]);
    // the run settled: its persisted reply took the live row's place
    pruneRowGeometry(geo, ['user:m1', 'bot:m2']);
    expect([...geo.keys()]).toEqual(['user:m1']);
    // the next run's first reply reuses the key — nothing stale to replay
    expect(geo.get('segment:0')).toBeUndefined();
  });

  it('keeps every mounted row, and empties when nothing is mounted', () => {
    const geo = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    pruneRowGeometry(geo, ['a', 'b', 'c']);
    expect(geo.size).toBe(2);
    pruneRowGeometry(geo, []);
    expect(geo.size).toBe(0);
  });
});

describe('expectOnRunStarted / expectOnRunSettled', () => {
  const atEnd = { endVisible: true, keyboardUp: false };

  it('follows a server run only at the end with the keyboard down', () => {
    expect(expectOnRunStarted(null, { runKey: 'r1', byMe: false }, atEnd)).toEqual({ kind: 'segment', runKey: 'r1' });
    expect(
      expectOnRunStarted(null, { runKey: 'r1', byMe: false }, { endVisible: false, keyboardUp: false }),
    ).toBeNull();
    expect(expectOnRunStarted(null, { runKey: 'r1', byMe: false }, { endVisible: true, keyboardUp: true })).toBeNull();
    expect(expectOnRunStarted(null, { runKey: 'r1', byMe: true }, atEnd)).toBeNull();
  });

  it('a run that never showed a reply leaves nothing waiting for a later one', () => {
    let expect_: ExpectAnchor = expectOnRunStarted(null, { runKey: 'r1', byMe: false }, atEnd);
    expect_ = expectOnRunSettled(expect_, 'r1');
    expect(expect_).toBeNull();
  });

  it("a later run drops an earlier run's leftover when it isn't followed itself", () => {
    const left: ExpectAnchor = { kind: 'segment', runKey: 'r1' };
    // the member scrolled up meanwhile: the new run lights the pill instead
    expect(
      expectOnRunStarted(left, { runKey: 'r2', byMe: false }, { endVisible: false, keyboardUp: false }),
    ).toBeNull();
    // the member's own send (keyboard up): Messages-style, nothing anchored
    expect(expectOnRunStarted(left, { runKey: 'r2', byMe: true }, { endVisible: true, keyboardUp: true })).toBeNull();
  });

  it("a send's pending anchor survives runs starting and settling", () => {
    const pending: ExpectAnchor = { kind: 'pending' };
    expect(expectOnRunStarted(pending, { runKey: 'r1', byMe: true }, atEnd)).toBe(pending);
    expect(expectOnRunSettled(pending, 'r0')).toBe(pending);
  });

  it("another run settling doesn't drop the anchor a newer run is waiting for", () => {
    const waiting: ExpectAnchor = { kind: 'segment', runKey: 'r2' };
    expect(expectOnRunSettled(waiting, 'r1')).toBe(waiting);
    expect(expectOnRunSettled(waiting, 'r2')).toBeNull();
  });
});

describe('prependStep', () => {
  it('counts only the page, not what a streaming reply added while it was in flight', () => {
    let hold = { height: 2000, first: 'm10' };
    // two stream ticks grow the reply by 60 pt before the page lands
    for (const h of [2030, 2060]) {
      const step = prependStep(hold, 'm10', h);
      expect(step.landed).toBe(false);
      if (!step.landed) hold = step.hold;
    }
    // the page (900 pt) lands above
    expect(prependStep(hold, 'm1', 2960)).toEqual({ landed: true, delta: 900 });
  });

  it('keeps the same hold when nothing moved', () => {
    const hold = { height: 1000, first: 'm5' };
    const step = prependStep(hold, 'm5', 1000);
    expect(step).toEqual({ landed: false, hold });
    if (!step.landed) expect(step.hold).toBe(hold);
  });
});

describe('deep-linked card', () => {
  const cached = { id: 'c1' };
  const network = { id: 'c1' };

  it('the cached copy a thread opens with is not fresh; the page that replaces it is', () => {
    expect(showsFreshPage({ conversation: cached, openedWith: cached, refreshFailed: false })).toBe(false);
    expect(showsFreshPage({ conversation: network, openedWith: cached, refreshFailed: false })).toBe(true);
  });

  it('a cold open (no cached copy) is fresh as soon as it has a conversation', () => {
    expect(showsFreshPage({ conversation: null, openedWith: null, refreshFailed: false })).toBe(false);
    expect(showsFreshPage({ conversation: network, openedWith: null, refreshFailed: false })).toBe(true);
  });

  it('a failed refresh settles it too', () => {
    expect(showsFreshPage({ conversation: cached, openedWith: cached, refreshFailed: true })).toBe(true);
  });

  it('waits on the cached copy, anchors once the card is in, gives up only on a fresh page without it', () => {
    expect(deepLinkStep({ ready: false, found: false, fresh: false })).toBe('wait');
    // warm open: the cache predates the card
    expect(deepLinkStep({ ready: true, found: false, fresh: false })).toBe('wait');
    // the fresh page brought it
    expect(deepLinkStep({ ready: true, found: true, fresh: true })).toBe('anchor');
    // already in the cached copy
    expect(deepLinkStep({ ready: true, found: true, fresh: false })).toBe('anchor');
    // the newest page doesn't have it either
    expect(deepLinkStep({ ready: true, found: false, fresh: true })).toBe('give-up');
  });
});

describe('☰ badge', () => {
  it('caps the drawn count', () => {
    expect(menuBadge(0)).toBe('');
    expect(menuBadge(3)).toBe('3');
    expect(menuBadge(99)).toBe('99');
    expect(menuBadge(100)).toBe('99+');
  });

  it('puts the count into the VoiceOver label, as the chat bar does', () => {
    const phrases = { badge: (n: string) => `${n} need your attention`, separator: ', ' };
    expect(drawerButtonLabel('Open sidebar', '3', phrases)).toBe('Open sidebar, 3 need your attention');
    expect(drawerButtonLabel('Open sidebar', '', phrases)).toBe('Open sidebar');
  });
});

describe('the composer hint', () => {
  it('counts CJK and emoji as full width, the rest as narrow', () => {
    expect(textEm('Sage')).toBeCloseTo(2.24, 2);
    expect(textEm('仙人掌')).toBe(3);
    expect(textEm('🌱')).toBe(1);
  });

  it('keeps "Message {name}" only when it fits beside Stop and Send', () => {
    // 402pt-wide phone, 17pt text (Dynamic Type default)
    expect(hintFits('Message Sprouty', 402, 17)).toBe(true);
    expect(hintFits('给 Sprouty 发消息', 402, 17)).toBe(true);
    // wrapped on the simulator while a run showed Stop (2026-10-08)
    expect(hintFits('Message 仙人掌·每周简报主笔', 402, 17)).toBe(false);
    expect(hintFits('给 仙人掌·每周简报主笔 发消息', 402, 17)).toBe(false);
    expect(hintFits('Message Research Assistant', 402, 17)).toBe(false);
    // larger text or a narrower phone leaves less room
    expect(hintFits('Message Sprouty', 402, 17 * 1.6)).toBe(false);
    expect(hintFits('给 Sprouty 发消息', 375, 17)).toBe(true);
  });

  it('holds the group hints to one line too', () => {
    expect(hintFits('Message — @ to mention', 402, 17)).toBe(false); // wrapped beside Stop (2026-10-08)
    expect(hintFits('Message or @ a Bot', 402, 17)).toBe(true);
    expect(hintFits('发消息，用 @ 点名', 402, 17)).toBe(true);
    // a 375pt phone has less room: the English group hint falls back to plain "Message"
    expect(hintFits('Message or @ a Bot', 375, 17)).toBe(false);
    expect(hintFits('发消息，用 @ 点名', 375, 17)).toBe(true);
  });
});
