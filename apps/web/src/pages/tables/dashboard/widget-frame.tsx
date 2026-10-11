/**
 * One dashboard widget on the grid: the shared card frame (title, builder
 * actions, drag handle) around the shared card renderer.
 */

import type { TableCardPoint } from '@greenhouse/types/table-cards';
import type { TableDashboardWidget, TableField, TableRecord } from '../../../lib/api/tables';
import { TableCardFrame, TableCardView, useCardLabels } from '../../../components/table-cards';
import type { TableUsersById } from '../../../components/tables/field-value';
import { IconButton } from '../../../components/ui';
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
    <TableCardFrame
      title={widget.title}
      draggable={canBuild}
      testId={`dashboard-widget-${widget.id}`}
      actions={
        canBuild && (
          <>
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
          </>
        )
      }
    >
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
    </TableCardFrame>
  );
}
