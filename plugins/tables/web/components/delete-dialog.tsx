/**
 * The one place Tables structure gets deleted.
 *
 * Two targets, deliberately not two dialogs: they differ only in what is at
 * stake, and that difference is the whole point of the copy. A Base swallows
 * every table inside it, so it asks you to type its name; a table archives and
 * can be brought back by an administrator.
 */

import React, { useEffect, useState } from 'react';
import { archiveTableBase, archiveTableDefinition, type TableBase, type TableDefinition } from '../api';
import { Button, Dialog, Input } from '@greenhouse/web/extension-kit';
import { FormActions, FormError, FormField } from '@greenhouse/web/extension-kit';
import { useT } from '@greenhouse/web/extension-kit';

export type DeletionTarget = { kind: 'base'; value: TableBase } | { kind: 'table'; value: TableDefinition };

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

  useEffect(() => {
    if (target) setShown(target);
    setTyped('');
    setError('');
  }, [target]);

  if (!shown) return null;

  const name = shown.value.name;
  const needsTypedName = shown.kind === 'base';
  const confirmed = !needsTypedName || typed.trim() === name;

  const body =
    shown.kind === 'base'
      ? t('ext.tables.tables.delete.baseDescription', { name, count: baseTableCount })
      : t('ext.tables.tables.delete.tableDescription', { name });

  const remove = async () => {
    if (!target) return;
    setDeleting(true);
    setError('');
    try {
      if (target.kind === 'base') await archiveTableBase(target.value.id);
      else await archiveTableDefinition(target.value.id);
      onDeleted(target);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('ext.tables.tables.delete.failed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={t(`ext.tables.tables.delete.title.${shown.kind}`)}
      size="md"
    >
      <div className="space-y-4">
        <p className="text-sm text-fg-secondary">{body}</p>
        {needsTypedName && (
          <FormField label={t('ext.tables.tables.delete.typeToConfirm', { name })}>
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
  );
}
