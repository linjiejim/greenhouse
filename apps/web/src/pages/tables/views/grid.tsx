/**
 * Grid view body: the spreadsheet table — sortable headers, frozen leading
 * columns, inline cell editing, paste, row actions. Everything it changes goes
 * through the container's callbacks (see ./types).
 */

import React, { useEffect, useState } from 'react';
import { EmptyState, IconButton } from '../../../components/ui';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../../../components/app/context-menu';
import { FieldValue, recordFieldValue } from '../../../components/tables/field-value';
import { ArrowDown, ArrowUp, Edit3, LayoutGrid, MoreHorizontal, Pin, PinOff } from '../../../lib/icons';
import {
  STICKY_LEFT_CELL,
  STICKY_LEFT_HEADER,
  STICKY_RIGHT_CELL,
  STICKY_RIGHT_HEADER,
} from '../../../lib/sticky-columns';
import type { TableField } from '../../../lib/api/tables';
import { useT } from '../../../lib/i18n';
import { InlineCell } from '../inline-cell';
import { RecordRowActions } from '../record-row-actions';
import type { TableViewBodyProps } from './types';

/** Freeze more than this and the frozen block itself stops fitting on screen. */
const MAX_FROZEN_COLUMNS = 4;

export function GridViewBody({
  config,
  fields,
  records,
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

  if (fields.length === 0) {
    return <EmptyState icon={LayoutGrid} title={t('tables.noFields')} description={t('tables.noFieldsDescription')} />;
  }

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
                      {activeSort?.direction === 'asc' && <ArrowUp size={11} />}
                      {activeSort?.direction === 'desc' && <ArrowDown size={11} />}
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
          {records.map((record, rowIndex) => (
            <tr
              key={record.id}
              className="group cursor-pointer hover:bg-surface-sunken"
              /* A plain click anywhere in the row opens it — cells no longer
                 swallow the click to disambiguate a double-click. */
              onClick={() => onOpenRecord(record)}
            >
              <td
                className={`${STICKY_LEFT_CELL} border-b border-r border-edge bg-surface-raised px-3 py-2 text-xs text-fg-faint group-hover:bg-surface-sunken`}
              >
                {record.id}
              </td>
              {fields.map((field, columnIndex) => {
                const value = recordFieldValue(record, field.id);
                return (
                  <td
                    key={field.id}
                    style={columnIndex < frozenCount ? { left: frozenOffset(columnIndex) } : undefined}
                    className={`max-w-80 border-b border-r border-edge px-2 py-1.5 text-xs text-fg-secondary ${
                      columnIndex < frozenCount ? 'sticky z-[5] bg-surface-raised group-hover:bg-surface-sunken' : ''
                    }`}
                  >
                    <InlineCell
                      field={field}
                      value={value}
                      users={users}
                      canEdit={canEdit && (permissions.canEditField?.(field.id) ?? true)}
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
              <td
                className={`${STICKY_RIGHT_CELL} border-b border-edge bg-surface-raised px-2 py-1 group-hover:bg-surface-sunken`}
                onClick={(event) => event.stopPropagation()}
              >
                <RecordRowActions
                  record={record}
                  canEdit={canEdit}
                  canDelete={permissions.canDelete ?? canEdit}
                  onView={onOpenRecord}
                  onEdit={onEditRecord}
                  onDelete={onDeleteRecord}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </>
  );
}
