/**
 * The fields panel: which fields a view shows and in what order (grid columns,
 * card fields), plus the system columns (`created_by`, `created_at`, …). Drag
 * to reorder (the shared `useListReorder`), tick to show; Apply writes the
 * view's `fieldIds` and `systemFields` in one update.
 */

import { useEffect, useState } from 'react';
import {
  TABLE_SYSTEM_FIELDS,
  type TableSystemField,
  type TableViewConfig,
  type TableViewType,
} from '@greenhouse/types/tables';
import { Button, Checkbox, Dialog } from '../../../components/ui';
import { FormActions, FormError } from '../../../components/form';
import { FIELD_TYPE_LABEL_KEYS, SYSTEM_FIELD_LABEL_KEYS } from '../../../components/tables/field-types';
import { useListReorder } from '../../../hooks/use-list-reorder';
import { GripVertical } from '../../../lib/icons';
import type { TableField } from '../../../lib/api/tables';
import { useT } from '../../../lib/i18n';

/** Shown fields first, in the view's order; then the rest in schema order. */
function initialOrder(fields: readonly TableField[], fieldIds: readonly number[] | undefined): number[] {
  if (!fieldIds?.length) return fields.map((field) => field.id);
  const known = new Set(fields.map((field) => field.id));
  const shown = fieldIds.filter((id) => known.has(id));
  return [...shown, ...fields.map((field) => field.id).filter((id) => !shown.includes(id))];
}

export function FieldsPanel({
  open,
  type,
  fields,
  config,
  onClose,
  onApply,
}: {
  open: boolean;
  type: TableViewType;
  fields: TableField[];
  config: TableViewConfig;
  onClose: () => void;
  onApply: (patch: Pick<TableViewConfig, 'fieldIds' | 'systemFields'>) => Promise<void>;
}) {
  const t = useT();
  const [order, setOrder] = useState<number[]>([]);
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const [system, setSystem] = useState<ReadonlySet<TableSystemField>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const reorder = useListReorder(order, setOrder);
  const byId = new Map(fields.map((field) => [field.id, field]));

  useEffect(() => {
    if (!open) return;
    setOrder(initialOrder(fields, config.fieldIds));
    setShown(new Set(config.fieldIds?.length ? config.fieldIds : fields.map((field) => field.id)));
    setSystem(new Set(config.systemFields ?? []));
    setError('');
  }, [open, fields, config.fieldIds, config.systemFields]);

  const toggle = (id: number, checked: boolean) =>
    setShown((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const apply = async () => {
    setSaving(true);
    setError('');
    try {
      await onApply({
        fieldIds: order.filter((id) => shown.has(id)),
        systemFields: TABLE_SYSTEM_FIELDS.filter((field) => system.has(field)),
      });
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : t('tables.views.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const visibleCount = order.filter((id) => shown.has(id)).length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={type === 'grid' ? t('tables.views.fieldsTitle') : t('tables.views.cardFieldsTitle')}
      size="md"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-fg-faint">{t('tables.views.fieldsHint')}</p>
          <div className="flex flex-shrink-0 gap-1">
            <Button variant="ghost" size="sm" onClick={() => setShown(new Set(order))}>
              {t('tables.views.showAll')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShown(new Set(order.slice(0, 1)))}>
              {t('tables.views.hideAll')}
            </Button>
          </div>
        </div>
        <ul className="divide-y divide-edge rounded-lg border border-edge" data-testid="fields-panel-list">
          {reorder.order.map((id) => {
            const field = byId.get(id);
            if (!field) return null;
            return (
              <li
                key={id}
                {...reorder.itemProps(id)}
                data-testid={`fields-panel-row-${id}`}
                className={`flex cursor-grab select-none items-center gap-2 px-3 py-2 ${
                  reorder.draggingId === id ? 'bg-primary-subtle' : 'bg-surface-raised'
                }`}
              >
                <GripVertical size={14} className="flex-shrink-0 text-fg-faint" aria-hidden="true" />
                {/* Ticking a box is a click, never the start of a drag. */}
                <span data-no-drag="" className="min-w-0 flex-1">
                  <Checkbox
                    checked={shown.has(id)}
                    onChange={(event) => toggle(id, event.target.checked)}
                    label={<span className="truncate">{field.name}</span>}
                  />
                </span>
                <span className="flex-shrink-0 text-[11px] text-fg-faint">{t(FIELD_TYPE_LABEL_KEYS[field.type])}</span>
              </li>
            );
          })}
        </ul>
        <div>
          <p className="mb-2 text-xs font-medium text-fg-secondary">{t('tables.views.systemColumns')}</p>
          <div className="grid grid-cols-2 gap-2">
            {TABLE_SYSTEM_FIELDS.map((field) => (
              <Checkbox
                key={field}
                checked={system.has(field)}
                onChange={(event) =>
                  setSystem((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(field);
                    else next.delete(field);
                    return next;
                  })
                }
                label={t(SYSTEM_FIELD_LABEL_KEYS[field])}
              />
            ))}
          </div>
        </div>
        {visibleCount === 0 && <p className="text-xs text-warning">{t('tables.views.keepOneField')}</p>}
        <FormError>{error}</FormError>
        <FormActions className="border-t border-edge pt-4">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={saving || visibleCount === 0} onClick={() => void apply()}>
            {t('common.apply')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}
