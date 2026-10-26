import React, { useEffect, useState } from 'react';
import type { TableBaseVisibility } from '@greenhouse/types/tables';
import { createTableBase, updateTableBase, type TableBase } from '../api';
import { Button, Dialog, Input, Select, Textarea } from '@greenhouse/web/extension-kit';
import { useT } from '@greenhouse/web/extension-kit';

interface BaseDialogProps {
  open: boolean;
  /** Omit to create; pass a Base to edit it in place. */
  base?: TableBase | null;
  onClose: () => void;
  onCreated?: (baseId: string) => void;
  onSaved?: (base: TableBase) => void;
}

/**
 * Create or edit a Base. Visibility is only offered at creation time — changing
 * it later belongs with the member list in the Share dialog, where you can see
 * who it would affect.
 */
export function BaseDialog({ open, base = null, onClose, onCreated, onSaved }: BaseDialogProps) {
  const t = useT();
  const editing = base !== null;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<TableBaseVisibility>('private');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(base?.name ?? '');
    setDescription(base?.description ?? '');
    setVisibility(base?.visibility ?? 'private');
    setError('');
  }, [base, open]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError('');
    try {
      if (base) {
        const saved = await updateTableBase(base.id, {
          name: name.trim(),
          description: description.trim() || null,
        });
        onSaved?.(saved);
      } else {
        const result = await createTableBase({
          name: name.trim(),
          description: description.trim() || undefined,
          visibility,
          defaultTableName: t('ext.tables.tables.base.defaultTableName'),
        });
        setName('');
        setDescription('');
        onCreated?.(result.base.id);
      }
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : editing
            ? t('ext.tables.tables.base.saveFailed')
            : t('ext.tables.tables.base.createFailed'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? t('ext.tables.tables.base.edit') : t('ext.tables.tables.base.create')}
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-fg-muted">{t('common.name')}</label>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('ext.tables.tables.base.namePlaceholder')}
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-fg-muted">{t('common.description')}</label>
          <Textarea
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('ext.tables.tables.base.descriptionPlaceholder')}
          />
          <p className="mt-1 text-caption text-fg-faint">{t('ext.tables.tables.base.descriptionHint')}</p>
        </div>
        {!editing && (
          <div>
            <label className="mb-1 block text-xs font-medium text-fg-muted">
              {t('ext.tables.tables.base.initialVisibility')}
            </label>
            <Select value={visibility} onChange={(event) => setVisibility(event.target.value as TableBaseVisibility)}>
              <option value="private">{t('ext.tables.tables.base.privateVisibility')}</option>
              <option value="team">{t('ext.tables.tables.base.teamVisibility')}</option>
            </Select>
          </div>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-edge pt-4">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={saving || !name.trim()} onClick={() => void save()}>
            {saving
              ? editing
                ? t('common.saving')
                : t('ext.tables.tables.base.creating')
              : editing
                ? t('common.save')
                : t('ext.tables.tables.base.create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
