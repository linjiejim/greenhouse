import React, { useEffect, useState } from 'react';
import type { TableRecordValues } from '@greenhouse/types/tables';
import { Button, Dialog } from '../../components/ui';
import { FormField } from '../../components/form';
import { FieldEditor, fieldEditorOwnsLabel } from '../../components/tables/field-editor';
import { recordDrafts, valuesFromDrafts, type FieldDraft } from '../../components/tables/field-draft';
import { isComputedField } from '../../components/tables/field-types';
import { FieldValue, recordFieldValue } from '../../components/tables/field-value';
import type { TableField, TableRecord, TableUserOption } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';

interface RecordDialogProps {
  open: boolean;
  baseId: number;
  fields: TableField[];
  record?: TableRecord | null;
  /** A new record's starting values (a kanban lane, a calendar day). Ignored when editing. */
  initialValues?: TableRecordValues;
  users: TableUserOption[];
  saving: boolean;
  onClose: () => void;
  onSave: (values: TableRecordValues) => Promise<void>;
}

export function RecordDialog({
  open,
  baseId,
  fields,
  record,
  initialValues,
  users,
  saving,
  onClose,
  onSave,
}: RecordDialogProps) {
  const t = useT();
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>({});
  const [error, setError] = useState('');
  const usersById = React.useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

  useEffect(() => {
    if (!open) return;
    setDrafts(recordDrafts(fields, record ?? (initialValues ? { values: initialValues } : null)));
    setError('');
  }, [fields, open, record, initialValues]);

  const submit = async () => {
    setError('');
    try {
      await onSave(valuesFromDrafts(fields, drafts, record ? 'update' : 'create'));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.saveRecordFailed'));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={record ? t('tables.editRecordNumber', { id: record.id }) : t('tables.newRecord')}
      size="lg"
    >
      <div className="space-y-4">
        {fields.map((field) => {
          if (isComputedField(field)) {
            return (
              <div key={field.id}>
                <p className="mb-1.5 block text-xs font-medium text-fg-secondary">{field.name}</p>
                <div className="rounded-md border border-edge bg-surface-sunken px-3 py-2 text-sm text-fg-secondary">
                  <FieldValue
                    field={field}
                    value={record ? recordFieldValue(record, field.id) : undefined}
                    usersById={usersById}
                  />
                </div>
                <p className="mt-1 text-[11px] text-fg-faint">{t('tables.computedReadOnly')}</p>
              </div>
            );
          }
          const editor = (
            <FieldEditor
              field={field}
              value={drafts[String(field.id)] ?? ''}
              onChange={(next) => setDrafts((current) => ({ ...current, [String(field.id)]: next }))}
              users={users}
              baseId={baseId}
            />
          );
          if (fieldEditorOwnsLabel(field)) return <div key={field.id}>{editor}</div>;
          return (
            <FormField key={field.id} label={field.name} required={field.required}>
              {editor}
            </FormField>
          );
        })}

        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex items-center justify-between border-t border-edge pt-4">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? t('common.saving') : t('tables.saveRecord')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
