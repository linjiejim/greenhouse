import { describe, expect, it } from 'vitest';
import type { TableField } from '../../lib/api/tables';
import {
  completedFilterGroup,
  emptyClause,
  filterOperatorsFor,
  filterValueKind,
  isClauseComplete,
  withOperator,
} from './filter-model';

function field(id: number, type: TableField['type'], config: object = {}): TableField {
  return {
    id,
    table_id: 1,
    name: `F${id}`,
    type,
    required: false,
    is_primary: false,
    config: JSON.stringify(config),
    position: id,
    created_by: 'u1',
    created_at: '2026-10-11T00:00:00.000Z',
    updated_at: '2026-10-11T00:00:00.000Z',
    archived_at: null,
  };
}

const text = field(1, 'text');
const status = field(2, 'single_select', { options: [{ id: 'open', label: 'Open' }] });
const owner = field(3, 'user');
const due = field(4, 'date');
const score = field(5, 'formula', { formula: { resultType: 'number', expression: { type: 'literal', value: 1 } } });
const names = field(6, 'lookup', { lookup: { relationFieldId: 9, targetFieldId: 10 } });
const fields = [text, status, owner, due, score, names];

describe('filter model', () => {
  it('offers the operators the server compiler accepts for each value type', () => {
    expect(filterOperatorsFor({ kind: 'field', field: text })).toContain('contains');
    expect(filterOperatorsFor({ kind: 'field', field: status })).toContain('in');
    expect(filterOperatorsFor({ kind: 'field', field: score })).toContain('gte');
    expect(filterOperatorsFor({ kind: 'field', field: names })).toEqual(['contains', 'is_empty', 'is_not_empty']);
    expect(filterOperatorsFor({ kind: 'system', systemField: 'created_by' })).toEqual(['eq', 'neq', 'in']);
    expect(filterOperatorsFor({ kind: 'system', systemField: 'created_at' })).not.toContain('is_empty');
  });

  it('picks a value control per target and operator', () => {
    expect(filterValueKind({ kind: 'field', field: owner }, 'eq')).toBe('user');
    expect(filterValueKind({ kind: 'field', field: owner }, 'in')).toBe('users');
    expect(filterValueKind({ kind: 'system', systemField: 'updated_by' }, 'eq')).toBe('user');
    expect(filterValueKind({ kind: 'system', systemField: 'created_at' }, 'gte')).toBe('datetime');
    expect(filterValueKind({ kind: 'field', field: due }, 'is_empty')).toBe('none');
  });

  it('treats parameter tokens as complete values', () => {
    expect(isClauseComplete({ systemField: 'created_by', operator: 'eq', value: '$me' }, fields)).toBe(true);
    expect(isClauseComplete({ fieldId: due.id, operator: 'gte', value: '$today-7d' }, fields)).toBe(true);
    expect(isClauseComplete({ fieldId: status.id, operator: 'in', value: [] }, fields)).toBe(false);
    expect(isClauseComplete({ fieldId: 999, operator: 'eq', value: 'x' }, fields)).toBe(false);
  });

  it('drops a value that no longer fits when the operator changes', () => {
    const target = { kind: 'field' as const, field: status };
    const clause = { ...emptyClause(target), value: 'open' };
    expect(withOperator(clause, target, 'neq').value).toBe('open');
    expect(withOperator(clause, target, 'in').value).toBeUndefined();
  });

  it('reports the first incomplete clause instead of applying a half-built group', () => {
    expect(completedFilterGroup({ combinator: 'and', clauses: [] }, fields)).toEqual({
      group: undefined,
      incompleteIndex: null,
    });
    const result = completedFilterGroup(
      {
        combinator: 'and',
        clauses: [
          { fieldId: text.id, operator: 'contains', value: 'a' },
          { fieldId: owner.id, operator: 'eq' },
        ],
      },
      fields,
    );
    expect(result).toEqual({ group: undefined, incompleteIndex: 1 });
  });
});
