/**
 * The phone hides what the server would refuse (./access.ts): built-in roles
 * by level, a custom role by its compiled per-table view.
 */

import { describe, expect, it } from 'vitest';

import { roleOf, tableAbilities } from './access';
import type { FieldLike } from './fields';

const fields: FieldLike[] = [
  { id: 1, name: 'Title', type: 'text', config: '{}' },
  { id: 2, name: 'Amount', type: 'number', config: '{}' },
  { id: 3, name: 'Total', type: 'formula', config: '{}' },
];

describe('table abilities', () => {
  it('editors and up write every stored field; viewers nothing', () => {
    const editor = tableAbilities({ role: 'editor', access: { level: 'editor' } }, 9, fields);
    expect(editor).toMatchObject({ canCreate: true, canDelete: true });
    expect([...editor.editable]).toEqual([1, 2]);
    expect(tableAbilities({ role: 'viewer', access: { level: 'viewer' } }, 9, fields).editable.size).toBe(0);
    expect(tableAbilities(null, 9, fields).canCreate).toBe(false);
  });

  it('a custom role writes only what its compiled view allows', () => {
    const access = {
      level: 'custom' as const,
      customRole: { id: 4, name: 'Sales' },
      tables: [
        {
          tableId: 9,
          access: 'edit' as const,
          readableFieldIds: [1, 2, 3],
          editableFieldIds: [2, 3],
          canCreate: false,
          canDelete: false,
        },
        {
          tableId: 10,
          access: 'read' as const,
          readableFieldIds: [1],
          editableFieldIds: [],
          canCreate: false,
          canDelete: false,
        },
      ],
    };
    const sales = tableAbilities({ role: 'viewer', access }, 9, fields);
    expect([...sales.editable]).toEqual([2]);
    expect(sales.canCreate).toBe(false);
    expect(tableAbilities({ role: 'viewer', access }, 10, fields).editable.size).toBe(0);
    expect(tableAbilities({ role: 'viewer', access }, 11, fields).editable.size).toBe(0);
    expect(roleOf({ role: 'viewer', access })).toBe('custom');
  });
});
