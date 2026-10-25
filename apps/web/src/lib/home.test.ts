import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_RECENT, greetingFor, greetingName, homeRecentOf, readHomeRecent, writeHomeRecent } from './home';

describe('greetingFor', () => {
  it('matches the mobile slots: 5–11 morning, 11–13 noon, 13–18 afternoon, 18–23 evening, else night', () => {
    expect([6, 12, 15, 20, 2].map(greetingFor)).toEqual(['morning', 'noon', 'afternoon', 'evening', 'night']);
    expect([5, 11, 13, 18, 23, 0, 4].map(greetingFor)).toEqual([
      'morning',
      'noon',
      'afternoon',
      'evening',
      'night',
      'night',
      'night',
    ]);
    expect([10, 12, 17, 22].map(greetingFor)).toEqual(['morning', 'noon', 'afternoon', 'evening']);
  });
});

describe('greetingName', () => {
  it('uses the first word of the nickname, then the email', () => {
    expect(greetingName({ nickname: ' Jim Lin ' })).toBe('Jim');
    expect(greetingName({ nickname: '林杰' })).toBe('林杰');
    expect(greetingName({ nickname: '', email: 'ann@example.test' })).toBe('ann');
    expect(greetingName(null)).toBe('');
  });
});

describe('home recent count', () => {
  it('accepts only the offered choices', () => {
    expect(homeRecentOf('0')).toBe(0);
    expect(homeRecentOf('10')).toBe(10);
    expect(homeRecentOf('4')).toBeNull();
    expect(homeRecentOf('')).toBeNull();
    expect(homeRecentOf(null)).toBeNull();
  });

  it('round-trips through storage and falls back to the default', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v) };
    expect(readHomeRecent(storage)).toBe(DEFAULT_HOME_RECENT);
    writeHomeRecent(3, storage);
    expect(readHomeRecent(storage)).toBe(3);
    map.set('home-recent-count', 'junk');
    expect(readHomeRecent(storage)).toBe(DEFAULT_HOME_RECENT);
  });
});
