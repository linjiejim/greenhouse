import { describe, expect, it } from 'vitest';
import { MemoryRateLimitStore, RateLimiter } from '../rate-limit.js';

describe('fixed windows', () => {
  it('shares a namespace, isolates others, resets and expires', async () => {
    const store = new MemoryRateLimitStore();
    const a = new RateLimiter(2, 1000, store, 'a');
    const b = new RateLimiter(2, 1000, store, 'a');
    const other = new RateLimiter(2, 1000, store, 'b');
    expect(await a.hit('person', 10)).toBe(0);
    expect(await b.hit('person', 20)).toBe(0);
    expect(await a.hit('person', 30)).toBe(1);
    expect(await other.hit('person', 30)).toBe(0);
    await b.reset('person');
    expect(await a.hit('person', 40)).toBe(0);
    expect(await b.hit('person', 1040)).toBe(0);
  });
});
