import { describe, expect, it } from 'vitest';
import { isId } from '@greenhouse/db';
import { recordId } from '../records.js';

describe('record ids', () => {
  it('count up within a millisecond, so records list in the order they were made', () => {
    const ids = Array.from({ length: 500 }, () => recordId());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => isId('record', id))).toBe(true);
  });
});
