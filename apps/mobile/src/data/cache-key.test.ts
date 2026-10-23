import { describe, expect, it } from 'vitest';
import { cacheFileName, cacheFilePrefix } from './cache-key';

describe('offline copy names', () => {
  it('keeps station, member and kind apart and file-name safe', () => {
    expect(cacheFileName('st-home', 'usr_1', 'notifications')).toBe('st-home__usr_1__notifications.json');
    expect(cacheFileName('st/../x', 'a b', 'k:1')).toBe('st_.._x__a_b__k_1.json');
    expect(cacheFileName('st-home', 'usr_1', 'x').startsWith(cacheFilePrefix('st-home', 'usr_1'))).toBe(true);
    expect(cacheFileName('st-home', 'usr_1', 'x').startsWith(cacheFilePrefix('st-home'))).toBe(true);
    expect(cacheFileName('st-home2', 'usr_1', 'x').startsWith(cacheFilePrefix('st-home'))).toBe(false);
  });
});
