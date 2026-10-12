/**
 * The one read-only renderer for a Tables value: grid cells, the record
 * drawer, the recycle bin and any other surface showing a record's field.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { tableAiValueType, type TableFieldConfig } from '@greenhouse/types/tables';
import { TagList } from '../ui';
import type { TableField, TableRecord } from '../../lib/api/tables';
import { useI18n } from '../../lib/i18n';
import { formatDate, formatDay } from '../../lib/utils';
import { fieldConfig } from './field-types';

export type TableUsersById = ReadonlyMap<string, { nickname: string }>;

/**
 * Labels a host already holds for values that are only ids — relation targets
 * and attachments. An app's gateway resolves them (its viewers cannot call
 * `/api/tables`), so app cards wrap what they draw in `FieldValueRefsProvider`;
 * Tables provides none and shows the ids, as before.
 */
export interface FieldValueRefs {
  /** `<targetTableId>:<recordId>` → the target's label; `null` = outside the reader's scope. */
  records?: Readonly<Record<string, string | null>>;
  /** File id → its name. */
  files?: Readonly<Record<string, { name: string }>>;
  /** Shown for a relation target the reader may not see. */
  restrictedLabel: string;
}

const FieldValueRefsContext = createContext<FieldValueRefs | null>(null);
export const FieldValueRefsProvider = FieldValueRefsContext.Provider;

function relationLabels(value: unknown, targetTableId: number | undefined, refs: FieldValueRefs): string[] | null {
  if (!refs.records || targetTableId === undefined) return null;
  const ids = (Array.isArray(value) ? value : [value]).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  return ids.map((id) => {
    const label = refs.records![`${targetTableId}:${id}`];
    return label === null ? refs.restrictedLabel : label?.trim() || `#${id}`;
  });
}

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

/**
 * A stored number as people read it: grouped the way the UI language groups
 * (760,000), with every decimal it was stored with — never rounded for show.
 * Editing keeps the raw value (`FieldEditor`).
 */
export function formatFieldNumber(value: number, locale: string): string {
  const text = String(value);
  // Infinity / NaN / exponent notation (1e21) stay as they are.
  if (!Number.isFinite(value) || /e/i.test(text)) return text;
  const decimals = Math.min(text.split('.')[1]?.length ?? 0, 20);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: decimals }).format(value);
}

interface FieldValueProps {
  field: Pick<TableField, 'type' | 'config'>;
  value: unknown;
  usersById: TableUsersById;
}

export function FieldValue({ field, value, usersById }: FieldValueProps): ReactNode {
  const { t, locale } = useI18n();
  const refs = useContext(FieldValueRefsContext);
  if (isEmpty(value)) return <span className="text-fg-faint">—</span>;
  const yes = t('common.yes');
  const no = t('common.no');
  const config: TableFieldConfig = fieldConfig(field);
  const type =
    field.type === 'ai'
      ? tableAiValueType(config)
      : field.type === 'formula'
        ? (config.formula?.resultType ?? 'text')
        : field.type;

  if (type === 'boolean') return value === true ? yes : no;
  // Numbers, number formulas and rollup results (count / sum / avg / min / max).
  if ((type === 'number' || type === 'rollup') && typeof value === 'number') return formatFieldNumber(value, locale);
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
  if (type === 'attachment' && Array.isArray(value)) {
    return <TagList items={value.map((id) => refs?.files?.[String(id)]?.name ?? String(id))} max={2} />;
  }
  if (type === 'relation' && refs) {
    const labels = relationLabels(value, config.relation?.targetTableId, refs);
    if (labels) return <TagList items={labels} max={3} />;
  }
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
