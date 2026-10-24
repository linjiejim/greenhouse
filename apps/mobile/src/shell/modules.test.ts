import { describe, expect, it } from 'vitest';
import { hasTables } from './modules';

describe('Tables in 云盘', () => {
  it('shows only with the feature, or to a super', () => {
    expect(hasTables({ role: 'team', features: { tables: true } })).toBe(true);
    expect(hasTables({ role: 'team', features: {} })).toBe(false);
    expect(hasTables({ role: 'super', features: {} })).toBe(true);
    expect(hasTables(null)).toBe(false);
  });
});
