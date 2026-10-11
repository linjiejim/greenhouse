/**
 * Create a view: name, type (grid / kanban / calendar / gallery) with the
 * settings that type needs, who sees it, and whether it keeps the filters and
 * sort on screen. Also the "Save view" of the unsaved default view —
 * `pendingConfig` carries a view-only change made there (frozen columns,
 * grouping, a field list) that has nowhere to live until the view exists.
 */

import { useEffect, useState } from 'react';
import type { TableViewConfig, TableViewScope, TableViewType } from '@greenhouse/types/tables';
import { Button, Checkbox, Dialog, Input, Select } from '../../../components/ui';
import { FormActions, FormError, FormField } from '../../../components/form';
import type { TableField } from '../../../lib/api/tables';
import { useT } from '../../../lib/i18n';
import { ViewTypeConfigFields, ViewTypePicker, viewTypeConfigProblem, withTypeDefaults } from './view-type-config';

export interface CreateViewInput {
  name: string;
  scope: TableViewScope;
  type: TableViewType;
  /** The type's settings (and any pending view-only change). */
  config: TableViewConfig;
  /** Save the current filters, search and sort with the view. */
  keepQuery: boolean;
}

export function CreateViewDialog({
  open,
  canShare,
  fields,
  pendingConfig,
  onClose,
  onCreate,
}: {
  open: boolean;
  /** Shared views need Base builder. */
  canShare: boolean;
  fields: TableField[];
  pendingConfig: Partial<TableViewConfig> | null;
  onClose: () => void;
  onCreate: (input: CreateViewInput) => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<TableViewScope>('personal');
  const [type, setType] = useState<TableViewType>('grid');
  const [config, setConfig] = useState<TableViewConfig>({});
  const [keepQuery, setKeepQuery] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName('');
    setScope('personal');
    setType('grid');
    setConfig({ ...(pendingConfig ?? {}) });
    setKeepQuery(true);
    setError('');
  }, [open, pendingConfig]);

  const problem = viewTypeConfigProblem(type, config, fields);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await onCreate({ name: name.trim(), scope, type, config, keepQuery });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.saveViewFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={pendingConfig ? t('tables.saveCurrentView') : t('tables.views.createTitle')}
      size="md"
    >
      <div className="space-y-4">
        {pendingConfig?.frozenCount !== undefined && (
          <p className="rounded-md bg-info-subtle px-3 py-2 text-xs text-info">
            {t('tables.frozenColumnsHint', { count: pendingConfig.frozenCount })}
          </p>
        )}
        <FormField label={t('common.name')} required>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('tables.viewNamePlaceholder')}
          />
        </FormField>
        <div>
          <p className="mb-1.5 text-xs font-medium text-fg-secondary">{t('tables.views.typeLabel')}</p>
          <ViewTypePicker
            value={type}
            onChange={(next) => {
              setType(next);
              setConfig((current) => withTypeDefaults(next, current, fields));
            }}
          />
        </div>
        <ViewTypeConfigFields type={type} config={config} fields={fields} onChange={setConfig} />
        {problem && <p className="text-xs text-warning">{t(problem)}</p>}
        <FormField label={t('tables.scope')}>
          <Select value={scope} onChange={(event) => setScope(event.target.value as TableViewScope)}>
            <option value="personal">{t('tables.onlyMe')}</option>
            {canShare && <option value="shared">{t('tables.everyoneInBase')}</option>}
          </Select>
        </FormField>
        <Checkbox
          checked={keepQuery}
          onChange={(event) => setKeepQuery(event.target.checked)}
          label={t('tables.views.keepQuery')}
        />
        <FormError>{error}</FormError>
        <FormActions className="border-t border-edge pt-4">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={saving || !name.trim() || problem !== null} onClick={() => void save()}>
            {t('tables.views.create')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}
