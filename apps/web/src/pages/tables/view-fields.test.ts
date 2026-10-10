import { describe, expect, it } from 'vitest';
import type { TableField } from '../../lib/api/tables';
import { orderedViewFields } from './view-fields';

const fields = [1, 2, 3].map(
  (id): TableField => ({
    id,
    table_id: 1,
    name: `F${id}`,
    type: 'text',
    required: false,
    is_primary: id === 1,
    config: '{}',
    position: id,
    created_by: 'u1',
    created_at: '2026-10-11T00:00:00.000Z',
    updated_at: '2026-10-11T00:00:00.000Z',
    archived_at: null,
  }),
);

describe('orderedViewFields', () => {
  it('shows columns in the order the view lists them, not schema order', () => {
    expect(orderedViewFields(fields, [3, 1]).map((field) => field.id)).toEqual([3, 1]);
  });

  it('shows every field when the view lists none, and drops ids that no longer exist', () => {
    expect(orderedViewFields(fields, undefined).map((field) => field.id)).toEqual([1, 2, 3]);
    expect(orderedViewFields(fields, [2, 99]).map((field) => field.id)).toEqual([2]);
  });
});
