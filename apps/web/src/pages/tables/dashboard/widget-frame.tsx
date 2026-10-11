/**
 * One dashboard widget on the grid: the frame (title, builder actions, drag
 * handle) around the shared card renderer.
 */

import type { TableCardPoint } from '@greenhouse/types/table-cards';
import type { TableDashboardWidget, TableField, TableRecord } from '../../../lib/api/tables';
import { TableCardView, useCardLabels } from '../../../components/table-cards';
import type { TableUsersById } from '../../../components/tables/field-value';
import { IconButton } from '../../../components/ui';
import { WIDGET_DRAG_HANDLE_CLASS } from '../../../components/workbench/widget-grid';
import { Edit3, Trash2 } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';
import type { WidgetState } from './use-dashboard-data';

const NO_FIELDS: TableField[] = [];

export function WidgetFrame({
  widget,
  state,
  fields = NO_FIELDS,
  usersById,
  canBuild,
  onEdit,
  onDelete,
  onDrill,
  onOpenRecord,
  onRetry,
}: {
  widget: TableDashboardWidget;
  state: WidgetState | undefined;
  fields?: TableField[];
  usersById: TableUsersById;
  canBuild: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onDrill: (point: TableCardPoint, label: string) => void;
  onOpenRecord: (record: TableRecord) => void;
  onRetry: () => void;
}) {
  const t = useT();
  const labels = useCardLabels(fields, usersById);
  const withheld = widget.access === 'no_access';
  return (
    <section
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-edge bg-surface-card p-4 shadow-sm"
      data-testid={`dashboard-widget-${widget.id}`}
    >
      <div
        className={`mb-3 flex flex-shrink-0 items-center justify-between gap-2 ${
          canBuild ? `${WIDGET_DRAG_HANDLE_CLASS} cursor-move` : ''
        }`}
      >
        <h3 className="truncate text-sm font-semibold text-fg" title={widget.title}>
          {widget.title}
        </h3>
        {canBuild && (
          <div className="flex">
            {!withheld && (
              <IconButton
                label={t('tables.dashboard.editWidgetLabel', { name: widget.title })}
                tooltipMode="portal"
                onClick={onEdit}
                className="h-7 w-7 sm:h-7 sm:w-7"
              >
                <Edit3 size={13} />
              </IconButton>
            )}
            <IconButton
              label={t('tables.dashboard.deleteWidgetLabel', { name: widget.title })}
              variant="destructive"
              tooltipMode="portal"
              onClick={onDelete}
              className="h-7 w-7 sm:h-7 sm:w-7"
            >
              <Trash2 size={13} />
            </IconButton>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <TableCardView
          title={widget.title}
          card={state?.card ?? null}
          result={withheld ? { kind: 'no_access' } : state?.result}
          error={state?.error}
          fields={fields}
          labels={labels}
          onDrill={onDrill}
          onOpenRecord={onOpenRecord}
          onRetry={onRetry}
        />
      </div>
    </section>
  );
}
