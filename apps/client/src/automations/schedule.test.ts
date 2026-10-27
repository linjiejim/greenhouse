import { describe, expect, it } from 'vitest';
import { describeSchedule, zonePlace, type ScheduleWords } from './schedule';

const zh: ScheduleWords = {
  daily: '每天 {time}',
  weekdays: '工作日 {time}',
  weekends: '每周末 {time}',
  weekly: '每周{days} {time}',
  monthly: '每月 {day} 日 {time}',
  hourly: '每小时第 {minute} 分',
  everyHours: '每 {n} 小时',
  dayNames: ['日', '一', '二', '三', '四', '五', '六'],
  listSep: '、',
};

const en: ScheduleWords = {
  daily: 'Every day at {time}',
  weekdays: 'Weekdays at {time}',
  weekends: 'Weekends at {time}',
  weekly: 'Every {days} at {time}',
  monthly: 'Monthly on day {day} at {time}',
  hourly: 'Every hour at :{minute}',
  everyHours: 'Every {n} hours',
  dayNames: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  listSep: ', ',
};

describe('describeSchedule', () => {
  it('words a daily time', () => {
    expect(describeSchedule('0 9 * * *', zh)).toBe('每天 09:00');
    expect(describeSchedule('30 22 * * *', en)).toBe('Every day at 22:30');
  });

  it('words several times a day', () => {
    expect(describeSchedule('0 9,18 * * *', zh)).toBe('每天 09:00、18:00');
  });

  it('words weekdays and weekends', () => {
    expect(describeSchedule('0 9 * * 1-5', zh)).toBe('工作日 09:00');
    expect(describeSchedule('0 9 * * 1,2,3,4,5', en)).toBe('Weekdays at 09:00');
    expect(describeSchedule('0 10 * * 0,6', zh)).toBe('每周末 10:00');
    expect(describeSchedule('0 10 * * 6,7', en)).toBe('Weekends at 10:00');
  });

  it('words chosen weekdays, Monday first', () => {
    expect(describeSchedule('0 9 * * 1', zh)).toBe('每周一 09:00');
    expect(describeSchedule('0 14 * * 1', en)).toBe('Every Mon at 14:00');
    expect(describeSchedule('0 9 * * 0,1,3', zh)).toBe('每周一、三、日 09:00');
    expect(describeSchedule('15 8 * * 5', en)).toBe('Every Fri at 08:15');
  });

  it('treats every day of the week as daily', () => {
    expect(describeSchedule('0 9 * * 0-6', zh)).toBe('每天 09:00');
  });

  it('words a day of the month', () => {
    expect(describeSchedule('0 9 1 * *', zh)).toBe('每月 1 日 09:00');
    expect(describeSchedule('0 22 15 * *', en)).toBe('Monthly on day 15 at 22:00');
  });

  it('words hourly and every N hours', () => {
    expect(describeSchedule('0 * * * *', zh)).toBe('每小时第 00 分');
    expect(describeSchedule('5 * * * *', en)).toBe('Every hour at :05');
    expect(describeSchedule('0 */2 * * *', zh)).toBe('每 2 小时');
  });

  it('falls back to the raw cron for anything else', () => {
    expect(describeSchedule('*/15 * * * *', zh)).toBe('*/15 * * * *');
    expect(describeSchedule('0 9 * 1 *', zh)).toBe('0 9 * 1 *');
    expect(describeSchedule('0 9 1 * 1', zh)).toBe('0 9 1 * 1');
    expect(describeSchedule('0 9 * * MON', zh)).toBe('0 9 * * MON');
    expect(describeSchedule('0 25 * * *', zh)).toBe('0 25 * * *');
    expect(describeSchedule('@daily', zh)).toBe('@daily');
    expect(describeSchedule('  0 9 * * *  ', zh)).toBe('每天 09:00');
  });
});

describe('zonePlace', () => {
  it('names the zone only when it is not the phone\'s', () => {
    expect(zonePlace('America/Los_Angeles', 'Asia/Shanghai')).toBe('Los Angeles');
    expect(zonePlace('Asia/Shanghai', 'Asia/Shanghai')).toBe('');
    expect(zonePlace('UTC', 'Asia/Shanghai')).toBe('UTC');
    expect(zonePlace(undefined, 'Asia/Shanghai')).toBe('');
  });
});
