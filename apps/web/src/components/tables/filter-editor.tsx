/**
 * The one condition editor for Tables (`TableFilterGroup`): view filters now;
 * dashboard filters, automation conditions, role row scopes and app bindings
 * reuse it. Targets are fields and the system columns (`created_by`, …);
 * values are typed per target and offer the parameter tokens (`$me`, `$today`,
 * `$today-7d`, …) as ordinary choices — the server expands them at query time.
 *
 * Controlled: it edits the group as-is, incomplete clauses included. Callers
 * check `completedFilterGroup()` before applying.
 */

import { useRef } from 'react';
import {
  TABLE_SYSTEM_FIELDS,
  type TableFilterClause,
  type TableFilterGroup,
  type TableFilterOperator,
  type TableSystemField,
} from '@greenhouse/types/tables';
import { Button, IconButton, Input, Select } from '../ui';
import { Plus, X } from '../../lib/icons';
import type { TableField, TableUserOption } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';
import { SYSTEM_FIELD_LABEL_KEYS } from './field-types';
import {
  clauseTarget,
  emptyClause,
  filterOperatorsFor,
  filterValueKind,
  OPERATOR_LABEL_KEYS,
  targetFromKey,
  targetKey,
  withOperator,
  type FilterTarget,
} from './filter-model';
import { FilterValueInput } from './filter-value-input';

export interface FilterEditorProps {
  value: TableFilterGroup | null | undefined;
  onChange: (next: TableFilterGroup) => void;
  /** Fields the person may filter on (callers pass only readable ones). */
  fields: TableField[];
  users: TableUserOption[];
  /** System columns offered after the fields. Default: all of them; `[]` hides the group. */
  systemFields?: readonly TableSystemField[];
  /** Default 20 (the server's per-group bound). */
  maxClauses?: number;
}

export function FilterEditor({
  value,
  onChange,
  fields,
  users,
  systemFields = TABLE_SYSTEM_FIELDS,
  maxClauses = 20,
}: FilterEditorProps) {
  const t = useT();
  const group: TableFilterGroup = value ?? { combinator: 'and', clauses: [] };
  const targets: FilterTarget[] = [
    ...fields.map((field): FilterTarget => ({ kind: 'field', field })),
    ...systemFields.map((systemField): FilterTarget => ({ kind: 'system', systemField })),
  ];

  // Stable row keys, so removing a row never hands its neighbour's half-typed draft to another clause.
  const rowKeys = useRef<number[]>([]);
  const nextRowKey = useRef(0);
  if (rowKeys.current.length !== group.clauses.length) {
    rowKeys.current = group.clauses.map(() => nextRowKey.current++);
  }

  const setClauses = (clauses: TableFilterClause[]) => onChange({ ...group, clauses });
  const updateClause = (index: number, next: TableFilterClause) =>
    setClauses(group.clauses.map((clause, clauseIndex) => (clauseIndex === index ? next : clause)));
  const addClause = (target: FilterTarget) => {
    rowKeys.current = [...rowKeys.current, nextRowKey.current++];
    setClauses([...group.clauses, emptyClause(target)]);
  };
  const removeClause = (index: number) => {
    rowKeys.current = rowKeys.current.filter((_, keyIndex) => keyIndex !== index);
    setClauses(group.clauses.filter((_, clauseIndex) => clauseIndex !== index));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        {t('tables.match')}
        <Select
          inline
          size="sm"
          value={group.combinator}
          onChange={(event) => onChange({ ...group, combinator: event.target.value as 'and' | 'or' })}
        >
          <option value="and">{t('tables.allConditions')}</option>
          <option value="or">{t('tables.anyCondition')}</option>
        </Select>
      </div>
      <div className="space-y-2">
        {group.clauses.map((clause, index) => {
          const target = clauseTarget(clause, fields);
          const operators = target ? filterOperatorsFor(target) : [clause.operator];
          // An operator saved elsewhere (an agent-written view) stays visible even if this target would not offer it.
          const operatorChoices = operators.includes(clause.operator) ? operators : [clause.operator, ...operators];
          return (
            <div
              key={rowKeys.current[index]}
              className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
            >
              <Select
                aria-label={t('tables.chooseField')}
                value={target ? targetKey(target) : ''}
                onChange={(event) => {
                  const next = targetFromKey(event.target.value, fields);
                  if (next) updateClause(index, emptyClause(next));
                }}
              >
                {!target && <option value="">{t('tables.chooseField')}</option>}
                <optgroup label={t('tables.filter.fieldsGroup')}>
                  {fields.map((field) => (
                    <option key={field.id} value={`f:${field.id}`}>
                      {field.name}
                    </option>
                  ))}
                </optgroup>
                {systemFields.length > 0 && (
                  <optgroup label={t('tables.filter.recordInfoGroup')}>
                    {systemFields.map((systemField) => (
                      <option key={systemField} value={`s:${systemField}`}>
                        {t(SYSTEM_FIELD_LABEL_KEYS[systemField])}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
              <Select
                aria-label={t('tables.operator')}
                value={clause.operator}
                disabled={!target}
                onChange={(event) =>
                  target && updateClause(index, withOperator(clause, target, event.target.value as TableFilterOperator))
                }
              >
                {operatorChoices.map((operator) => (
                  <option key={operator} value={operator}>
                    {t(OPERATOR_LABEL_KEYS[operator])}
                  </option>
                ))}
              </Select>
              {target ? (
                <FilterValueInput
                  target={target}
                  kind={filterValueKind(target, clause.operator)}
                  clause={clause}
                  users={users}
                  onChange={(next) => updateClause(index, { ...clause, value: next })}
                />
              ) : (
                <Input aria-label={t('tables.value')} value="" disabled placeholder={t('tables.value')} />
              )}
              <IconButton label={t('tables.removeFilter')} tooltipMode="portal" onClick={() => removeClause(index)}>
                <X size={14} />
              </IconButton>
            </div>
          );
        })}
        {group.clauses.length === 0 && (
          <p className="rounded-md border border-dashed border-edge px-3 py-6 text-center text-xs text-fg-faint">
            {t('tables.noFilterConditions')}
          </p>
        )}
      </div>
      <Button
        variant="outline"
        onClick={() => targets[0] && addClause(targets[0])}
        disabled={targets.length === 0 || group.clauses.length >= maxClauses}
      >
        <Plus size={13} className="mr-1.5" />
        {t('tables.condition')}
      </Button>
    </div>
  );
}
