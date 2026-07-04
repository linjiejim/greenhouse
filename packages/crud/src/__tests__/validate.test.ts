/** Unit tests — fail-loud list-param validation. */

import { describe, it, expect } from 'vitest';
import { validateListParams } from '../server/validate.js';

const contract = {
  filterable: {
    name: { type: 'text' as const, methods: ['like' as const] },
    status: { type: 'text' as const, methods: ['eq' as const, 'in' as const] },
    priority: { type: 'number' as const },
  },
  sortable: ['name', 'created_at'],
  defaultSort: { key: 'created_at', order: 'desc' as const },
  maxLimit: 100,
  defaultLimit: 20,
};

describe('validateListParams', () => {
  it('accepts a valid request and clamps the limit', () => {
    const r = validateListParams({ limit: 500, filter: [{ key: 'name', method: 'like', value: ['a'] }] }, contract);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.limit).toBe(100); // clamped to maxLimit
      expect(r.params.skip).toBe(0);
    }
  });

  it('applies the default sort when none given', () => {
    const r = validateListParams({}, contract);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.sort).toEqual([{ key: 'created_at', order: 'desc' }]);
  });

  it('rejects an unknown filter key (no silent drop)', () => {
    const r = validateListParams({ filter: [{ key: 'secret', method: 'eq', value: [1] }] }, contract);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not filterable/);
  });

  it('rejects a method not allowed for a key', () => {
    const r = validateListParams({ filter: [{ key: 'name', method: 'eq', value: ['a'] }] }, contract);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not allowed/);
  });

  it('rejects in/nin with an empty value array', () => {
    const r = validateListParams({ filter: [{ key: 'status', method: 'in', value: [] }] }, contract);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least one value/);
  });

  it('rejects an unsortable sort key', () => {
    const r = validateListParams({ sort: [{ key: 'priority', order: 'asc' }] }, contract);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not sortable/);
  });

  it('rejects a structurally invalid body', () => {
    const r = validateListParams({ filter: [{ key: '', method: 'nope', value: 'x' }] }, contract);
    expect(r.ok).toBe(false);
  });

  it('coerces a stringy value to the declared number type', () => {
    const r = validateListParams({ filter: [{ key: 'priority', method: 'eq', value: ['3'] }] }, contract);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.filter![0].value).toEqual([3]);
  });

  it('coerces stringy true/false to a boolean type', () => {
    const boolContract = { filterable: { active: { type: 'boolean' as const } }, sortable: [] };
    const r = validateListParams({ filter: [{ key: 'active', method: 'eq', value: ['false'] }] }, boolContract);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.filter![0].value).toEqual([false]);
  });
});
