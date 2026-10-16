import { describe, expect, it } from 'vitest';
import type { RunView } from '../shared/contract';
import {
  activityArt,
  attributesFor,
  contentFor,
  dismissAt,
  ENDED_LINGER_S,
  parseActivities,
  planActivities,
  pruneShown,
  SHOWN_KEEP_MS,
  STALE_AFTER_S,
  tallyBackgroundEnds,
  type ActivityInfo,
  type PlanContext,
} from './model';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const S = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const parseMs = (iso: string) => Date.parse(iso);

function task(run: string, partial: Partial<RunView> = {}): RunView {
  return {
    id: run,
    agent_id: 'agent_sage',
    title: 'Check the links on the pricing page',
    status: 'running',
    source: 'conversation',
    source_id: null,
    conversation_id: 'conv-1',
    attempt: 1,
    error: null,
    created_at: '2026-10-10T11:56:00.000Z',
    started_at: '2026-10-10T11:56:05.000Z',
    finished_at: null,
    ...partial,
  };
}

function activity(run: string, partial: Partial<ActivityInfo> = {}): ActivityInfo {
  return {
    id: `act-${run}`,
    run,
    station: 'st-home',
    user: 'u1',
    session: 'conv-1',
    art: 'a1',
    status: 'running',
    startedAt: S('2026-10-10T11:56:05.000Z'),
    ended: false,
    ...partial,
  };
}

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  now: NOW,
  station: 'st-home',
  user: 'u1',
  switchOn: true,
  canStart: true,
  complete: true,
  shown: new Set(),
  ...over,
});

describe('contentFor', () => {
  it('times a run from its start (else its creation) and ends it at its end, in whole seconds', () => {
    expect(contentFor(task('r1'), NOW, parseMs)).toEqual({
      status: 'running',
      startedAt: S('2026-10-10T11:56:05.000Z'),
      endedAt: null,
    });
    expect(contentFor(task('r2', { status: 'queued', started_at: null }), NOW, parseMs).startedAt).toBe(
      S('2026-10-10T11:56:00.000Z'),
    );
    expect(
      contentFor(task('r3', { status: 'succeeded', finished_at: '2026-10-10T11:59:17.500Z' }), NOW, parseMs),
    ).toMatchObject({ status: 'succeeded', endedAt: S('2026-10-10T11:59:17.000Z') });
  });

  it('goes stale a minute past the run limit, and leaves the lock screen 15 minutes after the end', () => {
    const state = contentFor(task('r1'), NOW, parseMs);
    expect(state.startedAt + STALE_AFTER_S).toBe(S('2026-10-10T12:17:05.000Z'));
    const ended = S('2026-10-10T11:59:00.000Z');
    expect(dismissAt(ended, NOW)).toBe(ended + ENDED_LINGER_S);
    // ended long ago: off at once
    expect(dismissAt(S('2026-10-10T11:00:00.000Z'), NOW)).toBe(0);
  });
});

describe('attributesFor', () => {
  it('names the Agent, never the run unless the device shows previews', () => {
    const base = {
      run: task('r1'),
      station: 'st-home',
      user: 'u1',
      agent: { name: 'Sage', main: false },
      art: 'a1',
      lang: 'zh' as const,
    };
    expect(attributesFor({ ...base, preview: false })).toEqual({
      v: 1,
      station: 'st-home',
      user: 'u1',
      session: 'conv-1',
      run: 'r1',
      botName: 'Sage',
      sprouty: false,
      art: 'a1',
      lang: 'zh',
      title: null,
    });
    expect(attributesFor({ ...base, preview: true }).title).toBe('Check the links on the pricing page');
    const long = attributesFor({ ...base, run: task('r1', { title: 'x'.repeat(60) }), preview: true });
    expect(Array.from(long.title!)).toHaveLength(40);
    expect(attributesFor({ ...base, agent: null, preview: false }).botName).toBe('Agent');
    // a run without a conversation opens the run itself
    expect(attributesFor({ ...base, run: task('r1', { conversation_id: null }), preview: false }).session).toBe('');
  });
});

describe('planActivities', () => {
  it('starts one activity per running run that the phone has not shown, newest leading the island', () => {
    const actions = planActivities({
      runs: [
        task('r1'),
        task('r2', { started_at: '2026-10-10T11:58:00.000Z' }),
        task('r3', { status: 'succeeded', finished_at: '2026-10-10T11:57:00.000Z' }),
        task('r4'),
      ],
      activities: [],
      ctx: ctx({ shown: new Set(['r4']) }),
      parseMs,
    });
    expect(actions.map((a) => [a.kind, a.kind === 'start' ? a.run.id : a.id])).toEqual([
      ['start', 'r1'],
      ['start', 'r2'],
    ]);
    const second = actions[1]!;
    expect(second).toMatchObject({ relevance: S('2026-10-10T11:58:00.000Z') });
  });

  it('starts nothing without the go-ahead (the switch, the OS, a push registration)', () => {
    expect(planActivities({ runs: [task('r1')], activities: [], ctx: ctx({ canStart: false }), parseMs })).toEqual(
      [],
    );
    // schedules and automations stay off the lock screen
    expect(
      planActivities({ runs: [task('r1', { source: 'schedule' })], activities: [], ctx: ctx(), parseMs }),
    ).toEqual([]);
  });

  it('updates a running activity when the run moved on, and leaves an unchanged one alone', () => {
    const queued = activity('r1', { status: 'queued', startedAt: S('2026-10-10T11:56:00.000Z') });
    expect(planActivities({ runs: [task('r1')], activities: [queued], ctx: ctx(), parseMs })).toEqual([
      {
        kind: 'update',
        id: 'act-r1',
        state: { status: 'running', startedAt: S('2026-10-10T11:56:05.000Z'), endedAt: null },
        staleAt: S('2026-10-10T11:56:05.000Z') + STALE_AFTER_S,
      },
    ]);
    expect(planActivities({ runs: [task('r1')], activities: [activity('r1')], ctx: ctx(), parseMs })).toEqual([]);
  });

  it('ends a finished run with its final state, lingering 15 minutes past its end', () => {
    const done = task('r1', { status: 'failed', finished_at: '2026-10-10T11:59:00.000Z' });
    expect(planActivities({ runs: [done], activities: [activity('r1')], ctx: ctx(), parseMs })).toEqual([
      {
        kind: 'end',
        id: 'act-r1',
        state: {
          status: 'failed',
          startedAt: S('2026-10-10T11:56:05.000Z'),
          endedAt: S('2026-10-10T11:59:00.000Z'),
        },
        dismissAt: S('2026-10-10T11:59:00.000Z') + ENDED_LINGER_S,
      },
    ]);
    // already ended on the phone (the push did it): nothing more
    expect(
      planActivities({ runs: [done], activities: [activity('r1', { ended: true })], ctx: ctx(), parseMs }),
    ).toEqual([]);
  });

  it('ends at once what is no longer this station’s, this account’s, or wanted at all', () => {
    const elsewhere = [
      activity('r1', { station: 'st-work' }),
      activity('r2', { user: 'u2' }),
      activity('r3', { ended: true, station: 'st-work' }),
    ];
    expect(planActivities({ runs: [], activities: elsewhere, ctx: ctx(), parseMs })).toEqual(
      ['act-r1', 'act-r2', 'act-r3'].map((id) => ({ kind: 'end', id, state: null, dismissAt: 0 })),
    );
    expect(
      planActivities({ runs: [task('r1')], activities: [activity('r1')], ctx: ctx({ switchOn: false }), parseMs }),
    ).toEqual([{ kind: 'end', id: 'act-r1', state: null, dismissAt: 0 }]);
    // signed out
    expect(
      planActivities({ runs: null, activities: [activity('r1')], ctx: ctx({ user: null, station: null }), parseMs }),
    ).toEqual([{ kind: 'end', id: 'act-r1', state: null, dismissAt: 0 }]);
  });

  it('ends a run missing from the whole list, but not from a partial one, and waits when nothing could be listed', () => {
    const lost = [activity('r9')];
    expect(planActivities({ runs: [], activities: lost, ctx: ctx(), parseMs })).toEqual([
      { kind: 'end', id: 'act-r9', state: null, dismissAt: 0 },
    ]);
    expect(planActivities({ runs: [], activities: lost, ctx: ctx({ complete: false }), parseMs })).toEqual([]);
    expect(planActivities({ runs: null, activities: lost, ctx: ctx(), parseMs })).toEqual([]);
  });
});

describe('bookkeeping', () => {
  it('reads the native list defensively', () => {
    expect(parseActivities('nope')).toEqual([]);
    expect(parseActivities('[{"id":"a","run":"r","ended":true},{"run":"no id"}]')).toEqual([
      { id: 'a', run: 'r', station: '', user: '', session: '', art: '', status: '', startedAt: 0, ended: true },
    ]);
  });

  it('forgets shown runs after a day', () => {
    expect(pruneShown({ old: NOW - SHOWN_KEEP_MS, fresh: NOW - 1000, bad: 'x' as never }, NOW)).toEqual({
      fresh: NOW - 1000,
    });
  });

  it('counts the background ends for the dogfood', () => {
    const log = JSON.stringify([
      { run: 'r1', outcome: 'ended' },
      { run: 'r2', outcome: 'already_ended' },
      { run: 'r3', outcome: 'not_found' },
    ]);
    expect(tallyBackgroundEnds(log)).toEqual({ total: 3, ended: 2, notFound: 1 });
    expect(tallyBackgroundEnds('garbage')).toEqual({ total: 0, ended: 0, notFound: 0 });
  });

  it('draws one Agent’s faces at the activity’s sizes, keyed by the light face', () => {
    const { art, jobs } = activityArt(null);
    expect(jobs.map((job) => [job.key, job.points])).toEqual([
      [`${art}L`, 52],
      [`${art}D`, 52],
      [`${art}M`, 36],
    ]);
    expect(jobs[1]!.svg).toBe(jobs[2]!.svg);
    expect(jobs[0]!.svg).not.toBe(jobs[1]!.svg);
    expect(art).toMatch(/^a[0-9a-f]{8}[0-9a-z]+$/);
  });
});
