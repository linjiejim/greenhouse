/**
 * Create / edit one dashboard widget: what it shows (KPI, chart, pivot, record
 * list, text), from which table, how it aggregates (calculation, group by with
 * an optional date bucket, a second dimension, order, limit), how a chart is
 * drawn, and which records it counts (`FilterEditor` on the card's query).
 * Saves `config.card`; the server keeps the stored type in step.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  normalizeTableCardSpec,
  TABLE_CARD_LIMITS,
  TABLE_CARD_CHART_TYPES,
  TABLE_CARD_KINDS,
  TABLE_CARD_SORTS,
  type TableCardKind,
} from '@greenhouse/types/table-cards';
import {
  TABLE_AGGREGATIONS,
  TABLE_DATE_BUCKETS,
  TABLE_SYSTEM_FIELDS,
  type TableAggregation,
  type TableCardSpec,
  type TableDateBucket,
  type TableFieldType,
} from '@greenhouse/types/tables';
import {
  createTableDashboardWidget,
  updateTableDashboardWidget,
  type TableDashboardWidget,
  type TableDefinition,
  type TableField,
  type TableUserOption,
} from '../../../lib/api/tables';
import { Button, Checkbox, Dialog, Input, Select, Textarea } from '../../../components/ui';
import { FormActions, FormError, FormField, FormGrid, FormGroup, FormSection } from '../../../components/form';
import { FilterEditor, completedFilterGroup } from '../../../components/tables';
import { filterValueType } from '../../../components/tables/filter-model';
import { SYSTEM_FIELD_LABEL_KEYS } from '../../../components/tables/field-types';
import { useT, type TranslationKey } from '../../../lib/i18n';
import { cardFromDraft, draftFromCard, emptyDraft, refFromKey, type WidgetDraft } from './widget-draft';

const AGGREGATION_LABEL_KEYS: Record<TableAggregation, TranslationKey> = {
  count: 'tables.aggregationType.count',
  sum: 'tables.aggregationType.sum',
  avg: 'tables.aggregationType.avg',
  min: 'tables.aggregationType.min',
  max: 'tables.aggregationType.max',
};

/** Field types a card can group or split by (one value per record, or a short list). */
const GROUPABLE: ReadonlySet<TableFieldType> = new Set([
  'text',
  'number',
  'boolean',
  'date',
  'datetime',
  'single_select',
  'multi_select',
  'user',
  'multi_user',
  'url',
  'email',
  'phone',
]);

const DATE_TYPES: ReadonlySet<TableFieldType> = new Set(['date', 'datetime']);

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
  const numericFields = useMemo(() => fields.filter((field) => filterValueType(field) === 'number'), [fields]);
  const groupFields = useMemo(() => fields.filter((field) => GROUPABLE.has(filterValueType(field))), [fields]);
  const groupRef = refFromKey(draft.groupBy);
  const groupIsDate = groupRef?.systemField
    ? groupRef.systemField === 'created_at' || groupRef.systemField === 'updated_at'
    : DATE_TYPES.has(
        filterValueType(fields.find((field) => field.id === groupRef?.fieldId) ?? { type: 'text', config: '{}' }),
      );
  const isPie = draft.kind === 'chart' && draft.chartType === 'pie';
  const aggregates = draft.kind === 'kpi' || draft.kind === 'chart' || draft.kind === 'pivot';
  const grouped = draft.kind === 'chart' || draft.kind === 'pivot';

  const dimensionOptions = (exclude?: string) => (
    <>
      {groupFields.map((field) =>
        `f:${field.id}` === exclude ? null : (
          <option key={field.id} value={`f:${field.id}`}>
            {field.name}
          </option>
        ),
      )}
      {TABLE_SYSTEM_FIELDS.map((field) =>
        `s:${field}` === exclude ? null : (
          <option key={field} value={`s:${field}`}>
            {t(SYSTEM_FIELD_LABEL_KEYS[field])}
          </option>
        ),
      )}
    </>
  );

  const save = async () => {
    const { group: where, incompleteIndex } = completedFilterGroup(draft.where, fields);
    if (incompleteIndex !== null) return setError(t('tables.dashboard.editor.incomplete'));
    if (draft.kind === 'pivot' && !draft.groupBy) return setError(t('tables.dashboard.editor.needsGroup'));
    if (aggregates && draft.operation !== 'count' && !draft.valueFieldId) {
      return setError(t('tables.dashboard.editor.needsValueField'));
    }
    // Typed numbers are not held to the inputs' min / max: check them here, in words.
    const outside = (value: number | '', max: number) =>
      value !== '' && (!Number.isInteger(value) || value < 1 || value > max);
    if (grouped && draft.groupBy && outside(draft.limit, TABLE_CARD_LIMITS.groups)) {
      return setError(t('tables.dashboard.editor.limitRange', { max: TABLE_CARD_LIMITS.groups }));
    }
    if (draft.kind === 'records' && outside(draft.rows, TABLE_CARD_LIMITS.records)) {
      return setError(t('tables.dashboard.editor.rowsRange', { max: TABLE_CARD_LIMITS.records }));
    }
    const normalized = normalizeTableCardSpec(cardFromDraft(draft, where));
    // Anything left is the contract's text (paths like `aggregate.limit`), meant for the API.
    if (!normalized.ok) return setError(t('tables.dashboard.editor.invalid'));
    const card = normalized.card;
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
        <FormGrid>
          <FormField label={t('tables.dashboard.widgetTitle')}>
            <Input value={draft.title} onChange={(event) => patch({ title: event.target.value })} />
          </FormField>
          <FormField label={t('tables.dashboard.widgetTypeLabel')}>
            <Select value={draft.kind} onChange={(event) => patch({ kind: event.target.value as TableCardKind })}>
              {TABLE_CARD_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`tables.dashboard.editor.kind.${kind}`)}
                </option>
              ))}
            </Select>
          </FormField>
          {draft.kind !== 'text' && (
            <FormField label={t('tables.dashboard.editor.source')}>
              <Select
                value={draft.tableId}
                onChange={(event) =>
                  // Another table: its fields differ, so field-bound settings start over.
                  patch({
                    ...emptyDraft(Number(event.target.value)),
                    title: draft.title,
                    kind: draft.kind,
                    chartType: draft.chartType,
                  })
                }
              >
                {tables.map((table) => (
                  <option key={table.id} value={table.id}>
                    {table.name}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
          {draft.kind === 'chart' && (
            <FormField label={t('tables.dashboard.editor.chartType')}>
              <Select
                value={draft.chartType}
                onChange={(event) => patch({ chartType: event.target.value as WidgetDraft['chartType'] })}
              >
                {TABLE_CARD_CHART_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`tables.dashboard.editor.chart.${type}`)}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </FormGrid>

        {draft.kind === 'text' && (
          <FormField label={t('tables.dashboard.editor.markdown')}>
            <Textarea rows={10} value={draft.markdown} onChange={(event) => patch({ markdown: event.target.value })} />
          </FormField>
        )}

        {aggregates && (
          <FormSection>
            <FormGrid>
              <FormField label={t('tables.dashboard.editor.aggregation')}>
                <Select
                  value={draft.operation}
                  onChange={(event) => patch({ operation: event.target.value as TableAggregation })}
                >
                  {TABLE_AGGREGATIONS.map((operation) => (
                    <option key={operation} value={operation}>
                      {t(AGGREGATION_LABEL_KEYS[operation])}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label={t('tables.dashboard.valueField')}>
                <Select
                  value={draft.valueFieldId}
                  disabled={draft.operation === 'count'}
                  onChange={(event) => patch({ valueFieldId: event.target.value ? Number(event.target.value) : '' })}
                >
                  <option value="">—</option>
                  {numericFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name}
                    </option>
                  ))}
                </Select>
              </FormField>
              {grouped && (
                <FormField label={t('tables.dashboard.groupBy')}>
                  <Select
                    value={draft.groupBy}
                    onChange={(event) => patch({ groupBy: event.target.value, dateBucket: '', series: '' })}
                  >
                    <option value="">{t('tables.dashboard.noGrouping')}</option>
                    {dimensionOptions()}
                  </Select>
                </FormField>
              )}
              {grouped && groupIsDate && (
                <FormField label={t('tables.dashboard.editor.dateBucket')}>
                  <Select
                    value={draft.dateBucket}
                    onChange={(event) => patch({ dateBucket: event.target.value as TableDateBucket | '' })}
                  >
                    <option value="">{t('tables.dashboard.editor.bucket.exact')}</option>
                    {TABLE_DATE_BUCKETS.map((bucket) => (
                      <option key={bucket} value={bucket}>
                        {t(`tables.dashboard.editor.bucket.${bucket}`)}
                      </option>
                    ))}
                  </Select>
                </FormField>
              )}
              {grouped && !isPie && draft.groupBy && (
                <FormField
                  label={t('tables.dashboard.editor.series')}
                  help={draft.kind === 'pivot' ? t('tables.dashboard.editor.pivotHint') : undefined}
                >
                  <Select value={draft.series} onChange={(event) => patch({ series: event.target.value })}>
                    <option value="">{t('tables.dashboard.editor.noSeries')}</option>
                    {dimensionOptions(draft.groupBy)}
                  </Select>
                </FormField>
              )}
              {grouped && draft.groupBy && (
                <FormField label={t('tables.dashboard.editor.sortLabel')}>
                  <Select
                    value={draft.sort}
                    onChange={(event) => patch({ sort: event.target.value as WidgetDraft['sort'] })}
                  >
                    <option value="">—</option>
                    {TABLE_CARD_SORTS.map((sort) => (
                      <option key={sort} value={sort}>
                        {t(`tables.dashboard.editor.sort.${sort}`)}
                      </option>
                    ))}
                  </Select>
                </FormField>
              )}
              {grouped && draft.groupBy && (
                <FormField label={t('tables.dashboard.editor.limit')}>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={draft.limit}
                    onChange={(event) => patch({ limit: event.target.value ? Number(event.target.value) : '' })}
                  />
                </FormField>
              )}
            </FormGrid>
            {draft.kind === 'chart' && (
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                {!isPie && draft.series && (
                  <Checkbox
                    checked={draft.stacked}
                    onChange={(event) => patch({ stacked: event.target.checked })}
                    label={t('tables.dashboard.editor.stacked')}
                  />
                )}
                {draft.chartType === 'bar' && (
                  <Checkbox
                    checked={draft.horizontal}
                    onChange={(event) => patch({ horizontal: event.target.checked })}
                    label={t('tables.dashboard.editor.horizontal')}
                  />
                )}
                {isPie && (
                  <Checkbox
                    checked={draft.donut}
                    onChange={(event) => patch({ donut: event.target.checked })}
                    label={t('tables.dashboard.editor.donut')}
                  />
                )}
                <Checkbox
                  checked={draft.showValues}
                  onChange={(event) => patch({ showValues: event.target.checked })}
                  label={t('tables.dashboard.editor.showValues')}
                />
              </div>
            )}
          </FormSection>
        )}

        {draft.kind === 'records' && (
          <FormSection>
            <FormGroup label={t('tables.dashboard.editor.columns')}>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {fields.map((field) => (
                  <Checkbox
                    key={field.id}
                    label={field.name}
                    checked={draft.fieldIds.includes(field.id)}
                    onChange={(event) =>
                      patch({
                        fieldIds: event.target.checked
                          ? [...draft.fieldIds, field.id]
                          : draft.fieldIds.filter((id) => id !== field.id),
                      })
                    }
                  />
                ))}
                {TABLE_SYSTEM_FIELDS.map((field) => (
                  <Checkbox
                    key={field}
                    label={t(SYSTEM_FIELD_LABEL_KEYS[field])}
                    checked={draft.systemFields.includes(field)}
                    onChange={(event) =>
                      patch({
                        systemFields: event.target.checked
                          ? [...draft.systemFields, field]
                          : draft.systemFields.filter((entry) => entry !== field),
                      })
                    }
                  />
                ))}
              </div>
            </FormGroup>
            <FormGrid className="mt-3">
              <FormField label={t('tables.dashboard.editor.rowsPerPage')}>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={draft.rows}
                  onChange={(event) => patch({ rows: event.target.value ? Number(event.target.value) : '' })}
                />
              </FormField>
            </FormGrid>
          </FormSection>
        )}

        {draft.kind !== 'text' && (
          <FormSection title={t('tables.dashboard.editor.conditions')}>
            <FilterEditor value={draft.where} onChange={(where) => patch({ where })} fields={fields} users={users} />
          </FormSection>
        )}

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
