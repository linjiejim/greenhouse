import { describe, expect, it } from 'vitest';
import { langOf, parseMe } from './me';

describe('the signed-in member', () => {
  it('reads /api/auth/me with defaults for missing optional fields', () => {
    expect(
      parseMe({ user: { id: 'u1', email: 'a@b.c', nickname: 'Ann', role: 'team', locale: 'zh', features: { tables: true } } }),
    ).toEqual({
      id: 'u1',
      email: 'a@b.c',
      nickname: 'Ann',
      role: 'team',
      monthly_token_limit: 0,
      locale: 'zh',
      notes: null,
      features: { tables: true },
    });
    expect(parseMe({ user: { id: 'u1', email: 'a@b.c', nickname: ' ', role: 'super' } })?.nickname).toBe('a@b.c');
  });

  it('refuses what is not a member this app serves', () => {
    expect(parseMe({ user: { id: 'u1', email: 'a@b.c', role: 'external' } })).toBeNull();
    expect(parseMe({ id: 'u1' })).toBeNull();
    expect(parseMe(null)).toBeNull();
  });

  it('maps account locales to the app languages', () => {
    expect(langOf('zh')).toBe('zh');
    expect(langOf('zh-CN')).toBe('zh');
    expect(langOf('en')).toBe('en');
    expect(langOf(undefined)).toBe('en');
  });
});
