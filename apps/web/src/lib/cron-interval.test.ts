import { describe, expect, it } from 'vitest';
import { cronFiresTooOften } from './cron-interval';

describe('cronFiresTooOften', () => {
  it('flags minute fields that fire closer than 15 minutes', () => {
    expect(cronFiresTooOften('* * * * *')).toBe(true);
    expect(cronFiresTooOften('*/5 * * * *')).toBe(true);
    expect(cronFiresTooOften('*/10 9 * * 1-5')).toBe(true);
    expect(cronFiresTooOften('0,10 * * * *')).toBe(true);
    expect(cronFiresTooOften('0-3 9 * * *')).toBe(true);
  });

  it('accepts the 15-minute floor and anything slower', () => {
    expect(cronFiresTooOften('*/15 * * * *')).toBe(false);
    expect(cronFiresTooOften('0,30 * * * *')).toBe(false);
    expect(cronFiresTooOften('0 * * * *')).toBe(false);
    expect(cronFiresTooOften('0 9 * * 1-5')).toBe(false);
  });

  it('only counts the wrap into the next hour when every hour fires', () => {
    expect(cronFiresTooOften('5,55 * * * *')).toBe(true);
    expect(cronFiresTooOften('5,55 9 * * *')).toBe(false);
  });

  it('leaves shapes it does not understand to the server', () => {
    expect(cronFiresTooOften('not a cron')).toBe(false);
    expect(cronFiresTooOften('1-59/2 * * * *')).toBe(false);
  });
});
