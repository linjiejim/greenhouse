import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_PREFS, parsePushData, pushCategoryOf, pushUrl } from '@greenhouse/types/push';

import { mobilePushEnabled, mobilePushHealthView } from './config.js';
import { PUSH_TTL_MS, pushPolicy } from './policy.js';
import { clip, pushLocale, renderPush } from './render.js';

const NOW = Date.parse('2026-10-23T08:00:00.000Z');
const created = new Date(NOW - 60_000).toISOString();

describe('push categories', () => {
  it('maps waiting, finished and everything else; unknown kinds are other', () => {
    expect(pushCategoryOf('runtime_attention')).toBe('needs_you');
    expect(pushCategoryOf('budget_attention')).toBe('needs_you');
    expect(pushCategoryOf('runtime_completed')).toBe('done');
    expect(pushCategoryOf('runtime_failed')).toBe('done');
    expect(pushCategoryOf('system')).toBe('other');
    expect(pushCategoryOf('a_kind_added_later')).toBe('other');
  });
});

describe('pushPolicy', () => {
  it('sends with a day to live; approvals may break through Focus', () => {
    const decision = pushPolicy({ kind: 'runtime_attention', prefs: DEFAULT_PUSH_PREFS, createdAt: created, now: NOW });
    expect(decision).toEqual({
      push: true,
      category: 'needs_you',
      expiresAt: Date.parse(created) + PUSH_TTL_MS,
      interruptionLevel: 'time-sensitive',
      threadId: 'greenhouse:needs_you',
    });
    expect(pushPolicy({ kind: 'system', prefs: DEFAULT_PUSH_PREFS, createdAt: created, now: NOW })).toMatchObject({
      push: true,
      interruptionLevel: 'active',
    });
  });

  it('honours the phone switch and drops old news', () => {
    expect(
      pushPolicy({
        kind: 'runtime_completed',
        prefs: { ...DEFAULT_PUSH_PREFS, done: false },
        createdAt: created,
        now: NOW,
      }),
    ).toEqual({ push: false, reason: 'category_off' });
    expect(
      pushPolicy({
        kind: 'system',
        prefs: DEFAULT_PUSH_PREFS,
        createdAt: new Date(NOW - PUSH_TTL_MS - 1).toISOString(),
        now: NOW,
      }),
    ).toEqual({ push: false, reason: 'expired' });
  });
});

describe('renderPush', () => {
  const base = { productName: 'Acme Hub', subject: 'Weekly digest needs review', preview: false } as const;

  it('says only what kind of thing happened by default', () => {
    expect(renderPush({ ...base, locale: 'zh', category: 'needs_you', kind: 'runtime_attention' })).toEqual({
      title: 'Acme Hub',
      body: '有一项需要你处理',
    });
    expect(renderPush({ ...base, locale: 'en', category: 'done', kind: 'runtime_failed' }).body).toBe(
      'A task needs your review',
    );
    expect(renderPush({ ...base, locale: 'en', category: 'done', kind: 'runtime_completed' }).body).toBe(
      'A task finished',
    );
  });

  it('shows the title with previews on, clipped', () => {
    expect(renderPush({ ...base, preview: true, locale: 'en', category: 'other', kind: 'system' }).body).toBe(
      'Weekly digest needs review',
    );
    expect(clip('a'.repeat(200), 10)).toBe(`${'a'.repeat(9)}…`);
  });

  it('picks the language from the account locale', () => {
    expect(pushLocale('zh')).toBe('zh');
    expect(pushLocale('zh-CN')).toBe('zh');
    expect(pushLocale('en')).toBe('en');
    expect(pushLocale(null)).toBe('en');
  });
});

describe('push data', () => {
  it('round-trips what the worker sends and rejects anything else', () => {
    const data = { v: 1, s: 'st-home', u: 'usr_1', k: 'done', nid: 'ntf_1', url: pushUrl('ntf_1') };
    expect(parsePushData(data)).toEqual(data);
    expect(parsePushData({ ...data, url: 'https://evil.example' })).toBeNull();
    expect(parsePushData({ ...data, k: 'replies' })).toBeNull();
    expect(parsePushData({ ...data, v: 2 })).toBeNull();
  });
});

describe('MOBILE_PUSH_ENABLED', () => {
  it('defaults on and fails closed on an unknown value', () => {
    expect(mobilePushEnabled({})).toBe(true);
    expect(mobilePushEnabled({ MOBILE_PUSH_ENABLED: 'off' })).toBe(false);
    expect(mobilePushHealthView({ MOBILE_PUSH_ENABLED: 'maybe' })).toEqual({
      enabled: false,
      invalid_env: 'MOBILE_PUSH_ENABLED',
    });
  });
});
