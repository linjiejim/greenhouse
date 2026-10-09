import { describe, expect, it } from 'vitest';
import { scheduleWords } from './schedule-words';

describe('scheduleWords', () => {
  it('reads the Automations builder shapes', () => {
    expect(scheduleWords('0 9 * * *')).toEqual({ kind: 'daily', time: '09:00' });
    expect(scheduleWords('30 18 * * 1-5')).toEqual({ kind: 'weekdays', time: '18:30' });
    expect(scheduleWords('0 14 * * 1')).toEqual({ kind: 'weekly', days: [1], time: '14:00' });
    expect(scheduleWords('0 8 * * 7,3,0')).toEqual({ kind: 'weekly', days: [0, 3], time: '08:00' });
    expect(scheduleWords('5 7 15 * *')).toEqual({ kind: 'monthly', day: 15, time: '07:05' });
  });

  it('leaves anything else to the cron itself', () => {
    for (const cron of ['*/15 * * * *', '0 9 * 1 *', '0 9 1 * 1', '0 25 * * *', 'every day', '0 9 * * 1-3']) {
      expect(scheduleWords(cron)).toBeNull();
    }
  });
});
