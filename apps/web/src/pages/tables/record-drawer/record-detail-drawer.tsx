/**
 * A record's read-only detail: sticky header (title, edit/close, slot actions)
 * over a tabbed body that is the only part that scrolls. Editing opens the
 * record dialog from the container; the drawer stays a read context.
 *
 * Tabs and header actions beyond Fields come from ./activity-slot and
 * ./actions-slot (see ./slots) — slices fill those files, never this one.
 */

import { useMemo, useState } from 'react';
import { DetailHeader, DetailSection, Field, FieldGrid } from '../../../components/detail';
import { Drawer, IconButton, Tabs } from '../../../components/ui';
import { FieldValue, recordFieldValue } from '../../../components/tables/field-value';
import { isComputedField } from '../../../components/tables/field-types';
import { Edit3, Eye, X } from '../../../lib/icons';
import { formatDate } from '../../../lib/utils';
import { useT } from '../../../lib/i18n';
import { RECORD_ACTIVITY_TAB } from './activity-slot';
import { RecordActionsSlot } from './actions-slot';
import type { RecordDrawerSlotProps, RecordDrawerTab } from './slots';

interface RecordDetailContentProps extends RecordDrawerSlotProps {
  /** Absent when the host frame has its own close (the entity peek). */
  onClose?: () => void;
  onEdit: () => void;
}

const FIELDS_TAB = 'fields';

function FieldsPanel({ record, fields, usersById }: RecordDrawerSlotProps) {
  const t = useT();
  const createdBy = usersById.get(record.created_by)?.nickname ?? record.created_by;
  const updatedBy = usersById.get(record.updated_by)?.nickname ?? record.updated_by;
  return (
    <div className="space-y-6">
      <DetailSection title={t('tables.fields')}>
        <FieldGrid cols={2}>
          {fields.map((field) => (
            <Field
              key={field.id}
              label={
                <span className="flex items-center gap-1.5">
                  <span>{field.name}</span>
                  {isComputedField(field) && (
                    <span className="text-[9px] font-normal uppercase tracking-wide text-fg-faint">
                      {t('tables.computed')}
                    </span>
                  )}
                </span>
              }
              span={field.type === 'long_text' ? 'full' : 1}
            >
              <FieldValue field={field} value={recordFieldValue(record, field.id)} usersById={usersById} />
            </Field>
          ))}
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

const SLOT_TABS: RecordDrawerTab[] = [RECORD_ACTIVITY_TAB].filter((tab): tab is RecordDrawerTab => tab !== null);

export function RecordDetailContent({ onClose, onEdit, ...slot }: RecordDetailContentProps) {
  const t = useT();
  const [active, setActive] = useState(FIELDS_TAB);
  const tabs = useMemo(
    () => [
      { key: FIELDS_TAB, label: t('tables.fields') },
      ...SLOT_TABS.map((tab) => ({ key: tab.key, label: t(tab.labelKey) })),
    ],
    [t],
  );
  const slotTab = SLOT_TABS.find((tab) => tab.key === active);
  const { record, table, canEdit } = slot;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-shrink-0 space-y-3 border-b border-edge px-5 pb-3 pt-5">
        <DetailHeader
          icon={
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary-fg-strong">
              <Eye size={18} />
            </div>
          }
          title={t('tables.recordNumber', { id: record.id })}
          meta={
            <>
              <span>{table.name}</span>
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
              {onClose && (
                <IconButton label={t('tables.closeRecordDetails')} tooltip="top" tooltipMode="portal" onClick={onClose}>
                  <X size={15} />
                </IconButton>
              )}
            </>
          }
        />
        {RecordActionsSlot && <RecordActionsSlot {...slot} />}
        {tabs.length > 1 && (
          <Tabs tabs={tabs} active={active} onChange={setActive} ariaLabel={t('tables.recordSections')} />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {slotTab ? <slotTab.Panel {...slot} /> : <FieldsPanel {...slot} />}
      </div>
    </div>
  );
}

interface RecordDetailDrawerProps extends Omit<RecordDetailContentProps, 'record' | 'onClose'> {
  record: RecordDetailContentProps['record'] | null;
  onClose: () => void;
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
      {/* Keyed by record so a newly opened record starts on its Fields tab. */}
      {record && <RecordDetailContent key={record.id} {...props} record={record} />}
    </Drawer>
  );
}
