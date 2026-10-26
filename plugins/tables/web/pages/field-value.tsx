import type { ReactNode } from 'react';
import { TagList } from '@greenhouse/web/extension-kit';
import type { TableField } from '../api';
import { formatDate, formatDay } from '@greenhouse/web/extension-kit';
import { relationIdsOf, type RelationLabelLookup } from './relation-labels';

export function renderTableFieldValue(
  field: TableField,
  value: unknown,
  usersById: ReadonlyMap<string, { nickname: string }>,
  relationLabel?: RelationLabelLookup,
): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="text-fg-faint">—</span>;
  const config = field.config ?? {};
  const options = new Map((config.options ?? []).map((option) => [option.id, option.label]));
  if (field.type === 'boolean') return value === true ? 'Yes' : 'No';
  if (field.type === 'date' && typeof value === 'string') return formatDay(value);
  if (field.type === 'datetime' && typeof value === 'string') return formatDate(value);
  if (field.type === 'single_select' && typeof value === 'string') {
    return <TagList items={[options.get(value) ?? value]} max={1} tone="info" />;
  }
  if (field.type === 'multi_select' && Array.isArray(value)) {
    return <TagList items={value.map((entry) => options.get(String(entry)) ?? String(entry))} tone="info" />;
  }
  if (field.type === 'user' && typeof value === 'string') return usersById.get(value)?.nickname ?? value;
  if (field.type === 'multi_user' && Array.isArray(value)) {
    return <TagList items={value.map((entry) => usersById.get(String(entry))?.nickname ?? String(entry))} />;
  }
  if (field.type === 'relation') {
    // The linked record's primary field (see ./relation-labels.ts), `#id` until it is known.
    const names = relationIdsOf(value).map((id) => relationLabel?.(field, id) ?? `#${id}`);
    if (names.length === 0) return <span className="text-fg-faint">—</span>;
    return config.relation?.multiple ? <TagList items={names} /> : names[0];
  }
  if (field.type === 'attachment' && Array.isArray(value)) return <TagList items={value.map(String)} max={2} />;
  if (field.type === 'url' && typeof value === 'string') {
    return (
      <a href={value} target="_blank" rel="noreferrer" className="text-primary-fg hover:underline">
        {value}
      </a>
    );
  }
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
