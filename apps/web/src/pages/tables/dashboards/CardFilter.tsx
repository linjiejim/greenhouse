/**
 * A card's filter, inline in the card editor: conditions on the card's table (field, operator,
 * value), all or any of them. The operators and values follow what the field's value behaves as
 * (a formula as what it yields), the way the server reads them; text commits a moment after
 * typing stops.
 */

import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, DatePicker, IconButton, Input, Segmented, Select, type SelectOption } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import {
  FILTER_TOKENS,
  MAX_FILTER_CLAUSES,
  SYSTEM_FIELDS,
  isLinkType,
  operatorsFor,
  type Field,
  type Filter,
  type FilterClause,
  type FilterOperator,
} from '@greenhouse/contract';
import { usePeople } from '../../../data/people';
import { useTitles } from '../../../data/tables';
import { useI18n, type Translate } from '../../../lib/i18n';
import { FieldIcon, memberOptions } from '../cells';
import { linkTable } from '../model';
import { isDateKind, kindOfRef } from './model';

const needsValue = (op: FilterOperator) => op !== 'is_empty' && op !== 'is_not_empty';
type Kind = NonNullable<ReturnType<typeof kindOfRef>>;

function opLabel(t: Translate, kind: Kind | undefined, op: FilterOperator) {
  if (isDateKind(kind) && (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte'))
    return t(`tables.op.date.${op}`);
  return t(`tables.op.${op}`);
}

function LinkValue({ field, value, onChange }: { field: Field; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const titles = useTitles(linkTable(field));
  return (
    <Select
      label={t('tables.filter.value')}
      size="sm"
      value={value}
      searchable
      options={(titles.data?.items ?? []).map((item) => ({ value: item.id, label: item.title || '—' }))}
      onChange={onChange}
    />
  );
}

function ClauseValue({
  fields,
  clause,
  onChange,
  immediate,
}: {
  immediate: boolean;
  fields: readonly Field[];
  clause: FilterClause;
  onChange: (value: FilterClause['value']) => void;
}) {
  const { t } = useI18n();
  const { members } = usePeople();
  const kind = kindOfRef(fields, clause.field);
  const field = fields.find((entry) => entry.id === clause.field);
  const label = t('tables.filter.value');
  const [text, setText] = useState(
    typeof clause.value === 'string' || typeof clause.value === 'number' ? String(clause.value) : '',
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  if (!needsValue(clause.op) || !kind) return null;
  if (isDateKind(kind)) {
    const token = typeof clause.value === 'string' && clause.value.startsWith('$') ? clause.value : 'date';
    return (
      <span className="app-tb-clause-date">
        <Select
          label={label}
          size="sm"
          value={token}
          options={[
            ...FILTER_TOKENS.filter((entry) => entry !== '$me').map((entry) => ({
              value: entry,
              label: t(`tables.token.${entry}`),
            })),
            { value: 'date', label: t('tables.token.date') },
          ]}
          onChange={(next) => onChange(next === 'date' ? '' : next)}
        />
        {token === 'date' && (
          <DatePicker label={label} value={typeof clause.value === 'string' ? clause.value : ''} onChange={onChange} />
        )}
      </span>
    );
  }
  switch (kind) {
    case 'checkbox':
      return (
        <Select
          label={label}
          size="sm"
          value={clause.value === false ? 'false' : 'true'}
          options={[
            { value: 'true', label: t('tables.checked') },
            { value: 'false', label: t('tables.unchecked') },
          ]}
          onChange={(next) => onChange(next === 'true')}
        />
      );
    case 'single_select':
    case 'multi_select':
      return (
        <Select
          label={label}
          size="sm"
          value={typeof clause.value === 'string' ? clause.value : ''}
          options={(field?.config.options ?? []).map((option) => ({ value: option.id, label: option.label }))}
          onChange={onChange}
        />
      );
    case 'member':
    case 'created_by':
    case 'updated_by':
      return (
        <Select
          label={label}
          size="sm"
          value={typeof clause.value === 'string' ? clause.value : ''}
          options={[{ value: '$me', label: t('tables.token.$me') }, ...memberOptions(members)]}
          onChange={onChange}
        />
      );
    default:
      if (field && isLinkType(field.type)) {
        return (
          <LinkValue field={field} value={typeof clause.value === 'string' ? clause.value : ''} onChange={onChange} />
        );
      }
      return (
        <Input
          aria-label={label}
          className="app-tb-clause-input"
          inputMode={kind === 'number' ? 'decimal' : undefined}
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            if (timer.current) clearTimeout(timer.current);
            if (immediate) {
              onChange(kind === 'number' ? (next.trim() ? Number(next) : undefined) : next);
              return;
            }
            timer.current = setTimeout(
              () => onChange(kind === 'number' ? (next.trim() ? Number(next) : undefined) : next),
              400,
            );
          }}
        />
      );
  }
}

export function CardFilter({
  fields,
  immediate = false,
  filter,
  onChange,
}: {
  immediate?: boolean;
  /** The fields of the card's table that I see. */
  fields: readonly Field[];
  filter: Filter | undefined;
  onChange: (next: Filter | undefined) => void;
}) {
  const { t } = useI18n();
  const current: Filter = filter ?? { mode: 'and', clauses: [] };
  const options: SelectOption[] = [
    ...fields
      .filter((field) => operatorsFor(kindOfRef(fields, field.id)!).length > 0)
      .map((field) => ({ value: field.id, label: field.name, icon: <FieldIcon type={field.type} /> })),
    ...SYSTEM_FIELDS.map((field) => ({ value: field, label: t(`tables.system.${field}`) })),
  ];
  const save = (next: Filter) => onChange(next.clauses.length ? next : undefined);
  const set = (index: number, change: Partial<FilterClause>) =>
    save({
      ...current,
      clauses: current.clauses.map((clause, at) => (at === index ? { ...clause, ...change } : clause)),
    });
  return (
    <div className="app-tb-dash-filter">
      {current.clauses.length > 1 && (
        <Segmented
          label={t('tables.filter.mode')}
          items={[
            { value: 'and', label: t('tables.filter.and') },
            { value: 'or', label: t('tables.filter.or') },
          ]}
          value={current.mode}
          onChange={(mode) => save({ ...current, mode: mode as Filter['mode'] })}
        />
      )}
      {current.clauses.map((clause, index) => {
        const kind = kindOfRef(fields, clause.field);
        return (
          <div key={index} className="app-tb-clause">
            <Select
              label={t('tables.filter.field')}
              size="sm"
              value={clause.field}
              options={options}
              onChange={(next) =>
                set(index, { field: next, op: operatorsFor(kindOfRef(fields, next)!)[0]!, value: undefined })
              }
            />
            <Select
              label={t('tables.filter.op')}
              size="sm"
              value={clause.op}
              options={(kind ? operatorsFor(kind) : []).map((op) => ({ value: op, label: opLabel(t, kind, op) }))}
              onChange={(op) =>
                set(index, {
                  op: op as FilterOperator,
                  ...(needsValue(op as FilterOperator) ? {} : { value: undefined }),
                })
              }
            />
            <ClauseValue
              key={`${clause.field}:${clause.op}`}
              immediate={immediate}
              fields={fields}
              clause={clause}
              onChange={(value) => set(index, { value })}
            />
            <IconButton
              size="sm"
              label={t('tables.filter.remove')}
              onClick={() => save({ ...current, clauses: current.clauses.filter((_, at) => at !== index) })}
            >
              <Trash2 size={icon.sm} strokeWidth={icon.stroke} />
            </IconButton>
          </div>
        );
      })}
      <div className="app-tb-panel-actions">
        <Button
          size="sm"
          kind="ghost"
          disabled={current.clauses.length >= MAX_FILTER_CLAUSES}
          onClick={() => {
            const first = fields[0];
            if (!first) return;
            save({
              ...current,
              clauses: [...current.clauses, { field: first.id, op: operatorsFor(kindOfRef(fields, first.id)!)[0]! }],
            });
          }}
        >
          <Plus size={icon.sm} strokeWidth={icon.stroke} />
          {t('tables.filter.add')}
        </Button>
      </div>
    </div>
  );
}
