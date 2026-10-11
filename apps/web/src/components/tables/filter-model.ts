/**
 * Pure model behind `FilterEditor`: which operators and value controls a
 * filter target (a field or a system column) offers, the parameter tokens it
 * accepts, and whether a clause is complete.
 *
 * Operator sets mirror the server compiler (`allowedOperators` over the
 * field's value type in `packages/db/src/services/tables`), so the editor never
 * offers a predicate the query would reject.
 */

import {
  TABLE_SYSTEM_FIELDS,
  type TableFieldType,
  type TableFilterClause,
  type TableFilterGroup,
  type TableFilterOperator,
  type TableSystemField,
} from '@greenhouse/types/tables';
import { ME_TOKEN } from '@greenhouse/types/date-tokens';
import type { TableField } from '../../lib/api/tables';
import type { TranslationKey } from '../../lib/i18n';
import { fieldConfig } from './field-types';

export type FilterTarget = { kind: 'field'; field: TableField } | { kind: 'system'; systemField: TableSystemField };

/** How the value of a clause is entered. */
export type FilterValueKind =
  | 'none'
  | 'text'
  | 'number'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'option'
  | 'options'
  | 'user'
  | 'users'
  | 'record';

export const OPERATOR_LABEL_KEYS: Record<TableFilterOperator, TranslationKey> = {
  eq: 'tables.filter.eq',
  neq: 'tables.filter.neq',
  contains: 'tables.filter.contains',
  not_contains: 'tables.filter.notContains',
  gt: 'tables.filter.gt',
  gte: 'tables.filter.gte',
  lt: 'tables.filter.lt',
  lte: 'tables.filter.lte',
  is_empty: 'tables.filter.isEmpty',
  is_not_empty: 'tables.filter.isNotEmpty',
  in: 'tables.filter.in',
};

/** Day tokens offered on date clauses, in menu order (all expand server-side, see `@greenhouse/types/date-tokens`). */
export const DATE_FILTER_TOKENS: ReadonlyArray<{ token: string; labelKey: TranslationKey }> = [
  { token: '$today', labelKey: 'tables.filter.token.today' },
  { token: '$yesterday', labelKey: 'tables.filter.token.yesterday' },
  { token: '$today+1d', labelKey: 'tables.filter.token.tomorrow' },
  { token: '$today-7d', labelKey: 'tables.filter.token.sevenDaysAgo' },
  { token: '$today-30d', labelKey: 'tables.filter.token.thirtyDaysAgo' },
  { token: '$today+7d', labelKey: 'tables.filter.token.inSevenDays' },
  { token: '$week_start', labelKey: 'tables.filter.token.weekStart' },
  { token: '$month_start', labelKey: 'tables.filter.token.monthStart' },
];

/** Datetime clauses additionally accept the current instant. */
export const DATETIME_FILTER_TOKENS: ReadonlyArray<{ token: string; labelKey: TranslationKey }> = [
  { token: '$now', labelKey: 'tables.filter.token.now' },
  ...DATE_FILTER_TOKENS,
];

export const USER_FILTER_TOKEN = { token: ME_TOKEN, labelKey: 'tables.filter.token.me' as TranslationKey };

export function isFilterToken(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('$');
}

/** The type a field filters as: formulas by result type, rollups as number (or text for `join`). */
export function filterValueType(field: Pick<TableField, 'type' | 'config'>): TableFieldType {
  const config = fieldConfig(field);
  if (field.type === 'formula') return config.formula?.resultType ?? 'text';
  if (field.type === 'rollup') return config.rollup?.aggregation === 'join' ? 'text' : 'number';
  return field.type;
}

const COMMON: TableFilterOperator[] = ['eq', 'neq', 'is_empty', 'is_not_empty'];
const COMPARE: TableFilterOperator[] = ['gt', 'gte', 'lt', 'lte'];

export function filterOperatorsFor(target: FilterTarget): TableFilterOperator[] {
  if (target.kind === 'system') {
    return target.systemField === 'created_by' || target.systemField === 'updated_by'
      ? ['eq', 'neq', 'in']
      : ['gte', 'lte', 'gt', 'lt'];
  }
  const type = filterValueType(target.field);
  switch (type) {
    case 'number':
    case 'date':
    case 'datetime':
      return [...COMMON, ...COMPARE];
    case 'text':
    case 'long_text':
    case 'url':
    case 'email':
    case 'phone':
      return [...COMMON, 'contains', 'not_contains', ...COMPARE];
    case 'multi_select':
    case 'multi_user':
    case 'attachment':
      return [...COMMON, 'contains', 'not_contains'];
    case 'single_select':
    case 'user':
      return [...COMMON, 'in'];
    case 'lookup':
      return ['contains', 'is_empty', 'is_not_empty'];
    default:
      return COMMON;
  }
}

export function filterValueKind(target: FilterTarget, operator: TableFilterOperator): FilterValueKind {
  if (operator === 'is_empty' || operator === 'is_not_empty') return 'none';
  if (target.kind === 'system') {
    if (target.systemField === 'created_by' || target.systemField === 'updated_by') {
      return operator === 'in' ? 'users' : 'user';
    }
    return 'datetime';
  }
  const type = filterValueType(target.field);
  switch (type) {
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'boolean':
      return 'boolean';
    case 'single_select':
      return operator === 'in' ? 'options' : 'option';
    case 'multi_select':
      return operator === 'contains' || operator === 'not_contains' ? 'option' : 'options';
    case 'user':
      return operator === 'in' ? 'users' : 'user';
    case 'multi_user':
      return operator === 'contains' || operator === 'not_contains' ? 'user' : 'users';
    case 'relation':
      return 'record';
    default:
      return 'text';
  }
}

export function targetKey(target: FilterTarget): string {
  return target.kind === 'field' ? `f:${target.field.id}` : `s:${target.systemField}`;
}

export function clauseTarget(clause: TableFilterClause, fields: TableField[]): FilterTarget | null {
  if (clause.systemField !== undefined) return { kind: 'system', systemField: clause.systemField };
  const field = fields.find((entry) => entry.id === clause.fieldId);
  return field ? { kind: 'field', field } : null;
}

export function targetFromKey(key: string, fields: TableField[]): FilterTarget | null {
  if (key.startsWith('s:')) {
    const systemField = key.slice(2) as TableSystemField;
    return (TABLE_SYSTEM_FIELDS as readonly string[]).includes(systemField) ? { kind: 'system', systemField } : null;
  }
  const field = fields.find((entry) => `f:${entry.id}` === key);
  return field ? { kind: 'field', field } : null;
}

/** A fresh clause on a target: its first operator, no value. */
export function emptyClause(target: FilterTarget): TableFilterClause {
  const operator = filterOperatorsFor(target)[0]!;
  return target.kind === 'field'
    ? { fieldId: target.field.id, operator }
    : { systemField: target.systemField, operator };
}

/** Keep the target, change the operator; the value survives only if it still fits. */
export function withOperator(
  clause: TableFilterClause,
  target: FilterTarget,
  operator: TableFilterOperator,
): TableFilterClause {
  const sameKind = filterValueKind(target, operator) === filterValueKind(target, clause.operator);
  return { ...clause, operator, value: sameKind ? clause.value : undefined };
}

export function isClauseComplete(clause: TableFilterClause, fields: TableField[]): boolean {
  const target = clauseTarget(clause, fields);
  if (!target) return false;
  const kind = filterValueKind(target, clause.operator);
  if (kind === 'none') return true;
  const value = clause.value;
  if (kind === 'options' || kind === 'users') return Array.isArray(value) && value.length > 0;
  if (kind === 'boolean') return typeof value === 'boolean';
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (kind === 'record') return (typeof value === 'number' && value > 0) || (Array.isArray(value) && value.length > 0);
  return typeof value === 'string' && value.trim() !== '';
}

/** The group to apply (`undefined` = no conditions), or the index of the first clause still missing a value. */
export function completedFilterGroup(
  group: TableFilterGroup | null | undefined,
  fields: TableField[],
): { group: TableFilterGroup | undefined; incompleteIndex: number | null } {
  if (!group || group.clauses.length === 0) return { group: undefined, incompleteIndex: null };
  const incompleteIndex = group.clauses.findIndex((clause) => !isClauseComplete(clause, fields));
  return {
    group: incompleteIndex === -1 ? group : undefined,
    incompleteIndex: incompleteIndex === -1 ? null : incompleteIndex,
  };
}
