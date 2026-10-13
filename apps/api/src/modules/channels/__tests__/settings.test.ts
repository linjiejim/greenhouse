import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS } from '@greenhouse/db';
import { backoffMs } from '../../../jobs.js';
import { prefsOf } from '../devices.js';
import { isRunEnd, pushData, pushDecision, pushMessage, PUSH_TTL_MS } from '../push.js';
import {
  categoryOf,
  DEFAULT_CHANNELS,
  deliveryDelayMs,
  effectiveSettings,
  kindsOf,
  mergeSettings,
} from '../settings.js';

describe('delivery settings', () => {
  it('starts with email off and pushes for what needs the member, replies and runs', () => {
    const settings = effectiveSettings({});
    expect(settings.previews).toBe(false);
    expect(settings.categories.needs_you).toEqual({ email: false, feishu: true, wecom: true, push: true });
    expect(settings.categories.other.push).toBe(false);
    expect(effectiveSettings(null)).toEqual(settings);
  });

  it('merges a change over what was saved and ignores values of the wrong type', () => {
    const saved = mergeSettings({}, { categories: { needs_you: { email: true } } });
    const next = mergeSettings(saved, { categories: { runs: { push: false } }, previews: true });
    expect(next).toEqual({ categories: { needs_you: { email: true }, runs: { push: false } }, previews: true });
    const effective = effectiveSettings(next);
    expect(effective.categories.needs_you.email).toBe(true);
    expect(effective.categories.runs.push).toBe(false);
    expect(effective.categories.replies).toEqual(DEFAULT_CHANNELS.replies);
    expect(effectiveSettings({ categories: { needs_you: { email: 'yes' as never } } }).categories.needs_you.email).toBe(
      false,
    );
    expect(mergeSettings(next, {}).previews).toBe(true);
  });

  it('puts every notification kind in one category', () => {
    expect(categoryOf('request')).toBe('needs_you');
    expect(categoryOf('mention')).toBe('replies');
    expect(categoryOf('run_failed')).toBe('runs');
    expect(categoryOf('budget')).toBe('other');
    const all = (['needs_you', 'replies', 'runs', 'other'] as const).flatMap(kindsOf);
    expect(all.sort()).toEqual([...NOTIFICATION_KINDS].sort());
  });

  it('holds a mention a minute; a reply was already missed for one, so it goes at once', () => {
    expect(deliveryDelayMs('mention')).toBe(60_000);
    expect(deliveryDelayMs('reply')).toBe(0);
    expect(deliveryDelayMs('request')).toBe(0);
  });
});

describe('retries', () => {
  it('back off from 30 seconds, doubling, to every 30 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map((attempt) => backoffMs(attempt) / 1000)).toEqual([
      30, 60, 120, 240, 480, 960, 1800, 1800, 1800,
    ]);
  });
});

describe('push policy', () => {
  const prefs = prefsOf({ prefs: {} });
  const now = Date.parse('2026-10-14T10:00:00Z');

  it('lets a phone narrow, never widen, and ends a run on a Live Activity silently', () => {
    expect(prefs).toEqual({ needs_you: true, done: true, replies: true, preview: true, live_activity: false });
    const base = { category: 'runs' as const, runEnd: true, createdAt: '2026-10-14T09:59:00Z', now };
    expect(pushDecision({ ...base, prefs })).toMatchObject({ send: true, silent: false });
    expect(pushDecision({ ...base, prefs: { ...prefs, done: false } })).toEqual({ send: false, reason: 'device_off' });
    expect(pushDecision({ ...base, prefs: { ...prefs, done: false, live_activity: true } })).toMatchObject({
      send: true,
      silent: true,
    });
    // Other has no switch on the phone.
    expect(pushDecision({ ...base, category: 'other', runEnd: false, prefs })).toMatchObject({ send: true });
  });

  it('never outlives the card, or a day', () => {
    const card = {
      category: 'needs_you' as const,
      prefs,
      runEnd: false,
      requestKind: 'approval',
      createdAt: '2026-10-14T09:00:00Z',
      now,
    };
    expect(pushDecision({ ...card, requestExpiresAt: '2026-10-14T09:30:00Z' })).toEqual({
      send: false,
      reason: 'expired',
    });
    expect(pushDecision({ ...card, requestExpiresAt: '2026-10-14T12:00:00Z' })).toEqual({
      send: true,
      silent: false,
      expiresAt: Date.parse('2026-10-14T12:00:00Z'),
      interruptionLevel: 'time-sensitive',
    });
    expect(pushDecision({ ...card, requestKind: 'question', requestExpiresAt: null })).toMatchObject({
      expiresAt: Date.parse('2026-10-14T09:00:00Z') + PUSH_TTL_MS,
      interruptionLevel: 'active',
    });
    expect(pushDecision({ ...card, createdAt: '2026-10-13T08:00:00Z', requestExpiresAt: null })).toMatchObject({
      send: false,
    });
  });

  it('carries ids only, in the shape the apps parse', () => {
    const notification = {
      id: 'ntf_1',
      kind: 'run_failed' as const,
      targetType: 'conversation',
      targetId: 'cnv_1',
      requestId: null,
      runId: 'run_1',
    };
    expect(isRunEnd(notification)).toBe(true);
    const data = pushData({ notification, category: 'runs', memberId: 'mbr_1', clientRef: 'station-a' });
    expect(data).toEqual({
      v: 1,
      s: 'station-a',
      u: 'mbr_1',
      k: 'done',
      nid: 'ntf_1',
      sid: 'cnv_1',
      url: '/c/cnv_1',
      run: 'run_1',
      st: 'failed',
    });
    const decision = { send: true as const, silent: true, expiresAt: now + 1000, interruptionLevel: 'active' as const };
    const silent = pushMessage({
      device: { token: 'ExponentPushToken[a]', projectId: 'p' },
      decision,
      data,
      text: { title: 'Greeny', body: '…' },
      badge: 2,
      wake: true,
    });
    expect(silent).toEqual({
      to: 'ExponentPushToken[a]',
      projectId: 'p',
      data,
      expiration: Math.floor((now + 1000) / 1000),
      contentAvailable: true,
      priority: 'normal',
    });
    const banner = pushMessage({
      device: { token: 'ExponentPushToken[a]', projectId: 'p' },
      decision: { ...decision, silent: false },
      data,
      text: { title: 'Greeny', body: 'A background run did not finish' },
      badge: 2,
      wake: false,
    });
    expect(banner).toMatchObject({ title: 'Greeny', sound: 'default', badge: 2, priority: 'high' });
    expect(banner).not.toHaveProperty('contentAvailable');
  });
});
