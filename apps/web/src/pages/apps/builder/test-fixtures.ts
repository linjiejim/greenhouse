/**
 * Shared fixtures for the builder's tests: a Base with a "Requests" table
 * (text, number, status, approver, approved-at, reason, attachment, date,
 * a formula) and an empty "Notes" table with one text field, plus a starter
 * spec. Test-only (like `pages/tables/views/view-test-fixtures.tsx`).
 */

import type { AppSpec } from '@greenhouse/types/apps';
import type { TableDefinition, TableField } from '../../../lib/api/tables';
import type { BuilderSchema } from './spec-model';

const stamp = '2026-10-11T00:00:00.000Z';

export function tableFixture(id: number, name: string): TableDefinition {
  return {
    id,
    base_id: 3,
    name,
    description: null,
    position: id,
    schema_revision: 1,
    created_by: 'owner',
    created_at: stamp,
    updated_at: stamp,
    archived_at: null,
  };
}

export function fieldFixture(
  id: number,
  tableId: number,
  name: string,
  type: TableField['type'],
  config: unknown = {},
  isPrimary = false,
): TableField {
  return {
    id,
    table_id: tableId,
    name,
    type,
    required: false,
    is_primary: isPrimary,
    config: JSON.stringify(config),
    position: id,
    created_by: 'owner',
    created_at: stamp,
    updated_at: stamp,
    archived_at: null,
  };
}

export const REQUESTS = 7;
export const NOTES = 8;

export const FIELDS = {
  item: fieldFixture(1, REQUESTS, 'Item', 'text', {}, true),
  amount: fieldFixture(2, REQUESTS, 'Amount', 'number'),
  status: fieldFixture(3, REQUESTS, 'Status', 'single_select', {
    options: [
      { id: 'pending', label: 'Pending' },
      { id: 'approved', label: 'Approved' },
    ],
  }),
  approver: fieldFixture(4, REQUESTS, 'Approver', 'user'),
  approvedAt: fieldFixture(5, REQUESTS, 'Approved at', 'datetime'),
  reason: fieldFixture(6, REQUESTS, 'Reason', 'long_text'),
  quote: fieldFixture(7, REQUESTS, 'Quote', 'attachment'),
  needed: fieldFixture(8, REQUESTS, 'Needed by', 'date'),
  total: fieldFixture(9, REQUESTS, 'Total', 'formula', {
    formula: { resultType: 'number', expression: { type: 'field', fieldId: 2 } },
  }),
  note: fieldFixture(20, NOTES, 'Note', 'text', {}, true),
} as const;

export function schemaFixture(overrides: Partial<BuilderSchema> = {}): BuilderSchema {
  return {
    baseId: 3,
    tables: [tableFixture(REQUESTS, 'Requests'), tableFixture(NOTES, 'Notes')],
    fieldsByTable: new Map([
      [REQUESTS, Object.values(FIELDS).filter((field) => field.table_id === REQUESTS)],
      [NOTES, [FIELDS.note]],
    ]),
    buttonRules: [{ id: 41, tableId: REQUESTS, name: 'Notify the requester', enabled: true }],
    ...overrides,
  };
}

/** Two pages (Apply, Approve), two roles (applicant sees Apply; approver sees both). */
export function specFixture(): AppSpec {
  return {
    version: 1,
    pages: [
      {
        id: 'apply',
        title: 'Apply',
        cards: [
          {
            id: 'mine',
            kind: 'records',
            title: 'My requests',
            layout: { x: 0, y: 0, w: 12, h: 6 },
            source: { tableId: REQUESTS },
            fieldIds: [1, 2, 3],
          },
        ],
      },
      {
        id: 'approve',
        title: 'Approve',
        cards: [
          {
            id: 'queue',
            kind: 'records',
            layout: { x: 0, y: 0, w: 12, h: 6 },
            source: { tableId: REQUESTS },
            fieldIds: [1, 3],
            actions: [
              {
                id: 'approve',
                label: 'Approve',
                roles: ['approver'],
                do: { type: 'set_fields', values: [{ fieldId: 3, value: 'approved' }] },
              },
            ],
          },
        ],
      },
    ],
    roles: [
      { key: 'applicant', name: 'Applicant', pages: ['apply'], tables: [] },
      {
        key: 'approver',
        name: 'Approver',
        pages: 'all',
        tables: [{ tableId: REQUESTS, access: 'edit', fields: [], fieldDefault: 'visible' }],
      },
    ],
  };
}
