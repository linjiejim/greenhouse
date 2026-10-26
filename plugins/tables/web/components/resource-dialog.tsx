import React, { useEffect, useState } from 'react';
import { createTableDefinition, updateTableDefinition, type TableDefinition } from '../api';
import { Button, Dialog, Input, Textarea } from '@greenhouse/web/extension-kit';
import { FormActions, FormError, FormField } from '@greenhouse/web/extension-kit';
import { useT } from '@greenhouse/web/extension-kit';

export type TableResource = { kind: 'table'; value: TableDefinition };

interface ResourceDialogProps {
  baseId: string;
  /** Create mode: open the dialog to create a table. Ignored when `resource` is set. */
  type: 'table' | null;
  /** Edit mode: the existing table. */
  resource?: TableResource | null;
  onClose: () => void;
  onCreated?: (type: 'table', resourceId: string) => void;
  onSaved?: () => void;
}

export function ResourceDialog({ baseId, type, resource = null, onClose, onCreated, onSaved }: ResourceDialogProps) {
  const t = useT();
  const kind = resource?.kind ?? type;
  const editing = resource !== null;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!kind) return;
    setName(resource?.value.name ?? '');
    setDescription(resource?.value.description ?? '');
    setError('');
  }, [kind, resource]);

  const save = async () => {
    if (!kind || !name.trim()) return;
    setSaving(true);
    setError('');
    try {
      if (resource) {
        await updateTableDefinition(resource.value.id, {
          name: name.trim(),
          description: description.trim() || null,
        });
        onSaved?.();
      } else {
        const resourceId = (
          await createTableDefinition(baseId, { name: name.trim(), description: description.trim() || undefined })
        ).table.id;
        setName('');
        setDescription('');
        onCreated?.(kind, resourceId);
      }
    } catch (saveError) {
      const kindLabel = t('ext.tables.tables.resource.tableKind');
      setError(
        saveError instanceof Error
          ? saveError.message
          : t(editing ? 'ext.tables.tables.resource.unableToSave' : 'ext.tables.tables.resource.unableToCreate', {
              kind: kindLabel,
            }),
      );
    } finally {
      setSaving(false);
    }
  };

  const title = t(editing ? 'ext.tables.tables.resource.editTable' : 'ext.tables.tables.resource.createTable');

  return (
    <Dialog open={kind !== null} onClose={onClose} title={title}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <FormField label={t('common.name')} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </FormField>
        <FormField label={t('common.description')} help={t('ext.tables.tables.resource.tableDescriptionHelp')}>
          <Textarea
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('ext.tables.tables.resource.tableDescriptionPlaceholder')}
          />
        </FormField>
        <FormError>{error}</FormError>
        <FormActions className="border-t border-edge pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={saving || !name.trim()}>
            {saving ? t('common.saving') : editing ? t('common.save') : t('common.create')}
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
