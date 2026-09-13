import { IconButton } from '../../components/ui';
import { Edit3, Eye, Trash2 } from '../../lib/icons';
import type { TableRecord } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';

interface RecordRowActionsProps {
  record: TableRecord;
  canEdit: boolean;
  onView: (record: TableRecord) => void;
  onEdit: (record: TableRecord) => void;
  onDelete: (record: TableRecord) => void;
}

export function RecordRowActions({ record, canEdit, onView, onEdit, onDelete }: RecordRowActionsProps) {
  const t = useT();
  return (
    <div className="flex items-center gap-0.5">
      <IconButton
        label={t('tables.viewRecord')}
        tooltip="top"
        tooltipMode="portal"
        onClick={() => onView(record)}
        className="h-7 w-7 sm:h-7 sm:w-7"
      >
        <Eye size={13} />
      </IconButton>
      {canEdit && (
        <>
          <IconButton
            label={t('tables.editRecord')}
            tooltip="top"
            tooltipMode="portal"
            onClick={() => onEdit(record)}
            className="h-7 w-7 sm:h-7 sm:w-7"
          >
            <Edit3 size={13} />
          </IconButton>
          <IconButton
            label={t('tables.deleteRecord')}
            variant="destructive"
            tooltip="top"
            tooltipMode="portal"
            onClick={() => onDelete(record)}
            className="h-7 w-7 sm:h-7 sm:w-7"
          >
            <Trash2 size={13} />
          </IconButton>
        </>
      )}
    </div>
  );
}
