import { useMemo } from 'react';
import { DetailHeader, DetailSection, Field, FieldGrid } from '../../components/detail';
import { Drawer, IconButton } from '../../components/ui';
import { Edit3, Eye, X } from '../../lib/icons';
import type { TableField, TableRecord } from '../../lib/api/tables';
import { formatDate } from '../../lib/utils';
import { renderTableFieldValue } from './field-value';
import { useT } from '../../lib/i18n';

interface RecordDetailContentProps {
  tableName: string;
  record: TableRecord;
  fields: TableField[];
  users: Array<{ id: string; nickname: string; email: string }>;
  canEdit: boolean;
  onClose: () => void;
  onEdit: () => void;
}

export function RecordDetailContent({
  tableName,
  record,
  fields,
  users,
  canEdit,
  onClose,
  onEdit,
}: RecordDetailContentProps) {
  const t = useT();
  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const createdBy = usersById.get(record.created_by)?.nickname ?? record.created_by;
  const updatedBy = usersById.get(record.updated_by)?.nickname ?? record.updated_by;

  return (
    <div className="space-y-6 p-5">
      <DetailHeader
        icon={
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary-fg-strong">
            <Eye size={18} />
          </div>
        }
        title={t('tables.recordNumber', { id: record.id })}
        meta={
          <>
            <span>{tableName}</span>
            <span>{t('tables.revision', { revision: record.revision })}</span>
          </>
        }
        actions={
          <>
            {canEdit && (
              <IconButton label={t('tables.editRecord')} tooltip="top" tooltipMode="portal" onClick={onEdit}>
                <Edit3 size={15} />
              </IconButton>
            )}
            <IconButton label={t('tables.closeRecordDetails')} tooltip="top" tooltipMode="portal" onClick={onClose}>
              <X size={15} />
            </IconButton>
          </>
        }
      />

      <DetailSection title={t('tables.fields')}>
        <FieldGrid cols={2}>
          {fields.map((field) => {
            const computed = record.computed_values[String(field.id)];
            const value = computed === undefined ? record.values[String(field.id)] : computed;
            return (
              <Field
                key={field.id}
                label={
                  <span className="flex items-center gap-1.5">
                    <span>{field.name}</span>
                    {(field.type === 'formula' || field.type === 'rollup') && (
                      <span className="text-[9px] font-normal uppercase tracking-wide text-fg-faint">
                        {t('tables.computed')}
                      </span>
                    )}
                  </span>
                }
                span={field.type === 'long_text' ? 'full' : 1}
              >
                {renderTableFieldValue(field, value, usersById)}
              </Field>
            );
          })}
        </FieldGrid>
      </DetailSection>

      <DetailSection title={t('tables.recordMetadata')}>
        <FieldGrid cols={2}>
          <Field label={t('tables.created')} value={formatDate(record.created_at)} />
          <Field label={t('tables.createdBy')} value={createdBy} />
          <Field label={t('tables.updated')} value={formatDate(record.updated_at)} />
          <Field label={t('tables.updatedBy')} value={updatedBy} />
        </FieldGrid>
      </DetailSection>
    </div>
  );
}

interface RecordDetailDrawerProps extends Omit<RecordDetailContentProps, 'record'> {
  record: TableRecord | null;
}

export function RecordDetailDrawer({ record, ...props }: RecordDetailDrawerProps) {
  const t = useT();
  return (
    <Drawer
      open={record !== null}
      onClose={props.onClose}
      side="right"
      width="min(520px, calc(100vw - 2rem))"
      ariaLabel={record ? t('tables.recordNumberDetails', { id: record.id }) : t('tables.recordDetails')}
    >
      {record && <RecordDetailContent {...props} record={record} />}
    </Drawer>
  );
}
