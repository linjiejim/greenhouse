import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_PREFS } from '@greenhouse/types/push';

import { mobilePushEnabled, mobilePushHealthView } from './config.js';
import { parsePushEnvelope, PUSH_DEFAULT_TTL_MS, pushPolicy, pushUrl, type PushEnvelope } from './policy.js';

const NOW = Date.parse('2026-10-10T08:00:00.000Z');
const CREATED = '2026-10-10T07:59:30.000Z';

const card = (over: Partial<PushEnvelope> = {}): PushEnvelope => ({
  k: 'needs_you',
  sid: 'bots-dm-1',
  open: 'bots',
  rid: 'brq_1',
  request_kind: 'approval',
  expires_at: '2026-10-10T08:01:20.000Z',
  bot_id: 'bot_0123456789abcdef',
  ...over,
});

describe('pushPolicy', () => {
  it('pushes a card until its own deadline, time-sensitive for approve / sign in / take over', () => {
    for (const kind of ['approval', 'login', 'takeover'] as const) {
      expect(
        pushPolicy({ envelope: card({ request_kind: kind }), prefs: DEFAULT_PUSH_PREFS, createdAt: CREATED, now: NOW }),
      ).toEqual({
        push: true,
        silent: false,
        expiresAt: Date.parse('2026-10-10T08:01:20.000Z'),
        interruptionLevel: 'time-sensitive',
        threadId: 'bots:bots-dm-1',
      });
    }
    // a proposal waits without breaking through Focus; with no deadline it lives a day
    expect(
      pushPolicy({
        envelope: card({ request_kind: 'bot_create', expires_at: null }),
        prefs: DEFAULT_PUSH_PREFS,
        createdAt: CREATED,
        now: NOW,
      }),
    ).toMatchObject({ push: true, interruptionLevel: 'active', expiresAt: Date.parse(CREATED) + PUSH_DEFAULT_TTL_MS });
  });

  it('never pushes a card that expired before it could be sent (a phone back online too late)', () => {
    expect(
      pushPolicy({
        envelope: card({ expires_at: '2026-10-10T07:59:59.000Z' }),
        prefs: DEFAULT_PUSH_PREFS,
        createdAt: CREATED,
        now: NOW,
      }),
    ).toEqual({ push: false, reason: 'expired' });
  });

  it('keeps instruction proposals in the inbox only', () => {
    expect(
      pushPolicy({
        envelope: card({ request_kind: 'instructions_update' }),
        prefs: DEFAULT_PUSH_PREFS,
        createdAt: CREATED,
        now: NOW,
      }),
    ).toEqual({ push: false, reason: 'muted' });
  });

  it('follows the device switch of each kind', () => {
    const reply: PushEnvelope = { k: 'replies', sid: 'bots-dm-1', open: 'bots', message_id: 'msg-1' };
    const done: PushEnvelope = { k: 'done', sid: 'session-1', open: 'chat', ok: true };
    expect(
      pushPolicy({
        envelope: card(),
        prefs: { ...DEFAULT_PUSH_PREFS, needs_you: false },
        createdAt: CREATED,
        now: NOW,
      }),
    ).toEqual({ push: false, reason: 'category_off' });
    expect(
      pushPolicy({ envelope: reply, prefs: { ...DEFAULT_PUSH_PREFS, replies: false }, createdAt: CREATED, now: NOW }),
    ).toEqual({
      push: false,
      reason: 'category_off',
    });
    expect(
      pushPolicy({ envelope: done, prefs: { ...DEFAULT_PUSH_PREFS, done: false }, createdAt: CREATED, now: NOW }),
    ).toEqual({
      push: false,
      reason: 'category_off',
    });
    // the preview switch never decides whether to push
    expect(
      pushPolicy({ envelope: done, prefs: { ...DEFAULT_PUSH_PREFS, preview: true }, createdAt: CREATED, now: NOW }),
    ).toMatchObject({
      push: true,
      threadId: 'chat:session-1',
    });
  });

  it('wakes a phone that shows a Bot task as a Live Activity, silently when its "done" pushes are off', () => {
    const task: PushEnvelope = { k: 'done', sid: 'bots-dm-1', open: 'bots', bot_id: 'bot_1', ok: true };
    const scheduled: PushEnvelope = { k: 'done', sid: 'session-1', open: 'chat', ok: true };
    const liveActivity = { ...DEFAULT_PUSH_PREFS, live_activity: true };
    // "done" on: the ordinary banner (the delivery adds content-available)
    expect(pushPolicy({ envelope: task, prefs: liveActivity, createdAt: CREATED, now: NOW })).toMatchObject({
      push: true,
      silent: false,
    });
    // "done" off: a silent push, only for a Bot task — a scheduled task has no Live Activity
    expect(
      pushPolicy({ envelope: task, prefs: { ...liveActivity, done: false }, createdAt: CREATED, now: NOW }),
    ).toMatchObject({ push: true, silent: true, expiresAt: Date.parse(CREATED) + PUSH_DEFAULT_TTL_MS });
    expect(
      pushPolicy({ envelope: scheduled, prefs: { ...liveActivity, done: false }, createdAt: CREATED, now: NOW }),
    ).toEqual({ push: false, reason: 'category_off' });
    // no Live Activity on the device: "done" off means nothing at all
    expect(
      pushPolicy({ envelope: task, prefs: { ...DEFAULT_PUSH_PREFS, done: false }, createdAt: CREATED, now: NOW }),
    ).toEqual({ push: false, reason: 'category_off' });
  });

  it('collapses the replies of one conversation into one banner and lets them go stale after a day', () => {
    const reply: PushEnvelope = { k: 'replies', sid: 'bots-dm-1', open: 'bots', message_id: 'msg-1' };
    expect(pushPolicy({ envelope: reply, prefs: DEFAULT_PUSH_PREFS, createdAt: CREATED, now: NOW })).toEqual({
      push: true,
      silent: false,
      expiresAt: Date.parse(CREATED) + PUSH_DEFAULT_TTL_MS,
      interruptionLevel: 'active',
      threadId: 'bots:bots-dm-1',
      collapseId: 'bots-reply:bots-dm-1',
    });
    expect(
      pushPolicy({ envelope: reply, prefs: DEFAULT_PUSH_PREFS, createdAt: CREATED, now: NOW + PUSH_DEFAULT_TTL_MS }),
    ).toEqual({ push: false, reason: 'expired' });
  });
});

describe('push envelope', () => {
  it('round-trips what producers store and rejects what is not one', () => {
    expect(parsePushEnvelope(card())).toEqual(card());
    expect(parsePushEnvelope({ k: 'replies', sid: 's', open: 'bots', message_id: 'm', bot_id: null })).toEqual({
      k: 'replies',
      sid: 's',
      open: 'bots',
      message_id: 'm',
    });
    expect(parsePushEnvelope(null)).toBeNull();
    expect(parsePushEnvelope({ k: 'gossip', sid: 's', open: 'bots' })).toBeNull();
    expect(parsePushEnvelope({ k: 'needs_you', sid: 's', open: 'bots' })).toBeNull(); // no card
    expect(parsePushEnvelope({ k: 'replies', sid: 's', open: 'bots' })).toBeNull(); // no reply
    expect(parsePushEnvelope({ k: 'done', sid: 's', open: 'web' })).toBeNull();
  });

  it('routes a tap to the app’s existing deep links', () => {
    expect(pushUrl(card())).toBe('/bots?c=bots-dm-1&request=brq_1');
    expect(pushUrl({ k: 'replies', sid: 'bots-dm-1', open: 'bots', message_id: 'm' })).toBe('/bots?c=bots-dm-1');
    expect(pushUrl({ k: 'done', sid: 'session 1', open: 'chat' })).toBe('/chat/session%201');
  });
});

describe('MOBILE_PUSH_ENABLED', () => {
  it('is on by default, off on a recognised "off", and off — reported — on anything else', () => {
    expect(mobilePushEnabled({})).toBe(true);
    expect(mobilePushEnabled({ MOBILE_PUSH_ENABLED: 'true' })).toBe(true);
    expect(mobilePushEnabled({ MOBILE_PUSH_ENABLED: '0' })).toBe(false);
    expect(mobilePushHealthView({ MOBILE_PUSH_ENABLED: 'off' })).toEqual({ enabled: false });
    expect(mobilePushHealthView({ MOBILE_PUSH_ENABLED: 'maybe' })).toEqual({
      enabled: false,
      invalid_env: 'MOBILE_PUSH_ENABLED',
    });
  });
});
