/**
 * The viewer-side filter bar of a dashboard (Phase 1: an app page): one
 * control per `TableFilterControl`, in one row above the cards.
 *
 * Values are `TableFilterValue`s keyed by control id. A key that is absent
 * means "the control's default"; `null` means the viewer cleared it. The
 * server ignores values for controls this viewer cannot see, and the controls
 * it receives are already trimmed — so the bar only ever shows readable fields.
 */

import { useEffect, useMemo, useState } from 'react';
import { ME_TOKEN } from '@greenhouse/types/date-tokens';
import { TABLE_DATE_RANGE_PRESETS } from '@greenhouse/types/table-cards';
import type {
  TableDateRangePreset,
  TableFilterControl,
  TableFilterValue,
  TableSelectOption,
} from '@greenhouse/types/tables';
import type { TableField, TableUserOption } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';
import { RotateCcw } from '../../lib/icons';
import { Button, DateRangeInput, SearchInput, Select } from '../ui';
import { fieldConfig } from '../tables/field-types';

export type DashboardFilterValues = Record<string, TableFilterValue | null>;

/** The value a control currently has: the viewer's choice, else its default. */
export function effectiveFilterValue(
  control: TableFilterControl,
  values: DashboardFilterValues,
): TableFilterValue | null {
  return Object.prototype.hasOwnProperty.call(values, control.id)
    ? (values[control.id] ?? null)
    : (control.defaultValue ?? null);
}

/** Options of every select field a control targets, de-duplicated by id. */
function selectOptions(
  control: TableFilterControl,
  fieldsByTable: ReadonlyMap<number, readonly TableField[]>,
): TableSelectOption[] {
  const out = new Map<string, TableSelectOption>();
  for (const target of control.targets) {
    const field = fieldsByTable.get(target.tableId)?.find((entry) => entry.id === target.fieldId);
    for (const option of field ? (fieldConfig(field).options ?? []) : []) {
      if (!out.has(option.id)) out.set(option.id, option);
    }
  }
  return [...out.values()];
}

function SearchControl({
  control,
  value,
  onChange,
}: {
  control: TableFilterControl;
  value: TableFilterValue | null;
  onChange: (value: TableFilterValue | null) => void;
}) {
  const t = useT();
  const committed = value?.kind === 'search' ? value.text : '';
  const [draft, setDraft] = useState(committed);
  useEffect(() => setDraft(committed), [committed]);
  useEffect(() => {
    if (draft === committed) return;
    const timer = setTimeout(() => onChange(draft.trim() ? { kind: 'search', text: draft } : null), 350);
    return () => clearTimeout(timer);
  }, [committed, draft, onChange]);
  return (
    <SearchInput
      value={draft}
      onChange={setDraft}
      placeholder={t('tables.dashboard.filters.searchPlaceholder', { label: control.label })}
      aria-label={control.label}
      className="w-44"
    />
  );
}

function DateRangeControl({
  control,
  value,
  onChange,
}: {
  control: TableFilterControl;
  value: TableFilterValue | null;
  onChange: (value: TableFilterValue | null) => void;
}) {
  const t = useT();
  const range = value?.kind === 'date_range' ? value : null;
  const [customOpen, setCustomOpen] = useState(Boolean(range && !range.preset));
  const selected = range?.preset ?? (range || customOpen ? 'custom' : '');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        size="sm"
        inline
        aria-label={control.label}
        value={selected}
        onChange={(event) => {
          const next = event.target.value;
          setCustomOpen(next === 'custom');
          if (next === '') onChange(null);
          else if (next !== 'custom') onChange({ kind: 'date_range', preset: next as TableDateRangePreset });
        }}
      >
        <option value="">{t('tables.dashboard.filters.allTime')}</option>
        {TABLE_DATE_RANGE_PRESETS.map((preset) => (
          <option key={preset} value={preset}>
            {t(`tables.dashboard.filters.preset.${preset}`)}
          </option>
        ))}
        <option value="custom">{t('tables.dashboard.filters.custom')}</option>
      </Select>
      {selected === 'custom' && (
        <DateRangeInput
          from={range?.from ?? ''}
          to={range?.to ?? ''}
          onChange={(from, to) =>
            onChange(from || to ? { kind: 'date_range', ...(from ? { from } : {}), ...(to ? { to } : {}) } : null)
          }
        />
      )}
    </div>
  );
}

export function FilterBar({
  controls,
  values,
  onChange,
  fieldsByTable,
  users,
}: {
  controls: readonly TableFilterControl[];
  values: DashboardFilterValues;
  onChange: (next: DashboardFilterValues) => void;
  fieldsByTable: ReadonlyMap<number, readonly TableField[]>;
  users: readonly TableUserOption[];
}) {
  const t = useT();
  const setValue = useMemo(
    () => (id: string) => (value: TableFilterValue | null) => onChange({ ...values, [id]: value }),
    [onChange, values],
  );
  if (controls.length === 0) return null;
  const changed = Object.keys(values).length > 0;

  return (
    <div
      className="flex flex-wrap items-end gap-x-4 gap-y-2"
      role="group"
      aria-label={t('tables.dashboard.filters.bar')}
      data-testid="dashboard-filter-bar"
    >
      {controls.map((control) => {
        const value = effectiveFilterValue(control, values);
        const change = setValue(control.id);
        return (
          <div key={control.id} className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-[11px] font-medium text-fg-muted" title={control.label}>
              {control.label}
            </span>
            {control.kind === 'date_range' && <DateRangeControl control={control} value={value} onChange={change} />}
            {control.kind === 'search' && <SearchControl control={control} value={value} onChange={change} />}
            {control.kind === 'select' && (
              <Select
                size="sm"
                inline
                aria-label={control.label}
                value={value?.kind === 'select' ? (value.values[0] ?? '') : ''}
                onChange={(event) =>
                  change(event.target.value ? { kind: 'select', values: [event.target.value] } : null)
                }
              >
                <option value="">{t('tables.dashboard.filters.any')}</option>
                {selectOptions(control, fieldsByTable).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
            {control.kind === 'user' && (
              <Select
                size="sm"
                inline
                aria-label={control.label}
                value={value?.kind === 'user' ? (value.userIds[0] ?? '') : ''}
                onChange={(event) =>
                  change(event.target.value ? { kind: 'user', userIds: [event.target.value] } : null)
                }
              >
                <option value="">{t('tables.dashboard.filters.anyone')}</option>
                <option value={ME_TOKEN}>{t('tables.dashboard.filters.me')}</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.nickname}
                  </option>
                ))}
              </Select>
            )}
          </div>
        );
      })}
      {changed && (
        <Button variant="ghost" size="sm" onClick={() => onChange({})} className="gap-1">
          <RotateCcw size={12} />
          {t('tables.dashboard.filters.clear')}
        </Button>
      )}
    </div>
  );
}
