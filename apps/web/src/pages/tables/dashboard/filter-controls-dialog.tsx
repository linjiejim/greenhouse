/**
 * Builder-side editor of a dashboard's filter controls (`config.filters`): a
 * label, a kind, and for each table of the Base the field it filters (one per
 * table here; the contract allows more for non-date kinds). Date ranges and
 * people controls may start from a default. Saved with the dashboard's
 * revision; the server checks targets against the schema.
 */

import { useEffect, useState } from 'react';
import type { TableFilterControl } from '@greenhouse/types/tables';
import {
  updateTableDashboard,
  type TableDashboard,
  type TableDefinition,
  type TableField,
} from '../../../lib/api/tables';
import { Button, Dialog } from '../../../components/ui';
import { FormActions, FormError } from '../../../components/form';
import { useT } from '../../../lib/i18n';
import { FilterControlsEditor } from './filter-controls-editor';

export function FilterControlsDialog({
  open,
  dashboard,
  tables,
  loadFields,
  onClose,
  onSaved,
}: {
  open: boolean;
  dashboard: TableDashboard;
  tables: TableDefinition[];
  loadFields: (tableId: number) => Promise<TableField[]>;
  onClose: () => void;
  onSaved: (dashboard: TableDashboard) => void;
}) {
  const t = useT();
  const [controls, setControls] = useState<TableFilterControl[]>([]);
  const [fieldsByTable, setFieldsByTable] = useState<Record<number, TableField[]>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setControls(dashboard.config?.filters ?? []);
    void Promise.all(tables.map(async (table) => [table.id, await loadFields(table.id).catch(() => [])] as const)).then(
      (entries) => setFieldsByTable(Object.fromEntries(entries)),
    );
  }, [dashboard, loadFields, open, tables]);

  const save = async () => {
    if (controls.some((control) => !control.label.trim())) return setError(t('tables.dashboard.filters.needsLabel'));
    if (controls.some((control) => control.targets.length === 0)) {
      return setError(t('tables.dashboard.filters.needsTarget'));
    }
    setSaving(true);
    setError('');
    try {
      const saved = await updateTableDashboard(dashboard.id, {
        revision: dashboard.revision,
        config: { version: 1, filters: controls.map((control) => ({ ...control, label: control.label.trim() })) },
      });
      onSaved(saved);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.dashboard.filters.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('tables.dashboard.filters.editTitle')} size="xl">
      <div className="space-y-4">
        <p className="text-xs text-fg-muted">{t('tables.dashboard.filters.intro')}</p>
        <FilterControlsEditor
          controls={controls}
          onChange={setControls}
          tables={tables}
          fieldsByTable={fieldsByTable}
        />
        {/* Next to Save: the dialog scrolls, and an error at the top would be out of view. */}
        <FormError>{error}</FormError>
        <FormActions>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? t('common.saving') : t('tables.dashboard.filters.save')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}
