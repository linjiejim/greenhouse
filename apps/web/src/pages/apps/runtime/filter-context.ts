/**
 * The page filters a viewer has set, as the filter bar shows them
 * (`Status: Pending`) — for the Assistant's `app-page` context, which states
 * facts about the screen and never the raw ids behind them.
 */

import { ME_TOKEN } from '@greenhouse/types/date-tokens';
import type { TableFilterControl, TableFilterValue } from '@greenhouse/types/tables';
import { effectiveFilterValue, type TableCardFilterValues } from '../../../components/table-cards';
import { fieldConfig } from '../../../components/tables/field-types';
import type { TableField, TableUserOption } from '../../../lib/api/tables';
import type { TranslationKey } from '../../../lib/i18n';

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

function optionLabel(
  control: TableFilterControl,
  id: string,
  fieldsByTable: ReadonlyMap<number, readonly TableField[]>,
): string {
  for (const target of control.targets) {
    const field = fieldsByTable.get(target.tableId)?.find((entry) => entry.id === target.fieldId);
    const option = field ? fieldConfig(field).options?.find((entry) => entry.id === id) : undefined;
    if (option) return option.label;
  }
  return id;
}

function valueText(
  control: TableFilterControl,
  value: TableFilterValue,
  fieldsByTable: ReadonlyMap<number, readonly TableField[]>,
  users: readonly TableUserOption[],
  t: Translate,
): string {
  switch (value.kind) {
    case 'search':
      return value.text;
    case 'select':
      return value.values.map((id) => optionLabel(control, id, fieldsByTable)).join(', ');
    case 'user':
      return value.userIds
        .map((id) =>
          id === ME_TOKEN ? t('tables.dashboard.filters.me') : (users.find((user) => user.id === id)?.nickname ?? id),
        )
        .join(', ');
    case 'date_range':
      if (value.preset) return t(`tables.dashboard.filters.preset.${value.preset}` as TranslationKey);
      return [value.from ?? '…', value.to ?? '…'].join(' – ');
  }
}

export function describeFilters(
  controls: readonly TableFilterControl[],
  values: TableCardFilterValues,
  fieldsByTable: ReadonlyMap<number, readonly TableField[]>,
  users: readonly TableUserOption[],
  t: Translate,
): Array<{ label: string; value: string }> {
  return controls.flatMap((control) => {
    const value = effectiveFilterValue(control, values);
    if (!value) return [];
    const text = valueText(control, value, fieldsByTable, users, t);
    return text ? [{ label: control.label, value: text }] : [];
  });
}
