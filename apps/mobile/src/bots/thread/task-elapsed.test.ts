/**
 * The task dock's localized running time (./task-elapsed.ts): the seconds and
 * unit steps match the vendored web `elapsed()` exactly, and the spoken form
 * picks whole words. Root vitest, pure fixtures — no React Native.
 */

import { describe, expect, it } from 'vitest';
import type { BotTaskView } from '../../shared/bots';
import { elapsed } from '../vendor/web-helpers';
import { elapsedCompact, elapsedSpoken, taskSeconds, type ElapsedText } from './task-elapsed';

// The English catalog's templates (src/lib/i18n/bots/thread.en.ts). The catalog
// itself isn't imported: src/lib has no stub tsconfig for the root vitest.
const EN: Record<string, string> = {
  'bots.thread.elapsed.s': '{s}s',
  'bots.thread.elapsed.ms': '{m}m {s}s',
  'bots.thread.elapsed.hm': '{h}h {m}m',
  'bots.thread.elapsedA11y.second': '{n} second',
  'bots.thread.elapsedA11y.seconds': '{n} seconds',
  'bots.thread.elapsedA11y.minute': '{n} minute',
  'bots.thread.elapsedA11y.minutes': '{n} minutes',
  'bots.thread.elapsedA11y.hour': '{n} hour',
  'bots.thread.elapsedA11y.hours': '{n} hours',
};

function render(text: ElapsedText): string {
  const raw = EN[text.key];
  if (raw === undefined) throw new Error(`no template for ${text.key}`);
  return raw.replace(/\{(\w+)\}/g, (_m, name: string) => String(text.vars[name]));
}

const spoken = (seconds: number) => elapsedSpoken(seconds).map(render).join(' ');

const START = Date.parse('2026-10-08T09:00:00.000Z');

function task(partial: Partial<BotTaskView> = {}): Pick<BotTaskView, 'created_at' | 'started_at' | 'ended_at'> {
  return { created_at: '2026-10-08T08:59:00.000Z', started_at: '2026-10-08T09:00:00.000Z', ended_at: null, ...partial };
}

describe('taskSeconds', () => {
  it('counts from the start to now while running', () => {
    expect(taskSeconds(task(), START + 151_400)).toBe(151);
  });

  it('counts from creation while still queued, and stops at the end', () => {
    expect(taskSeconds(task({ started_at: null }), START)).toBe(60);
    expect(taskSeconds(task({ ended_at: '2026-10-08T09:00:42.000Z' }), START + 999_000)).toBe(42);
  });

  it('never goes negative, and an unparseable timestamp reads as zero', () => {
    expect(taskSeconds(task(), START - 5_000)).toBe(0);
    expect(taskSeconds(task({ started_at: 'not a date' }), START)).toBe(0);
  });
});

describe('elapsedCompact', () => {
  it('matches the vendored web elapsed() for every step', () => {
    for (const ms of [0, 400, 1_000, 59_400, 59_600, 60_000, 151_000, 3_599_000, 3_600_000, 3_900_000, 90_061_000]) {
      const t = { ...task(), started_at: new Date(START).toISOString() } as BotTaskView;
      expect(render(elapsedCompact(taskSeconds(t, START + ms)))).toBe(elapsed(t, START + ms));
    }
  });

  it('carries the numbers as vars, so each language places its own units', () => {
    expect(elapsedCompact(31)).toEqual({ key: 'bots.thread.elapsed.s', vars: { s: 31 } });
    expect(elapsedCompact(151)).toEqual({ key: 'bots.thread.elapsed.ms', vars: { m: 2, s: 31 } });
    expect(elapsedCompact(3_900)).toEqual({ key: 'bots.thread.elapsed.hm', vars: { h: 1, m: 5 } });
  });
});

describe('elapsedSpoken', () => {
  it('uses whole words with singular and plural', () => {
    expect(spoken(0)).toBe('0 seconds');
    expect(spoken(1)).toBe('1 second');
    expect(spoken(61)).toBe('1 minute 1 second');
    expect(spoken(151)).toBe('2 minutes 31 seconds');
    expect(spoken(3_900)).toBe('1 hour 5 minutes');
    expect(spoken(7_260)).toBe('2 hours 1 minute');
  });

  it('drops a zero second unit', () => {
    expect(spoken(120)).toBe('2 minutes');
    expect(spoken(7_200 + 59)).toBe('2 hours');
  });
});
