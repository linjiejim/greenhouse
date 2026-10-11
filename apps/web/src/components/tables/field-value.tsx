/**
 * The one read-only renderer for a Tables value: grid cells, the record
 * drawer, the recycle bin and any other surface showing a record's field.
 */

import type { ReactNode } from 'react';
import type { TableFieldConfig } from '@greenhouse/types/tables';
import { TagList } from '../ui';
import type { TableField, TableRecord } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';
import { formatDate, formatDay } from '../../lib/utils';
import { fieldConfig } from './field-types';

export type TableUsersById = ReadonlyMap<string, { nickname: string }>;

/** A record's value for one field: the computed value when the field is computed, else the stored one. */
export function recordFieldValue(record: Pick<TableRecord, 'values' | 'computed_values'>, fieldId: number): unknown {
  const key = String(fieldId);
  const computed = record.computed_values[key];
  return computed === undefined ? record.values[key] : computed;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/** Plain text for one scalar inside a computed array (lookup) — the target field's type is not at hand. */
function scalarText(value: unknown, yes: string, no: string): string {
  if (typeof value === 'boolean') return value ? yes : no;
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

interface FieldValueProps {
  field: Pick<TableField, 'type' | 'config'>;
  value: unknown;
  usersById: TableUsersById;
}

export function FieldValue({ field, value, usersById }: FieldValueProps): ReactNode {
  const t = useT();
  if (isEmpty(value)) return <span className="text-fg-faint">—</span>;
  const yes = t('common.yes');
  const no = t('common.no');
  const config: TableFieldConfig = fieldConfig(field);
  const type = field.type === 'formula' ? (config.formula?.resultType ?? 'text') : field.type;

  if (type === 'boolean') return value === true ? yes : no;
  if (type === 'date' && typeof value === 'string') return formatDay(value);
  if (type === 'datetime' && typeof value === 'string') return formatDate(value);
  if (type === 'single_select' && typeof value === 'string') {
    const label = config.options?.find((option) => option.id === value)?.label ?? value;
    return <TagList items={[label]} max={1} tone="info" />;
  }
  if (type === 'multi_select' && Array.isArray(value)) {
    const labels = new Map((config.options ?? []).map((option) => [option.id, option.label]));
    return <TagList items={value.map((entry) => labels.get(String(entry)) ?? String(entry))} tone="info" />;
  }
  if (type === 'user' && typeof value === 'string') return usersById.get(value)?.nickname ?? value;
  if (type === 'multi_user' && Array.isArray(value)) {
    return <TagList items={value.map((entry) => usersById.get(String(entry))?.nickname ?? String(entry))} />;
  }
  if (type === 'attachment' && Array.isArray(value)) return <TagList items={value.map(String)} max={2} />;
  if (type === 'url' && typeof value === 'string') {
    return (
      <a href={value} target="_blank" rel="noreferrer" className="text-primary-fg hover:underline">
        {value}
      </a>
    );
  }
  // A lookup is the linked records' values of one target field: read-only chips.
  if (type === 'lookup' && Array.isArray(value)) {
    return <TagList items={value.flat().map((entry) => scalarText(entry, yes, no))} />;
  }
  if (Array.isArray(value)) return value.map((entry) => scalarText(entry, yes, no)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
