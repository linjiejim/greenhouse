import React, { useEffect, useState } from 'react';
import {
  createTableDashboard,
  createTableDefinition,
  updateTableDashboard,
  updateTableDefinition,
  type TableDashboard,
  type TableDefinition,
} from '../../lib/api/tables';
import { Button, Dialog, Input, Textarea } from '../ui';
import { FormActions, FormError, FormField } from '../form';
import { useT } from '../../lib/i18n';

export type TableResource = { kind: 'table'; value: TableDefinition } | { kind: 'dashboard'; value: TableDashboard };

interface ResourceDialogProps {
  baseId: number;
  /** Create mode: which kind to create. Ignored when `resource` is set. */
  type: 'table' | 'dashboard' | null;
  /** Edit mode: the existing table or dashboard. */
  resource?: TableResource | null;
  onClose: () => void;
  onCreated?: (type: 'table' | 'dashboard', resourceId: number) => void;
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
        if (resource.kind === 'table') {
          await updateTableDefinition(resource.value.id, {
            name: name.trim(),
            description: description.trim() || null,
          });
        } else {
          await updateTableDashboard(resource.value.id, {
            revision: resource.value.revision,
            name: name.trim(),
            description: description.trim() || null,
          });
        }
        onSaved?.();
      } else {
        const resourceId =
          kind === 'table'
            ? (await createTableDefinition(baseId, { name: name.trim(), description: description.trim() || undefined }))
                .table.id
            : (await createTableDashboard(baseId, name.trim())).id;
        setName('');
        setDescription('');
        onCreated?.(kind, resourceId);
      }
    } catch (saveError) {
      const kindLabel = t(kind === 'dashboard' ? 'tables.resource.dashboardKind' : 'tables.resource.tableKind');
      setError(
        saveError instanceof Error
          ? saveError.message
          : t(editing ? 'tables.resource.unableToSave' : 'tables.resource.unableToCreate', { kind: kindLabel }),
      );
    } finally {
      setSaving(false);
    }
  };

  const title = t(
    kind === 'dashboard'
      ? editing
        ? 'tables.resource.editDashboard'
        : 'tables.resource.createDashboard'
      : editing
        ? 'tables.resource.editTable'
        : 'tables.resource.createTable',
  );

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
        {/* Dashboards get one too — a chart set benefits from "what am I looking at" just as much. */}
        <FormField
          label={t('common.description')}
          help={kind !== 'dashboard' ? t('tables.resource.tableDescriptionHelp') : undefined}
        >
          <Textarea
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={
              kind === 'dashboard'
                ? t('tables.resource.dashboardDescriptionPlaceholder')
                : t('tables.resource.tableDescriptionPlaceholder')
            }
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
