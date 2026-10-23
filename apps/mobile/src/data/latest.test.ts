import { describe, expect, it } from 'vitest';
import { Latest } from './latest';

describe('only the latest change counts', () => {
  it('lets the newest change apply and silences older ones', () => {
    const latest = new Latest();
    const first = latest.begin();
    expect(first()).toBe(true);
    const second = latest.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
