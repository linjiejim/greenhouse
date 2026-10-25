import { describe, expect, it } from 'vitest';
import {
  lastResult,
  myAutomations,
  nextRunLabel,
  parseSavedAutomations,
  runResult,
  runsAsAssistant,
  type Automation,
  type AutomationRun,
  type NextRunWords,
} from './model';

const task = (over: Partial<Automation> = {}): Automation => ({
  id: '1',
  user_id: 'usr_me',
  name: 'Daily digest',
  profile_id: 'sprouty',
  task_prompt: 'Summarise yesterday',
  schedule: '0 9 * * *',
  timezone: 'UTC',
  enabled: true,
  last_run_at: null,
  last_status: null,
  next_run_at: null,
  run_count: 0,
  created_at: '2026-10-01 00:00:00+00',
  updated_at: '2026-10-01 00:00:00+00',
  ...over,
});

const run = (over: Partial<NonNullable<AutomationRun['run']>> | null): AutomationRun => ({
  session_id: 's1',
  title: null,
  created_at: '2026-10-20 09:00:00+00',
  run:
    over === null
      ? null
      : { id: 'run_1', status: 'succeeded', trigger: 'scheduled', error_message: null, started_at: null, ended_at: null, ...over },
});

describe('myAutomations', () => {
  it('keeps only the member’s own', () => {
    const list = [task({ id: '1' }), task({ id: '2', user_id: 'usr_other' }), task({ id: '3' })];
    expect(myAutomations(list, 'usr_me').map((t) => t.id)).toEqual(['1', '3']);
    expect(myAutomations(list, null)).toEqual([]);
  });
});

describe('lastResult', () => {
  it('reads the last status', () => {
    expect(lastResult(task())).toBe('none');
    expect(lastResult(task({ last_run_at: '2026-10-20 09:00:00+00', last_status: 'completed' }))).toBe('ok');
    expect(lastResult(task({ last_run_at: '2026-10-20 09:00:00+00', last_status: 'failed' }))).toBe('failed');
    expect(lastResult(task({ last_run_at: '2026-10-20 09:00:00+00', last_status: 'interrupted' }))).toBe('failed');
    expect(lastResult(task({ last_run_at: '2026-10-20 09:00:00+00', last_status: 'running' }))).toBe('running');
    expect(lastResult(task({ last_run_at: '2026-10-20 09:00:00+00', last_status: null }))).toBe('none');
    expect(lastResult(task({ last_run_at: '2026-10-20 09:00:00+00', last_status: 'missed' }))).toBe('failed');
    expect(lastResult(task({ last_run_at: '2026-10-20 09:00:00+00', last_status: 'pending' }))).toBe('running');
  });
});

describe('runResult', () => {
  it('reads a run', () => {
    expect(runResult(run({}))).toBe('ok');
    expect(runResult(run({ status: 'failed' }))).toBe('failed');
    expect(runResult(run({ status: 'interrupted', outcome_unknown: true }))).toBe('failed');
    expect(runResult(run({ status: 'succeeded', no_update: true }))).toBe('quiet');
    expect(runResult(run({ status: 'running' }))).toBe('running');
    expect(runResult(run({ status: 'claimed' }))).toBe('running');
    expect(runResult(run(null))).toBe('ok');
  });
});

describe('nextRunLabel', () => {
  const words: NextRunWords = {
    justNow: 'just now',
    minutesAgo: '{n} min ago',
    yesterday: 'yesterday {time}',
    monthDay: '{month}月{day}日',
    yearMonthDay: '{year}年{month}月{day}日',
    today: '今天 {time}',
    tomorrow: '明天 {time}',
    later: '{date} {time}',
  };
  const now = Date.parse('2026-10-25T08:00:00Z');

  it('says today, tomorrow or the date', () => {
    expect(nextRunLabel('2026-10-25 09:00:00+00', words, now, 'UTC')).toBe('今天 09:00');
    expect(nextRunLabel('2026-10-26 09:30:00+00', words, now, 'UTC')).toBe('明天 09:30');
    expect(nextRunLabel('2026-10-30 23:00:00+00', words, now, 'UTC')).toBe('10月30日 23:00');
    expect(nextRunLabel('2027-01-02 07:05:00+00', words, now, 'UTC')).toBe('2027年1月2日 07:05');
  });

  it('reads in the given time zone', () => {
    expect(nextRunLabel('2026-10-25 17:00:00+00', words, now, 'Asia/Shanghai')).toBe('明天 01:00');
  });

  it('is empty without a time', () => {
    expect(nextRunLabel(null, words, now, 'UTC')).toBe('');
    expect(nextRunLabel('soon', words, now, 'UTC')).toBe('');
  });
});

describe('runsAsAssistant', () => {
  it('is the assistant unless a custom run profile', () => {
    expect(runsAsAssistant('sprouty')).toBe(true);
    expect(runsAsAssistant('team')).toBe(true);
    expect(runsAsAssistant(null)).toBe(true);
    expect(runsAsAssistant('custom:abc@2')).toBe(false);
  });
});

describe('parseSavedAutomations', () => {
  it('reads a saved list and coerces old numeric ids', () => {
    const saved = [{ ...task(), id: 7 }];
    expect(parseSavedAutomations(saved)?.[0]?.id).toBe('7');
  });

  it('refuses anything else', () => {
    expect(parseSavedAutomations(null)).toBeNull();
    expect(parseSavedAutomations({})).toBeNull();
    expect(parseSavedAutomations([{ id: '1' }])).toBeNull();
  });
});
