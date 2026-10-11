/**
 * Create / edit one dashboard widget: what it shows (KPI, chart, pivot, record
 * list, text), from which table, how it aggregates (calculation, group by with
 * an optional date bucket, a second dimension, order, limit), how a chart is
 * drawn, and which records it counts (`FilterEditor` on the card's query).
 * Saves `config.card`; the server keeps the stored type in step.
 */

import { useEffect, useState } from 'react';
import type { TableCardSpec } from '@greenhouse/types/tables';
import {
  createTableDashboardWidget,
  updateTableDashboardWidget,
  type TableDashboardWidget,
  type TableDefinition,
  type TableField,
  type TableUserOption,
} from '../../../lib/api/tables';
import { Button, Dialog } from '../../../components/ui';
import { FormActions, FormError } from '../../../components/form';
import { useT } from '../../../lib/i18n';
import { CardSettingsFields, widgetDraftCard } from './card-settings-fields';
import { draftFromCard, emptyDraft, type WidgetDraft } from './widget-draft';

interface WidgetDialogProps {
  open: boolean;
  dashboardId: number;
  /** The widget being edited, with its current card; null = a new widget. */
  editing: { widget: TableDashboardWidget; card: TableCardSpec } | null;
  tables: TableDefinition[];
  users: TableUserOption[];
  loadFields: (tableId: number) => Promise<TableField[]>;
  onClose: () => void;
  onSaved: () => void;
}

export function WidgetDialog({
  open,
  dashboardId,
  editing,
  tables,
  users,
  loadFields,
  onClose,
  onSaved,
}: WidgetDialogProps) {
  const t = useT();
  const [draft, setDraft] = useState<WidgetDraft>(() => emptyDraft(tables[0]?.id ?? ''));
  const [fields, setFields] = useState<TableField[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setDraft(
      editing
        ? draftFromCard(editing.card, editing.widget.title, editing.widget.table_id ?? tables[0]?.id ?? '')
        : emptyDraft(tables[0]?.id ?? ''),
    );
  }, [editing, open, tables]);

  useEffect(() => {
    if (!open || draft.tableId === '') {
      setFields([]);
      return;
    }
    let cancelled = false;
    void loadFields(draft.tableId)
      .then((next) => {
        if (!cancelled) setFields(next);
      })
      .catch(() => {
        if (!cancelled) setFields([]);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.tableId, loadFields, open]);

  const patch = (next: Partial<WidgetDraft>) => setDraft((current) => ({ ...current, ...next }));
  const save = async () => {
    const checked = widgetDraftCard(draft, fields);
    if (!checked.ok) return setError(t(checked.problem.key, checked.problem.params));
    const card = checked.card;
    const tableId = card.kind === 'text' ? null : card.source!.tableId;
    setSaving(true);
    setError('');
    try {
      if (editing) {
        await updateTableDashboardWidget(editing.widget.id, {
          revision: editing.widget.revision,
          title: draft.title.trim(),
          tableId,
          config: { card },
        });
      } else {
        const compact = card.kind === 'kpi' || card.kind === 'text';
        await createTableDashboardWidget(dashboardId, {
          title: draft.title.trim(),
          ...(tableId ? { tableId } : {}),
          config: { card },
          layout: { x: 0, y: 0, w: compact ? 3 : 6, h: card.kind === 'kpi' ? 3 : compact ? 2 : 4 },
        });
      }
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.dashboard.saveWidgetFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? t('tables.dashboard.editWidget') : t('tables.dashboard.addWidget')}
      size="xl"
    >
      <div className="space-y-4">
        <CardSettingsFields draft={draft} patch={patch} fields={fields} tables={tables} users={users} />

        {/* Next to Save: the dialog scrolls, and an error at the top would be out of view. */}
        <FormError>{error}</FormError>
        <FormActions>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || !draft.title.trim() || (draft.kind !== 'text' && draft.tableId === '')}
          >
            {saving ? t('common.saving') : editing ? t('tables.dashboard.saveWidget') : t('tables.dashboard.addWidget')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}
