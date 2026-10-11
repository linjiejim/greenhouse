/**
 * Settings of a saved view: rename it, switch its type (the server keeps the
 * other types' settings while they stay valid, so switching back restores
 * them), edit the type's settings, or delete it. Opened only where the server
 * would allow the change (`permissions.canChangeView`).
 */

import { useEffect, useState } from 'react';
import type { TableViewConfig, TableViewType } from '@greenhouse/types/tables';
import { Button, ConfirmDialog, Dialog, Input } from '../../../components/ui';
import { FormActions, FormError, FormField } from '../../../components/form';
import { Trash2 } from '../../../lib/icons';
import { deleteTableView, updateTableView, type TableField, type TableView } from '../../../lib/api/tables';
import { useT } from '../../../lib/i18n';
import { ViewTypeConfigFields, ViewTypePicker, viewTypeConfigProblem, withTypeDefaults } from './view-type-config';

export function ViewSettingsDialog({
  open,
  view,
  config,
  fields,
  onClose,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  view: TableView | null;
  config: TableViewConfig;
  fields: TableField[];
  onClose: () => void;
  onSaved: (view: TableView) => Promise<void> | void;
  onDeleted: (view: TableView) => Promise<void> | void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [type, setType] = useState<TableViewType>('grid');
  const [draft, setDraft] = useState<TableViewConfig>({});
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !view) return;
    setName(view.name);
    setType(view.type);
    setDraft(config);
    setError('');
  }, [open, view, config]);

  if (!view) return null;
  const problem = viewTypeConfigProblem(type, draft, fields);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const updated = await updateTableView(view.id, {
        revision: view.revision,
        ...(name.trim() !== view.name ? { name: name.trim() } : {}),
        ...(type !== view.type ? { type } : {}),
        config: draft,
      });
      await onSaved(updated);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.views.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    setError('');
    try {
      await deleteTableView(view.id);
      await onDeleted(view);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('tables.views.deleteFailed'));
    }
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} title={t('tables.views.settingsTitle')} size="md">
        <div className="space-y-4">
          <FormField label={t('common.name')} required>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </FormField>
          <div>
            <p className="mb-1.5 text-xs font-medium text-fg-secondary">{t('tables.views.typeLabel')}</p>
            <ViewTypePicker
              value={type}
              onChange={(next) => {
                setType(next);
                setDraft((current) => withTypeDefaults(next, current, fields));
              }}
            />
          </div>
          <ViewTypeConfigFields type={type} config={draft} fields={fields} onChange={setDraft} />
          {problem && <p className="text-xs text-warning">{t(problem)}</p>}
          <FormError>{error}</FormError>
          <FormActions
            className="border-t border-edge pt-4"
            leading={
              <Button variant="ghost" className="gap-1.5 text-danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={14} />
                {t('tables.views.deleteView')}
              </Button>
            }
          >
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button disabled={saving || !name.trim() || problem !== null} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </FormActions>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
        title={t('tables.views.deleteTitle', { name: view.name })}
        description={
          view.scope === 'shared'
            ? t('tables.views.deleteSharedDescription')
            : t('tables.views.deletePersonalDescription')
        }
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </>
  );
}
