import { useMemo } from 'react';
import { DetailHeader, DetailSection, Field, FieldGrid } from '@greenhouse/web/extension-kit';
import { Drawer, IconButton } from '@greenhouse/web/extension-kit';
import { Edit3, Eye, X } from '@greenhouse/web/extension-kit';
import type { TableField, TableRecord } from '../api';
import { formatDate } from '@greenhouse/web/extension-kit';
import { renderTableFieldValue } from './field-value';
import { useRelationLabels } from './relation-labels';
import { useT } from '@greenhouse/web/extension-kit';

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
  const linked = useMemo(() => [record], [record]);
  const relationLabel = useRelationLabels(fields, linked);
  const createdBy = usersById.get(record.created_by)?.nickname ?? record.created_by;
  const updatedBy = usersById.get(record.updated_by)?.nickname ?? record.updated_by;

  return (
    <div className="space-y-6 p-5">
      <DetailHeader
        icon={
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-primary-subtle text-primary-fg-strong">
            <Eye size={18} />
          </div>
        }
        title={t('ext.tables.tables.recordNumber', { id: record.id })}
        meta={
          <>
            <span>{tableName}</span>
            <span>{t('ext.tables.tables.revision', { revision: record.revision })}</span>
          </>
        }
        actions={
          <>
            {canEdit && (
              <IconButton label={t('ext.tables.tables.editRecord')} tooltip="top" tooltipMode="portal" onClick={onEdit}>
                <Edit3 size={15} />
              </IconButton>
            )}
            <IconButton
              label={t('ext.tables.tables.closeRecordDetails')}
              tooltip="top"
              tooltipMode="portal"
              onClick={onClose}
            >
              <X size={15} />
            </IconButton>
          </>
        }
      />

      <DetailSection title={t('ext.tables.tables.fields')}>
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
                      <span className="text-caption font-normal uppercase tracking-wide text-fg-faint">
                        {t('ext.tables.tables.computed')}
                      </span>
                    )}
                  </span>
                }
                span={field.type === 'long_text' ? 'full' : 1}
              >
                {renderTableFieldValue(field, value, usersById, relationLabel)}
              </Field>
            );
          })}
        </FieldGrid>
      </DetailSection>

      <DetailSection title={t('ext.tables.tables.recordMetadata')}>
        <FieldGrid cols={2}>
          <Field label={t('ext.tables.tables.created')} value={formatDate(record.created_at)} />
          <Field label={t('ext.tables.tables.createdBy')} value={createdBy} />
          <Field label={t('ext.tables.tables.updated')} value={formatDate(record.updated_at)} />
          <Field label={t('ext.tables.tables.updatedBy')} value={updatedBy} />
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
      ariaLabel={
        record ? t('ext.tables.tables.recordNumberDetails', { id: record.id }) : t('ext.tables.tables.recordDetails')
      }
    >
      {record && <RecordDetailContent {...props} record={record} />}
    </Drawer>
  );
}
