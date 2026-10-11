/**
 * The one place Tables structure gets deleted.
 *
 * Three targets, deliberately not three dialogs: they differ only in what is
 * at stake, and that difference is the whole point of the copy. A Base swallows
 * every table inside it, so it asks you to type its name; a table archives and
 * can be brought back by an administrator; a dashboard is configuration and
 * really goes. A table apps use answers 409 `used_by_apps` (D6): this dialog
 * closes and the references ask again ("Archive anyway" resends with `confirm`).
 */

import React, { useEffect, useState } from 'react';
import {
  archiveTableBase,
  archiveTableDefinition,
  deleteTableDashboard,
  type TableBase,
  type TableDashboard,
  type TableDefinition,
} from '../../lib/api/tables';
import { Button, Dialog, Input } from '../ui';
import { FormActions, FormError, FormField } from '../form';
import { useT } from '../../lib/i18n';
import { AppReferencesDialog, useAppReferencesGuard } from './app-references';

export type DeletionTarget =
  | { kind: 'base'; value: TableBase }
  | { kind: 'table'; value: TableDefinition }
  | { kind: 'dashboard'; value: TableDashboard };

interface DeleteDialogProps {
  target: DeletionTarget | null;
  /** How many tables the Base holds, so the warning can be specific. */
  baseTableCount?: number;
  onClose: () => void;
  onDeleted: (target: DeletionTarget) => void;
}

export function DeleteDialog({ target, baseTableCount = 0, onClose, onDeleted }: DeleteDialogProps) {
  const t = useT();
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  // Retained so the body doesn't blank out while the dialog animates closed.
  const [shown, setShown] = useState<DeletionTarget | null>(target);
  const appReferences = useAppReferencesGuard();

  useEffect(() => {
    if (target) setShown(target);
    setTyped('');
    setError('');
  }, [target]);

  const references = <AppReferencesDialog request={appReferences.request} onClose={appReferences.close} />;
  if (!shown) return references;

  const name = shown.value.name;
  const needsTypedName = shown.kind === 'base';
  const confirmed = !needsTypedName || typed.trim() === name;

  const body =
    shown.kind === 'base'
      ? t('tables.delete.baseDescription', { name, count: baseTableCount })
      : shown.kind === 'table'
        ? t('tables.delete.tableDescription', { name })
        : t('tables.delete.dashboardDescription', { name });

  const remove = async () => {
    if (!target) return;
    setDeleting(true);
    setError('');
    try {
      if (target.kind === 'table') {
        const table = target.value;
        const outcome = await appReferences.guard(
          async (confirm) => {
            await (confirm ? archiveTableDefinition(table.id, { confirm: true }) : archiveTableDefinition(table.id));
            onDeleted(target);
          },
          {
            title: t('apps.builder.references.tableTitle', { name: table.name }),
            confirmLabel: t('apps.builder.references.archiveAnyway'),
          },
        );
        // Apps use it: the references take over from here.
        if (outcome === 'asked') onClose();
        return;
      }
      if (target.kind === 'base') await archiveTableBase(target.value.id);
      else await deleteTableDashboard(target.value.id);
      onDeleted(target);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('tables.delete.failed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Dialog open={target !== null} onClose={onClose} title={t(`tables.delete.title.${shown.kind}`)} size="md">
        <div className="space-y-4">
          <p className="text-sm text-fg-secondary">{body}</p>
          {needsTypedName && (
            <FormField label={t('tables.delete.typeToConfirm', { name })}>
              <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
            </FormField>
          )}
          <FormError>{error}</FormError>
          <FormActions className="border-t border-edge pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" disabled={deleting || !confirmed} onClick={() => void remove()}>
              {deleting ? t('common.deleting') : t('common.delete')}
            </Button>
          </FormActions>
        </div>
      </Dialog>
      {references}
    </>
  );
}
