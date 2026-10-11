/**
 * Builder-side editor of a dashboard's filter controls (`config.filters`): a
 * label, a kind, and for each table of the Base the field it filters (one per
 * table here; the contract allows more for non-date kinds). Date ranges and
 * people controls may start from a default. Saved with the dashboard's
 * revision; the server checks targets against the schema.
 */

import { useEffect, useState } from 'react';
import { ME_TOKEN } from '@greenhouse/types/date-tokens';
import { TABLE_CARD_LIMITS, TABLE_DATE_RANGE_PRESETS, TABLE_FILTER_CONTROL_KINDS } from '@greenhouse/types/table-cards';
import type {
  TableDateRangePreset,
  TableFieldType,
  TableFilterControl,
  TableFilterControlKind,
  TableSystemField,
} from '@greenhouse/types/tables';
import {
  updateTableDashboard,
  type TableDashboard,
  type TableDefinition,
  type TableField,
} from '../../../lib/api/tables';
import { Button, Dialog, IconButton, Input, Select } from '../../../components/ui';
import { FormActions, FormError, FormField, FormGrid } from '../../../components/form';
import { filterValueType } from '../../../components/tables/filter-model';
import { SYSTEM_FIELD_LABEL_KEYS } from '../../../components/tables/field-types';
import { useT } from '../../../lib/i18n';
import { Plus, Trash2 } from '../../../lib/icons';

const KIND_FIELD_TYPES: Record<TableFilterControlKind, ReadonlySet<TableFieldType>> = {
  date_range: new Set(['date', 'datetime']),
  select: new Set(['single_select', 'multi_select']),
  user: new Set(['user', 'multi_user']),
  search: new Set(['text', 'long_text', 'url', 'email', 'phone']),
};

const KIND_SYSTEM_FIELDS: Record<TableFilterControlKind, readonly TableSystemField[]> = {
  date_range: ['created_at', 'updated_at'],
  select: [],
  user: ['created_by', 'updated_by'],
  search: [],
};

function targetKey(control: TableFilterControl, tableId: number): string {
  const target = control.targets.find((entry) => entry.tableId === tableId);
  if (!target) return '';
  return target.systemField ? `s:${target.systemField}` : `f:${target.fieldId}`;
}

function withTarget(control: TableFilterControl, tableId: number, key: string): TableFilterControl {
  const others = control.targets.filter((target) => target.tableId !== tableId);
  if (!key) return { ...control, targets: others };
  const target = key.startsWith('s:')
    ? { tableId, systemField: key.slice(2) as TableSystemField }
    : { tableId, fieldId: Number(key.slice(2)) };
  return { ...control, targets: [...others, target] };
}

function newControlId(): string {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

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

  const update = (index: number, next: TableFilterControl) =>
    setControls((current) => current.map((control, position) => (position === index ? next : control)));

  const add = () =>
    setControls((current) => [
      ...current,
      {
        id: newControlId(),
        label: t('tables.dashboard.filters.newLabel', { n: current.length + 1 }),
        kind: 'date_range',
        targets: [],
      },
    ]);

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
        <FormError>{error}</FormError>
        {controls.length === 0 && <p className="text-xs text-fg-faint">{t('tables.dashboard.filters.empty')}</p>}
        {controls.map((control, index) => (
          <section key={control.id} className="space-y-3 rounded-lg border border-edge p-3">
            <div className="flex items-start gap-2">
              <FormGrid className="flex-1">
                <FormField label={t('tables.dashboard.filters.label')}>
                  <Input
                    value={control.label}
                    maxLength={TABLE_CARD_LIMITS.label}
                    onChange={(event) => update(index, { ...control, label: event.target.value })}
                  />
                </FormField>
                <FormField label={t('tables.dashboard.filters.kind')}>
                  <Select
                    value={control.kind}
                    onChange={(event) =>
                      // Targets and defaults are kind-specific: start over.
                      update(index, {
                        id: control.id,
                        label: control.label,
                        kind: event.target.value as TableFilterControlKind,
                        targets: [],
                      })
                    }
                  >
                    {TABLE_FILTER_CONTROL_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(`tables.dashboard.filters.kinds.${kind}`)}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </FormGrid>
              <IconButton
                label={t('tables.dashboard.filters.remove', { name: control.label })}
                variant="destructive"
                onClick={() => setControls((current) => current.filter((_, position) => position !== index))}
                className="mt-6 h-8 w-8 sm:h-8 sm:w-8"
              >
                <Trash2 size={13} />
              </IconButton>
            </div>
            <FormGrid columns={3}>
              {tables.map((table) => {
                const candidates = (fieldsByTable[table.id] ?? []).filter((field) =>
                  KIND_FIELD_TYPES[control.kind].has(filterValueType(field)),
                );
                return (
                  <FormField key={table.id} label={table.name}>
                    <Select
                      size="sm"
                      value={targetKey(control, table.id)}
                      onChange={(event) => update(index, withTarget(control, table.id, event.target.value))}
                    >
                      <option value="">{t('tables.dashboard.filters.notOnTable')}</option>
                      {candidates.map((field) => (
                        <option key={field.id} value={`f:${field.id}`}>
                          {field.name}
                        </option>
                      ))}
                      {KIND_SYSTEM_FIELDS[control.kind].map((field) => (
                        <option key={field} value={`s:${field}`}>
                          {t(SYSTEM_FIELD_LABEL_KEYS[field])}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                );
              })}
            </FormGrid>
            {control.kind === 'date_range' && (
              <FormGrid>
                <FormField label={t('tables.dashboard.filters.default')}>
                  <Select
                    size="sm"
                    value={control.defaultValue?.kind === 'date_range' ? (control.defaultValue.preset ?? '') : ''}
                    onChange={(event) =>
                      update(index, {
                        ...control,
                        defaultValue: event.target.value
                          ? { kind: 'date_range', preset: event.target.value as TableDateRangePreset }
                          : undefined,
                      })
                    }
                  >
                    <option value="">{t('tables.dashboard.filters.allTime')}</option>
                    {TABLE_DATE_RANGE_PRESETS.map((preset) => (
                      <option key={preset} value={preset}>
                        {t(`tables.dashboard.filters.preset.${preset}`)}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </FormGrid>
            )}
            {control.kind === 'user' && (
              <FormGrid>
                <FormField label={t('tables.dashboard.filters.default')}>
                  <Select
                    size="sm"
                    value={control.defaultValue?.kind === 'user' ? (control.defaultValue.userIds[0] ?? '') : ''}
                    onChange={(event) =>
                      update(index, {
                        ...control,
                        defaultValue: event.target.value ? { kind: 'user', userIds: [event.target.value] } : undefined,
                      })
                    }
                  >
                    <option value="">{t('tables.dashboard.filters.anyone')}</option>
                    <option value={ME_TOKEN}>{t('tables.dashboard.filters.me')}</option>
                  </Select>
                </FormField>
              </FormGrid>
            )}
          </section>
        ))}
        {controls.length < TABLE_CARD_LIMITS.controls && (
          <Button variant="outline" size="sm" onClick={add} className="gap-1">
            <Plus size={12} />
            {t('tables.dashboard.filters.add')}
          </Button>
        )}
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
