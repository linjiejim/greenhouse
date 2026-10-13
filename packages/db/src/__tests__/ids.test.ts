import { describe, expect, it } from 'vitest';
import { isId, newId, ulid } from '../ids.js';

describe('ids', () => {
  it('encodes time first so ids sort by creation', () => {
    const a = ulid(1_700_000_000_000, new Uint8Array(10).fill(255));
    const b = ulid(1_700_000_000_001, new Uint8Array(10));
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });

  it('matches the reference encoding', () => {
    expect(ulid(0, new Uint8Array(10))).toBe('00000000000000000000000000');
    expect(ulid(2 ** 48 - 1, new Uint8Array(10).fill(255))).toBe('7ZZZZZZZZZZZZZZZZZZZZZZZZZ');
  });

  it('prefixes by kind and validates shape', () => {
    const id = newId('agent');
    expect(id).toMatch(/^agt_[0-9A-Z]{26}$/);
    expect(isId('agent', id)).toBe(true);
    expect(isId('member', id)).toBe(false);
    expect(isId('agent', 'agt_not-a-ulid')).toBe(false);
  });

  it('rejects impossible inputs', () => {
    expect(() => ulid(-1)).toThrow();
    expect(() => ulid(Date.now(), new Uint8Array(4))).toThrow();
  });
});
