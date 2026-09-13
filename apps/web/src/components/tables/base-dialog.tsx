import React, { useEffect, useState } from 'react';
import type { TableBaseVisibility } from '@greenhouse/types/tables';
import { createTableBase, updateTableBase, type TableBase } from '../../lib/api/tables';
import { Button, Dialog, Input, Select, Textarea } from '../ui';
import { useT } from '../../lib/i18n';

interface BaseDialogProps {
  open: boolean;
  /** Omit to create; pass a Base to edit it in place. */
  base?: TableBase | null;
  onClose: () => void;
  onCreated?: (baseId: number) => void;
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
          defaultTableName: t('tables.base.defaultTableName'),
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
            ? t('tables.base.saveFailed')
            : t('tables.base.createFailed'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={editing ? t('tables.base.edit') : t('tables.base.create')}>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-fg-muted">{t('common.name')}</label>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('tables.base.namePlaceholder')}
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-fg-muted">{t('common.description')}</label>
          <Textarea
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('tables.base.descriptionPlaceholder')}
          />
          <p className="mt-1 text-[11px] text-fg-faint">{t('tables.base.descriptionHint')}</p>
        </div>
        {!editing && (
          <div>
            <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.base.initialVisibility')}</label>
            <Select value={visibility} onChange={(event) => setVisibility(event.target.value as TableBaseVisibility)}>
              <option value="private">{t('tables.base.privateVisibility')}</option>
              <option value="team">{t('tables.base.teamVisibility')}</option>
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
                : t('tables.base.creating')
              : editing
                ? t('common.save')
                : t('tables.base.create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
