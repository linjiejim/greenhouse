import { describe, expect, it } from 'vitest';
import { readScheduleTime, writeScheduleTime, scheduleFrequencies } from './schedule-time';
describe('native wall-clock schedules', () => {
  it('round-trips every offered repeat pattern and time without changing its wall clock', () => {
    for (const frequency of scheduleFrequencies)
      for (const [hour, minute] of [
        [0, 0],
        [8, 30],
        [23, 59],
      ])
        expect(readScheduleTime(writeScheduleTime(frequency, hour!, minute!))).toEqual({ frequency, hour, minute });
  });
  it('keeps complex expressions opaque rather than interpreting them as daily', () => {
    for (const cron of ['*/15 * * * *', '0 8 1 * *', '0 8 * 1 *', '0 8 * * 1,3,5', '0 8 * * MON', '0 8 * * * *'])
      expect(readScheduleTime(cron)).toBeNull();
  });
  it('rejects invalid hours and minutes and handles Sunday aliases', () => {
    expect(readScheduleTime('60 9 * * *')).toBeNull();
    expect(readScheduleTime('0 24 * * *')).toBeNull();
    expect(readScheduleTime('0 8 * * 7')).toEqual({ frequency: '0', hour: 8, minute: 0 });
    expect(readScheduleTime('0 8 * * 6,0')?.frequency).toBe('weekend');
  });
});
