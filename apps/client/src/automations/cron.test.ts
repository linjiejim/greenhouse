import { describe, expect, it } from 'vitest';
import {
  buildCron,
  checkSchedule,
  firesTooOften,
  isTimeZone,
  nextRuns,
  parseCron,
  parseCronSpec,
  withFrequency,
  type CronSpec,
  type ScheduleState,
} from './cron';

const spec = (cron: string): CronSpec => {
  const parsed = parseCronSpec(cron);
  if (!parsed.ok) throw new Error(`${cron}: ${parsed.reason}`);
  return parsed.spec;
};
const iso = (runs: number[]) => runs.map((ms) => new Date(ms).toISOString());
// Tuesday 27 October 2026, 10:00 UTC
const NOW = Date.UTC(2026, 9, 27, 10, 0);

describe('presets', () => {
  const base: ScheduleState = { freq: 'daily', time: '09:00', minute: 0, weekdays: [1], monthDay: 1, raw: '' };

  it('build the cron each preset stands for', () => {
    expect(buildCron({ ...base, freq: 'hourly', minute: 15 })).toBe('15 * * * *');
    expect(buildCron({ ...base, freq: 'daily', time: '07:30' })).toBe('30 7 * * *');
    expect(buildCron({ ...base, freq: 'weekdays', time: '18:05' })).toBe('5 18 * * 1-5');
    expect(buildCron({ ...base, freq: 'weekly', weekdays: [5, 1, 1, 3] })).toBe('0 9 * * 1,3,5');
    expect(buildCron({ ...base, freq: 'weekly', weekdays: [] })).toBe('0 9 * * 1');
    expect(buildCron({ ...base, freq: 'monthly', monthDay: 15, time: '08:00' })).toBe('0 8 15 * *');
    expect(buildCron({ ...base, freq: 'custom', raw: '  0  */2 * * *  ' })).toBe('0 */2 * * *');
  });

  it('read a cron back as the preset that writes exactly it', () => {
    expect(parseCron('0 9 * * *')).toMatchObject({ freq: 'daily', time: '09:00' });
    expect(parseCron('30 18 * * 1-5')).toMatchObject({ freq: 'weekdays', time: '18:30' });
    expect(parseCron('0 9 * * 1,3,5')).toMatchObject({ freq: 'weekly', weekdays: [1, 3, 5] });
    expect(parseCron('0 9 * * 0')).toMatchObject({ freq: 'weekly', weekdays: [0] });
    expect(parseCron('15 * * * *')).toMatchObject({ freq: 'hourly', minute: 15 });
    expect(parseCron('0 8 15 * *')).toMatchObject({ freq: 'monthly', monthDay: 15, time: '08:00' });
  });

  it('keep every other shape as a custom expression, unchanged', () => {
    for (const cron of ['0 9 * * 5,1', '0 9 * * 7', '00 9 * * *', '0 */2 * * *', '0 9 1 * 1', '0 9 * 1 *', 'nonsense'])
      expect(parseCron(cron)).toMatchObject({ freq: 'custom', raw: cron });
  });

  it('round-trip: whatever a preset reads back as, it builds again', () => {
    for (const cron of ['0 9 * * *', '5 18 * * 1-5', '0 9 * * 1,3,5', '45 * * * *', '0 8 31 * *'])
      expect(buildCron(parseCron(cron))).toBe(cron);
  });

  it('switching to custom starts from the expression shown', () => {
    const weekly = parseCron('0 9 * * 1,3');
    expect(withFrequency(weekly, 'custom')).toMatchObject({ freq: 'custom', raw: '0 9 * * 1,3' });
    expect(withFrequency(weekly, 'daily')).toMatchObject({ freq: 'daily', time: '09:00' });
  });
});

describe('parseCronSpec', () => {
  it('reads lists, ranges, steps and names', () => {
    const s = spec('*/20 8-10 1,15 JAN-MAR MON-FRI');
    expect(s.minutes).toEqual([0, 20, 40]);
    expect(s.hours).toEqual([8, 9, 10]);
    expect([...s.days]).toEqual([1, 15]);
    expect([...s.months]).toEqual([1, 2, 3]);
    expect([...s.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect(spec('5/15 * * * *').minutes).toEqual([5, 20, 35, 50]);
    expect([...spec('0 0 * * 7').weekdays]).toEqual([0]);
  });

  it('calls a broken expression invalid', () => {
    for (const cron of ['61 * * * *', '* 24 * * *', 'a b c d e', '* * *', '5-1 * * * *', '*/0 * * * *', '1,,2 * * * *'])
      expect(parseCronSpec(cron), cron).toEqual({ ok: false, reason: 'invalid' });
    expect(parseCronSpec('  ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('leaves what the station reads but this cannot preview as unsupported', () => {
    for (const cron of ['0 0 L * *', '0 0 * * 5#2', '0 0 15W * *', '0 0 9 * * *'])
      expect(parseCronSpec(cron), cron).toEqual({ ok: false, reason: 'unsupported' });
  });
});

describe('nextRuns', () => {
  it('fires in the automation’s own zone', () => {
    // 18:00 in Shanghai: the next 09:00 is tomorrow morning, 01:00 UTC
    expect(iso(nextRuns(spec('0 9 * * *'), 'Asia/Shanghai', NOW, 3))).toEqual([
      '2026-10-28T01:00:00.000Z',
      '2026-10-29T01:00:00.000Z',
      '2026-10-30T01:00:00.000Z',
    ]);
  });

  it('skips the weekend for weekdays', () => {
    const friday = Date.UTC(2026, 9, 30, 10, 0);
    expect(iso(nextRuns(spec('0 9 * * 1-5'), 'UTC', friday, 2))).toEqual([
      '2026-11-02T09:00:00.000Z',
      '2026-11-03T09:00:00.000Z',
    ]);
  });

  it('includes a time later today and excludes the current minute', () => {
    expect(iso(nextRuns(spec('0 10,11 * * *'), 'UTC', NOW, 2))).toEqual([
      '2026-10-27T11:00:00.000Z',
      '2026-10-28T10:00:00.000Z',
    ]);
  });

  it('matches day of month OR day of week when both are set, as croner does', () => {
    expect(iso(nextRuns(spec('0 9 1 * 1'), 'UTC', NOW, 3))).toEqual([
      '2026-11-01T09:00:00.000Z',
      '2026-11-02T09:00:00.000Z',
      '2026-11-09T09:00:00.000Z',
    ]);
  });

  it('only fires on months that have the day', () => {
    expect(iso(nextRuns(spec('0 8 31 * *'), 'UTC', NOW, 3))).toEqual([
      '2026-10-31T08:00:00.000Z',
      '2026-12-31T08:00:00.000Z',
      '2027-01-31T08:00:00.000Z',
    ]);
    expect(nextRuns(spec('0 0 30 2 *'), 'UTC', NOW, 3)).toEqual([]);
  });

  it('crosses daylight saving: the repeated hour once, the skipped hour never', () => {
    const fallBack = Date.UTC(2026, 9, 31, 12, 0);
    expect(iso(nextRuns(spec('30 1 * * *'), 'America/New_York', fallBack, 2))).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ]);
    const springForward = Date.UTC(2026, 2, 7, 12, 0);
    expect(iso(nextRuns(spec('30 2 * * *'), 'America/New_York', springForward, 1))).toEqual([
      '2026-03-09T06:30:00.000Z',
    ]);
  });
});

describe('checkSchedule', () => {
  it('previews the next three runs', () => {
    const check = checkSchedule('0 9 * * *', 'UTC', NOW);
    expect(check.ok && check.runs && iso(check.runs)).toEqual([
      '2026-10-28T09:00:00.000Z',
      '2026-10-29T09:00:00.000Z',
      '2026-10-30T09:00:00.000Z',
    ]);
  });

  it('holds the station’s 15-minute floor', () => {
    expect(checkSchedule('*/10 9 * * *', 'UTC', NOW)).toEqual({ ok: false, error: 'cronTooOften' });
    expect(checkSchedule('0,10 9 * * *', 'UTC', NOW)).toEqual({ ok: false, error: 'cronTooOften' });
    expect(checkSchedule('* * * * *', 'UTC', NOW)).toEqual({ ok: false, error: 'cronTooOften' });
    expect(checkSchedule('*/15 * * * *', 'UTC', NOW).ok).toBe(true);
    expect(firesTooOften([0, 14 * 60_000])).toBe(true);
    expect(firesTooOften([0, 15 * 60_000])).toBe(false);
  });

  it('names what is wrong', () => {
    expect(checkSchedule('', 'UTC', NOW)).toEqual({ ok: false, error: 'cronEmpty' });
    expect(checkSchedule('every day', 'UTC', NOW)).toEqual({ ok: false, error: 'cronInvalid' });
    expect(checkSchedule('0 0 30 2 *', 'UTC', NOW)).toEqual({ ok: false, error: 'cronNever' });
    expect(checkSchedule('0 9 * * *', 'Mars/Olympus', NOW)).toEqual({ ok: false, error: 'timezoneInvalid' });
  });

  it('lets the station judge what it cannot preview', () => {
    expect(checkSchedule('0 0 L * *', 'UTC', NOW)).toEqual({ ok: true, runs: null, unsupported: true });
  });

  it('knows a time zone', () => {
    expect(isTimeZone('Asia/Taipei')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Nowhere/Land')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });
});
