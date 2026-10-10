import { useEffect, useState } from 'react';
import type { TableViewConfig, TableViewScope } from '@greenhouse/types/tables';
import { Button, Dialog, Input, Select } from '../../components/ui';
import { FormField } from '../../components/form';
import { useT } from '../../lib/i18n';

/**
 * Save the current query + columns as a named view. `pendingConfig` carries a
 * view-only change made on the unsaved default view (e.g. frozen columns),
 * which has nowhere to live until the view exists.
 */
export function SaveViewDialog({
  open,
  canShare,
  pendingConfig,
  onClose,
  onSave,
}: {
  open: boolean;
  /** Shared views need Base builder. */
  canShare: boolean;
  pendingConfig: Partial<TableViewConfig> | null;
  onClose: () => void;
  onSave: (name: string, scope: TableViewScope) => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<TableViewScope>('personal');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) setError('');
  }, [open]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await onSave(name.trim(), scope);
      setName('');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.saveViewFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('tables.saveCurrentView')}>
      <div className="space-y-4">
        {pendingConfig?.frozenCount !== undefined && (
          <p className="rounded-md bg-info-subtle px-3 py-2 text-xs text-info">
            {t('tables.frozenColumnsHint', { count: pendingConfig.frozenCount })}
          </p>
        )}
        <FormField label={t('common.name')}>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('tables.viewNamePlaceholder')}
          />
        </FormField>
        <FormField label={t('tables.scope')}>
          <Select value={scope} onChange={(event) => setScope(event.target.value as TableViewScope)}>
            <option value="personal">{t('tables.onlyMe')}</option>
            {canShare && <option value="shared">{t('tables.everyoneInBase')}</option>}
          </Select>
        </FormField>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-edge pt-4">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={saving || !name.trim()} onClick={() => void save()}>
            {t('tables.saveView')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
