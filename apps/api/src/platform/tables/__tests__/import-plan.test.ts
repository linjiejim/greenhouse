/**
 * Import mapping rules without a database: what may be mapped, who may create
 * fields or options, and what the preview suggests.
 */

import { describe, expect, it } from 'vitest';
import type { TableFieldRow } from '@greenhouse/db';
import { fullTableAccess, type TableDataScope } from '@greenhouse/types/table-access';
import type { TableFieldType } from '@greenhouse/types/tables';
import { ImportMappingError, planColumns, previewColumns } from '../import-plan.js';

const stamp = '2026-10-11T00:00:00.000Z';

function field(id: number, name: string, type: TableFieldType, extra: Partial<TableFieldRow> = {}): TableFieldRow {
  return {
    id,
    table_id: 1,
    name,
    type,
    required: false,
    is_primary: id === 1,
    config: '{}',
    position: id,
    created_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    archived_at: null,
    ...extra,
  };
}

const fields = [
  field(1, 'Name', 'text', { required: true }),
  field(2, 'Amount', 'number'),
  field(3, 'Files', 'attachment'),
  field(4, 'Total', 'formula'),
  field(5, 'Old', 'text', { archived_at: stamp }),
];

const full = fullTableAccess('u1');
const scoped: TableDataScope = {
  kind: 'scoped',
  userId: 'u2',
  tableId: 1,
  rows: [],
  editRows: [],
  readableFieldIds: [1, 2],
  editableFieldIds: [1],
  canCreate: true,
  canDelete: false,
};

function plan(
  mapping: unknown,
  options: { scope?: typeof full | TableDataScope; canBuild?: boolean; createOptions?: boolean } = {},
) {
  return planColumns({
    mapping,
    width: 3,
    fields,
    scope: options.scope ?? full,
    canBuild: options.canBuild ?? true,
    createOptions: options.createOptions ?? false,
  });
}

function refusal(run: () => unknown): { message: string; forbidden: boolean } {
  try {
    run();
  } catch (error) {
    if (error instanceof ImportMappingError) return { message: error.message, forbidden: error.forbidden };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('planColumns', () => {
  it('maps columns to existing fields and new ones', () => {
    expect(
      plan([
        { column: 0, fieldId: 1 },
        { column: 2, create: { name: ' Region ', type: 'single_select' } },
      ]),
    ).toEqual([
      { column: 0, fieldId: 1 },
      { column: 2, create: { name: 'Region', type: 'single_select' } },
    ]);
  });

  it('refuses malformed and impossible mappings', () => {
    expect(refusal(() => plan([])).message).toBe('Map at least one column to a field');
    expect(refusal(() => plan([{ column: 3, fieldId: 1 }])).message).toMatch(/column the file does not have/);
    expect(
      refusal(() =>
        plan([
          { column: 0, fieldId: 1 },
          { column: 0, fieldId: 2 },
        ]),
      ).message,
    ).toMatch(/mapped twice/);
    expect(
      refusal(() =>
        plan([
          { column: 0, fieldId: 1 },
          { column: 1, fieldId: 1 },
        ]),
      ).message,
    ).toMatch(/mapped twice/);
    expect(refusal(() => plan([{ column: 0, fieldId: 3 }])).message).toBe('"Files" cannot be imported into');
    expect(refusal(() => plan([{ column: 0, fieldId: 4 }])).message).toBe('"Total" cannot be imported into');
    expect(refusal(() => plan([{ column: 0, fieldId: 5 }])).message).toBe('Field 5 is unavailable');
    expect(refusal(() => plan([{ column: 0, create: { name: 'amount', type: 'number' } }])).message).toMatch(
      /already exists/,
    );
    // Archived names stay taken (the unique index covers them).
    expect(refusal(() => plan([{ column: 0, create: { name: 'Old', type: 'text' } }])).message).toMatch(
      /already exists/,
    );
    expect(refusal(() => plan([{ column: 0, create: { name: 'Link', type: 'relation' } }])).message).toMatch(
      /cannot be of type "relation"/,
    );
  });

  it('keeps structure changes for builders and scoped writers inside their editable fields', () => {
    const create = [{ column: 0, create: { name: 'New', type: 'text' } }];
    expect(refusal(() => plan(create, { canBuild: false }))).toEqual({
      message: 'Creating fields needs builder access',
      forbidden: true,
    });
    expect(refusal(() => plan([{ column: 0, fieldId: 1 }], { canBuild: false, createOptions: true }))).toEqual({
      message: 'Adding select options needs builder access',
      forbidden: true,
    });
    // A scoped writer (custom role) is never a builder, and only fills editable fields.
    expect(refusal(() => plan(create, { scope: scoped, canBuild: false })).forbidden).toBe(true);
    expect(refusal(() => plan([{ column: 1, fieldId: 2 }], { scope: scoped, canBuild: false }))).toEqual({
      message: '"Amount" is not editable',
      forbidden: true,
    });
    expect(plan([{ column: 0, fieldId: 1 }], { scope: scoped, canBuild: false })).toEqual([{ column: 0, fieldId: 1 }]);
  });
});

describe('previewColumns', () => {
  const header = ['name', 'Amount', 'Total', 'Region'];
  const rows = [
    ['Ada', '1,200', 'x', 'North'],
    ['Grace', '300', 'y', 'South'],
    ['Linus', '45', 'z', 'North'],
    ['Ken', '7', 'w', 'North'],
  ];

  it('suggests matching fields, otherwise a new field of the inferred type for builders', () => {
    const columns = previewColumns({ header, rows, fields, scope: full, canCreateFields: true });
    expect(columns.map((column) => [column.inferredType, column.suggestion])).toEqual([
      ['text', { fieldId: 1 }],
      ['number', { fieldId: 2 }],
      // "Total" is a formula field: not a target, so a new field — under a free name.
      ['text', { create: { name: 'Total 2', type: 'text' } }],
      ['single_select', { create: { name: 'Region', type: 'single_select' } }],
    ]);
    expect(columns[1]!.samples).toEqual(['1,200', '300', '45', '7']);
  });

  it('suggests nothing a scoped writer could not do', () => {
    const columns = previewColumns({ header, rows, fields, scope: scoped, canCreateFields: false });
    expect(columns.map((column) => column.suggestion)).toEqual([{ fieldId: 1 }, undefined, undefined, undefined]);
  });
});
