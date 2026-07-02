import { describe, it, expect } from 'vitest';
import { randomDocId } from './id.js';

describe('randomDocId', () => {
  it('produces a `doc-<8 hex>` id by default', () => {
    expect(randomDocId()).toMatch(/^doc-[0-9a-f]{8}$/);
  });

  it('honours a custom prefix', () => {
    expect(randomDocId('kb')).toMatch(/^kb-[0-9a-f]{8}$/);
  });

  it('is unique across calls (no title/locale dependence)', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => randomDocId()));
    expect(ids.size).toBe(1000);
  });
});
