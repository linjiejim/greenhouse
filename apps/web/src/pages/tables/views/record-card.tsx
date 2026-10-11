/**
 * What a kanban / gallery card shows: the primary field as the title, then the
 * card fields (the view's `fieldIds`, or the first few fields when it lists
 * none) and system columns (`systemFields`). One renderer for values —
 * `FieldValue` — like everywhere else in Tables.
 */

import type { ReactNode } from 'react';
import type { TableSystemField, TableViewConfig } from '@greenhouse/types/tables';
import { FieldValue, recordFieldValue } from '../../../components/tables/field-value';
import { SYSTEM_FIELD_LABEL_KEYS } from '../../../components/tables/field-types';
import type { TableField, TableRecord, TableUserOption } from '../../../lib/api/tables';
import { useT } from '../../../lib/i18n';
import { formatDate } from '../../../lib/utils';

/** Cards without a field list show this many fields after the title. */
const DEFAULT_CARD_FIELDS = 3;

export function primaryField(fields: readonly TableField[]): TableField | undefined {
  return fields.find((field) => field.is_primary) ?? fields[0];
}

/** The fields under a card's title: the view's list, or the first few non-primary fields. */
export function cardFields(
  visible: readonly TableField[],
  schemaFields: readonly TableField[],
  config: TableViewConfig,
  primary: TableField | undefined,
): TableField[] {
  const source = config.fieldIds?.length ? visible : schemaFields.slice(0, DEFAULT_CARD_FIELDS + 1);
  return source
    .filter((field) => field.id !== primary?.id)
    .slice(0, config.fieldIds?.length ? undefined : DEFAULT_CARD_FIELDS);
}

/** A system column's value as text (a person's name, a timestamp). */
export function systemFieldText(
  record: TableRecord,
  field: TableSystemField,
  usersById: ReadonlyMap<string, Pick<TableUserOption, 'nickname'>>,
): string {
  if (field === 'created_by' || field === 'updated_by') return usersById.get(record[field])?.nickname ?? record[field];
  return formatDate(record[field]);
}

export function RecordTitle({
  record,
  primary,
  usersById,
}: {
  record: TableRecord;
  primary: TableField | undefined;
  usersById: ReadonlyMap<string, TableUserOption>;
}): ReactNode {
  const t = useT();
  const value = primary ? recordFieldValue(record, primary.id) : undefined;
  if (!primary || value === null || value === undefined || value === '') {
    return <span className="text-fg-faint">{t('tables.views.untitled', { id: record.id })}</span>;
  }
  return <FieldValue field={primary} value={value} usersById={usersById} />;
}

export function RecordCardFields({
  record,
  fields,
  systemFields,
  usersById,
}: {
  record: TableRecord;
  fields: readonly TableField[];
  systemFields: readonly TableSystemField[];
  usersById: ReadonlyMap<string, TableUserOption>;
}) {
  const t = useT();
  if (fields.length === 0 && systemFields.length === 0) return null;
  return (
    <dl className="space-y-1">
      {fields.map((field) => (
        <div key={field.id} className="min-w-0">
          <dt className="truncate text-[10px] uppercase tracking-wide text-fg-faint" title={field.name}>
            {field.name}
          </dt>
          <dd className="truncate text-xs text-fg-secondary">
            <FieldValue field={field} value={recordFieldValue(record, field.id)} usersById={usersById} />
          </dd>
        </div>
      ))}
      {systemFields.map((field) => (
        <div key={field} className="min-w-0">
          <dt className="truncate text-[10px] uppercase tracking-wide text-fg-faint">
            {t(SYSTEM_FIELD_LABEL_KEYS[field])}
          </dt>
          <dd className="truncate text-xs text-fg-secondary">{systemFieldText(record, field, usersById)}</dd>
        </div>
      ))}
    </dl>
  );
}
