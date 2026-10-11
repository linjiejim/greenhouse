/**
 * Grid view body: the spreadsheet table — sortable headers, frozen leading
 * columns, inline cell editing, paste, row actions, system columns
 * (`systemFields`), row height, and grouping (`groupBy`): the server orders
 * the page by the group key, collapsible group headers carry the group's total
 * from an aggregate. Everything it changes goes through the container's
 * callbacks (see ./types).
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { TableSystemField, TableViewConfig } from '@greenhouse/types/tables';
import { EmptyState, IconButton } from '../../../components/ui';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../../../components/app/context-menu';
import { FieldValue, recordFieldValue } from '../../../components/tables/field-value';
import { SYSTEM_FIELD_LABEL_KEYS } from '../../../components/tables/field-types';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Edit3,
  LayoutGrid,
  MoreHorizontal,
  Pin,
  PinOff,
} from '../../../lib/icons';
import {
  STICKY_LEFT_CELL,
  STICKY_LEFT_HEADER,
  STICKY_RIGHT_CELL,
  STICKY_RIGHT_HEADER,
} from '../../../lib/sticky-columns';
import type { TableField, TableRecord } from '../../../lib/api/tables';
import { useT } from '../../../lib/i18n';
import { formatDay } from '../../../lib/utils';
import { InlineCell } from '../inline-cell';
import { RecordRowActions } from '../record-row-actions';
import { systemFieldText } from './record-card';
import type { TableViewBodyProps } from './types';
import { useGroupCounts } from './use-group-counts';
import { activeGroupBy, fieldById, NO_VALUE_GROUP, recordGroupKey } from './view-query';

/** Freeze more than this and the frozen block itself stops fitting on screen. */
const MAX_FROZEN_COLUMNS = 4;

const ROW_PADDING: Record<NonNullable<TableViewConfig['rowHeight']>, string> = {
  short: 'py-1.5',
  medium: 'py-3',
  tall: 'py-5 align-top',
};

/** Records split into runs of the same group, in page order. */
interface GroupRun {
  key: string;
  first: TableRecord;
  rows: Array<{ record: TableRecord; rowIndex: number }>;
}

function groupRuns(records: TableRecord[], keyOf: (record: TableRecord) => string): GroupRun[] {
  const runs: GroupRun[] = [];
  records.forEach((record, rowIndex) => {
    const key = keyOf(record);
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.rows.push({ record, rowIndex });
    else runs.push({ key, first: record, rows: [{ record, rowIndex }] });
  });
  return runs;
}

export function GridViewBody({
  table,
  config,
  fields,
  schemaFields,
  records,
  query,
  users,
  usersById,
  sort,
  permissions,
  onToggleSort,
  onOpenRecord,
  onEditRecord,
  onDeleteRecord,
  onCommitValue,
  onPaste,
  onEditField,
  onUpdateViewConfig,
}: TableViewBodyProps) {
  const t = useT();
  const { canEdit, canBuild, canChangeView } = permissions;
  const { menu, openMenu, closeMenu } = useContextMenu();
  const frozenCount = Math.min(config.frozenCount ?? 0, fields.length, MAX_FROZEN_COLUMNS);
  const systemFields = config.systemFields ?? [];
  const rowPadding = ROW_PADDING[config.rowHeight ?? 'short'];

  const groupBy = activeGroupBy(config, schemaFields);
  const groupField = groupBy?.fieldId ? fieldById(schemaFields, groupBy.fieldId) : undefined;
  const counts = useGroupCounts(table.id, groupBy, groupField, query, records);
  const groupIdentity = groupBy ? JSON.stringify(groupBy) : '';
  const [collapsed, setCollapsed] = useState<{ identity: string; keys: ReadonlySet<string> }>({
    identity: '',
    keys: new Set(),
  });
  const collapsedKeys = collapsed.identity === groupIdentity ? collapsed.keys : new Set<string>();
  const runs = useMemo(
    () => (groupBy ? groupRuns(records, (record) => recordGroupKey(record, groupBy, groupField)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- groupIdentity is groupBy's value identity
    [records, groupIdentity, groupField],
  );

  const toggleGroup = (key: string) => {
    const next = new Set(collapsedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed({ identity: groupIdentity, keys: next });
  };

  /**
   * Frozen columns need a real pixel offset, and the only honest source is the
   * rendered table: column widths come from content and `min-w-40`, never from
   * config, so computing them from `widths` would drift the moment a cell is
   * wider than expected.
   */
  const headerCells = React.useRef<Array<HTMLTableCellElement | null>>([]);
  const [columnWidths, setColumnWidths] = useState<number[]>([]);

  useEffect(() => {
    if (frozenCount === 0) return;
    const measure = () => {
      const next = headerCells.current.map((cell) => cell?.offsetWidth ?? 0);
      setColumnWidths((current) =>
        current.length === next.length && current.every((width, index) => width === next[index]) ? current : next,
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    for (const cell of headerCells.current) if (cell) observer.observe(cell);
    return () => observer.disconnect();
  }, [frozenCount, records, fields]);

  /** Left edge of data column `index`, past the row-number column at slot 0. */
  const frozenOffset = (index: number) => columnWidths.slice(0, index + 1).reduce((total, width) => total + width, 0);

  const columnMenu = (field: TableField, columnIndex: number): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (canBuild) items.push({ label: t('tables.editField'), icon: Edit3, onClick: () => onEditField(field) });
    if (canChangeView) {
      if (columnIndex < MAX_FROZEN_COLUMNS && frozenCount !== columnIndex + 1) {
        items.push({
          label: t('tables.freezeToColumn'),
          icon: Pin,
          onClick: () => void onUpdateViewConfig({ frozenCount: columnIndex + 1 }),
        });
      }
      if (frozenCount > 0) {
        items.push({
          label: t('tables.unfreezeColumns'),
          icon: PinOff,
          onClick: () => void onUpdateViewConfig({ frozenCount: 0 }),
        });
      }
    }
    return items;
  };

  const groupLabel = (run: GroupRun) => {
    if (run.key === NO_VALUE_GROUP) return <span className="text-fg-muted">{t('tables.views.noValue')}</span>;
    if (groupBy?.systemField) {
      return groupBy.systemField === 'created_by' || groupBy.systemField === 'updated_by'
        ? systemFieldText(run.first, groupBy.systemField, usersById)
        : formatDay(`${run.key}T00:00:00`);
    }
    if (!groupField) return run.key;
    if (groupField.type === 'datetime') return formatDay(`${run.key}T00:00:00`);
    return <FieldValue field={groupField} value={recordFieldValue(run.first, groupField.id)} usersById={usersById} />;
  };

  if (fields.length === 0 && systemFields.length === 0) {
    return <EmptyState icon={LayoutGrid} title={t('tables.noFields')} description={t('tables.noFieldsDescription')} />;
  }

  const sortIcon = (active: boolean, direction: 'asc' | 'desc' | undefined) =>
    active ? direction === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : null;
  const columnCount = fields.length + systemFields.length + 2;

  const renderRow = (record: TableRecord, rowIndex: number) => (
    <tr
      key={record.id}
      className="group cursor-pointer hover:bg-surface-sunken"
      /* A plain click anywhere in the row opens it — cells no longer
         swallow the click to disambiguate a double-click. */
      onClick={() => onOpenRecord(record)}
    >
      <td
        className={`${STICKY_LEFT_CELL} border-b border-r border-edge bg-surface-raised px-3 ${rowPadding} text-xs text-fg-faint group-hover:bg-surface-sunken`}
      >
        {record.id}
      </td>
      {fields.map((field, columnIndex) => {
        const value = recordFieldValue(record, field.id);
        return (
          <td
            key={field.id}
            style={columnIndex < frozenCount ? { left: frozenOffset(columnIndex) } : undefined}
            className={`max-w-80 border-b border-r border-edge px-2 ${rowPadding} text-xs text-fg-secondary ${
              columnIndex < frozenCount ? 'sticky z-[5] bg-surface-raised group-hover:bg-surface-sunken' : ''
            }`}
          >
            <InlineCell
              field={field}
              value={value}
              users={users}
              canEdit={canEdit}
              onCommit={(next) => onCommitValue(record, field, next)}
              onPaste={(event) => {
                if (!canEdit) return;
                event.preventDefault();
                onPaste(rowIndex, columnIndex, event.clipboardData.getData('text/plain'));
              }}
            >
              <FieldValue field={field} value={value} usersById={usersById} />
            </InlineCell>
          </td>
        );
      })}
      {systemFields.map((systemField) => (
        <td
          key={systemField}
          className={`whitespace-nowrap border-b border-r border-edge px-3 ${rowPadding} text-xs text-fg-muted`}
        >
          {systemFieldText(record, systemField, usersById)}
        </td>
      ))}
      <td
        className={`${STICKY_RIGHT_CELL} border-b border-edge bg-surface-raised px-2 py-1 group-hover:bg-surface-sunken`}
        onClick={(event) => event.stopPropagation()}
      >
        <RecordRowActions
          record={record}
          canEdit={canEdit}
          onView={onOpenRecord}
          onEdit={onEditRecord}
          onDelete={onDeleteRecord}
        />
      </td>
    </tr>
  );

  return (
    <>
      <table className="min-w-full border-separate border-spacing-0 text-left">
        <thead className="sticky top-0 z-10 bg-surface-sunken">
          <tr>
            <th
              ref={(cell) => {
                headerCells.current[0] = cell;
              }}
              className={`${STICKY_LEFT_HEADER} w-16 border-b border-r border-edge bg-surface-sunken px-3 py-2 text-[11px] font-medium text-fg-faint`}
            >
              #
            </th>
            {fields.map((field, columnIndex) => {
              const activeSort = sort?.[0]?.fieldId === field.id ? sort[0] : null;
              const frozen = columnIndex < frozenCount;
              return (
                <th
                  key={field.id}
                  ref={(cell) => {
                    headerCells.current[columnIndex + 1] = cell;
                  }}
                  style={frozen ? { left: frozenOffset(columnIndex) } : undefined}
                  className={`min-w-40 border-b border-r border-edge px-3 py-2 text-xs font-medium text-fg-secondary ${
                    frozen ? 'sticky z-20 bg-surface-sunken' : ''
                  }`}
                  onContextMenu={(event) => openMenu(event, columnMenu(field, columnIndex))}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      className="flex min-w-0 items-center gap-1 hover:text-fg"
                      onClick={() => onToggleSort(field)}
                    >
                      <span className="truncate" title={field.name}>
                        {field.name}
                      </span>
                      {sortIcon(activeSort !== null, activeSort?.direction)}
                    </button>
                    {/*
                      No z-index on the wrapper: the tooltip is portalled to
                      the body, so it needed none, and a stacking context
                      here would paint this button of a scrolled-under
                      column on top of the frozen ones.
                    */}
                    <IconButton
                      label={t('tables.columnOptions', { name: field.name })}
                      tooltip="top"
                      tooltipMode="portal"
                      onClick={(event) => openMenu(event, columnMenu(field, columnIndex))}
                      className="h-6 w-6 sm:h-6 sm:w-6"
                    >
                      <MoreHorizontal size={12} />
                    </IconButton>
                  </div>
                </th>
              );
            })}
            {systemFields.map((systemField: TableSystemField) => {
              const activeSort = sort?.[0]?.systemField === systemField ? sort[0] : null;
              return (
                <th
                  key={systemField}
                  className="min-w-36 border-b border-r border-edge px-3 py-2 text-xs font-medium text-fg-muted"
                  data-testid={`system-column-${systemField}`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1 hover:text-fg"
                    onClick={() => onToggleSort(systemField)}
                  >
                    <span className="truncate">{t(SYSTEM_FIELD_LABEL_KEYS[systemField])}</span>
                    {sortIcon(activeSort !== null, activeSort?.direction)}
                  </button>
                </th>
              );
            })}
            <th
              className={`${STICKY_RIGHT_HEADER} border-b border-edge bg-surface-sunken px-3 py-2 text-xs font-medium text-fg-secondary ${
                canEdit ? 'w-28' : 'w-12'
              }`}
            >
              {t('common.actions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {groupBy
            ? runs.map((run) => {
                const isCollapsed = collapsedKeys.has(run.key);
                return (
                  <React.Fragment key={`group-${run.key}-${run.rows[0]!.rowIndex}`}>
                    <tr data-testid={`group-header-${run.key || 'none'}`} className="bg-surface-muted">
                      <td colSpan={columnCount} className="border-b border-edge px-3 py-1.5">
                        <button
                          type="button"
                          aria-expanded={!isCollapsed}
                          aria-label={t(isCollapsed ? 'tables.views.expandGroup' : 'tables.views.collapseGroup')}
                          onClick={() => toggleGroup(run.key)}
                          className="sticky left-3 flex max-w-full items-center gap-2 text-xs font-medium text-fg-secondary hover:text-fg"
                        >
                          {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                          <span className="min-w-0 truncate">{groupLabel(run)}</span>
                          <span className="text-fg-faint" data-testid="group-count">
                            {counts?.get(run.key) ?? run.rows.length}
                          </span>
                        </button>
                      </td>
                    </tr>
                    {!isCollapsed && run.rows.map(({ record, rowIndex }) => renderRow(record, rowIndex))}
                  </React.Fragment>
                );
              })
            : records.map((record, rowIndex) => renderRow(record, rowIndex))}
        </tbody>
      </table>
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </>
  );
}
