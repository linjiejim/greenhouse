/**
 * Records card (and the drill-down list): a compact record table drawn with
 * the shared `FieldValue` renderer. Columns are the card's `fieldIds` (the
 * first five fields when it names none) followed by its system columns. A row
 * opens its record.
 */

import type { TableSystemField } from '@greenhouse/types/tables';
import type { TableField, TableRecord } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';
import { formatDate } from '../../lib/utils';
import { Button } from '../ui';
import { FieldValue, recordFieldValue, type TableUsersById } from '../tables/field-value';
import { SYSTEM_FIELD_LABEL_KEYS } from '../tables/field-types';

const DEFAULT_COLUMNS = 5;
const CELL = 'border-b border-edge px-3 py-2';

/** The fields a records list shows, in order — unknown (hidden, archived) ids are skipped. */
export function recordColumns(fields: readonly TableField[], fieldIds: readonly number[] | undefined): TableField[] {
  if (!fieldIds || fieldIds.length === 0) return fields.slice(0, DEFAULT_COLUMNS);
  const byId = new Map(fields.map((field) => [field.id, field]));
  return fieldIds.flatMap((id) => {
    const field = byId.get(id);
    return field ? [field] : [];
  });
}

function systemValue(record: TableRecord, field: TableSystemField, usersById: TableUsersById): string {
  if (field === 'created_by' || field === 'updated_by') {
    const id = record[field];
    return usersById.get(id)?.nickname ?? id;
  }
  return formatDate(record[field]);
}

export function RecordsTable({
  records,
  fields,
  fieldIds,
  systemFields = [],
  usersById,
  onOpenRecord,
}: {
  records: readonly TableRecord[];
  fields: readonly TableField[];
  fieldIds?: readonly number[];
  systemFields?: readonly TableSystemField[];
  usersById: TableUsersById;
  onOpenRecord?: (record: TableRecord) => void;
}) {
  const t = useT();
  const columns = recordColumns(fields, fieldIds);
  const primary = fields.find((field) => field.is_primary) ?? columns[0];
  const recordName = (record: TableRecord) => {
    const value = primary ? recordFieldValue(record, primary.id) : undefined;
    return typeof value === 'string' && value.trim()
      ? value
      : t('tables.dashboard.card.untitledRecord', { id: record.id });
  };

  return (
    <table className="min-w-full text-left text-xs [&_td]:whitespace-nowrap">
      <thead className="sticky top-0 z-10 bg-surface-sunken [&_th]:whitespace-nowrap">
        <tr>
          {columns.map((field) => (
            <th key={field.id} className={`${CELL} font-medium text-fg-muted`}>
              {field.name}
            </th>
          ))}
          {systemFields.map((field) => (
            <th key={field} className={`${CELL} font-medium text-fg-muted`}>
              {t(SYSTEM_FIELD_LABEL_KEYS[field])}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {records.map((record) => (
          <tr
            key={record.id}
            className={onOpenRecord ? 'cursor-pointer hover:bg-surface-muted' : undefined}
            onClick={onOpenRecord ? () => onOpenRecord(record) : undefined}
          >
            {columns.map((field, index) => (
              <td key={field.id} className={`${CELL} text-fg-secondary`}>
                {index === 0 && onOpenRecord ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-mx-1 max-w-56 justify-start px-1 py-0 font-normal text-fg"
                    aria-label={t('tables.dashboard.card.openRecord', { name: recordName(record) })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenRecord(record);
                    }}
                  >
                    <span className="truncate">
                      <FieldValue field={field} value={recordFieldValue(record, field.id)} usersById={usersById} />
                    </span>
                  </Button>
                ) : (
                  <span className="block max-w-56 truncate">
                    <FieldValue field={field} value={recordFieldValue(record, field.id)} usersById={usersById} />
                  </span>
                )}
              </td>
            ))}
            {systemFields.map((field) => (
              <td key={field} className={`${CELL} text-fg-secondary`}>
                {systemValue(record, field, usersById)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RecordsCard(props: Parameters<typeof RecordsTable>[0]) {
  const t = useT();
  return (
    <div className="h-full min-h-0 overflow-auto rounded-md border border-edge bg-surface-raised">
      <RecordsTable {...props} />
      {props.records.length === 0 && (
        <div className="px-3 py-6 text-center text-xs text-fg-faint">{t('tables.dashboard.card.noData')}</div>
      )}
    </div>
  );
}
