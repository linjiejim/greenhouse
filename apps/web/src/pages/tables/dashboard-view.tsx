import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TABLE_AGGREGATIONS,
  TABLE_DASHBOARD_WIDGET_TYPES,
  type TableAggregation,
  type TableBaseRole,
  type TableDashboardWidgetConfig,
  type TableDashboardWidgetLayout,
  type TableDashboardWidgetType,
} from '@greenhouse/types/tables';
import {
  createTableDashboardWidget,
  deleteTableDashboardWidget,
  getTableDashboard,
  getTableSchema,
  queryTableDashboardWidget,
  updateTableDashboardWidget,
  type TableDashboard,
  type TableDashboardWidget,
  type TableDefinition,
  type TableField,
  type TableRecordPage,
} from '../../lib/api/tables';
import { ChartBlock } from '../../components/blocks/chart-block';
import type { ChartData } from '../../components/blocks';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  Select,
  Spinner,
  Textarea,
} from '../../components/ui';
import { WidgetGrid, WIDGET_DRAG_HANDLE_CLASS, type WidgetGridItem } from '../../components/workbench/widget-grid';
import { BarChart3, Edit3, Plus, Trash2 } from '../../lib/icons';
import { safeParse } from '../../lib/utils';
import { useT, type TranslationKey } from '../../lib/i18n';

interface TablesDashboardViewProps {
  dashboardId: number;
  tables: TableDefinition[];
  role: TableBaseRole;
}

type WidgetResult = {
  widget: TableDashboardWidget;
  text?: string;
  rows?: Array<{ group: string | number | boolean | null; value: number }>;
  records?: TableRecordPage;
};

const ROLE_RANK: Record<TableBaseRole, number> = { viewer: 0, editor: 1, builder: 2, owner: 3 };
/**
 * Twelve columns, matching the Home workbench. The stored layouts were written
 * against a 12-column mental model (`w:6` = half width), so they land sensibly
 * here, and both dashboards now speak the same grid vocabulary.
 */
const DASHBOARD_COLUMNS = 12;
const WIDGET_LABEL_KEYS: Record<TableDashboardWidgetType, TranslationKey> = {
  kpi: 'tables.dashboard.widgetType.kpi',
  bar: 'tables.dashboard.widgetType.bar',
  line: 'tables.dashboard.widgetType.line',
  pie: 'tables.dashboard.widgetType.pie',
  records: 'tables.dashboard.widgetType.records',
  text: 'tables.dashboard.widgetType.text',
};
const AGGREGATION_LABEL_KEYS: Record<TableAggregation, TranslationKey> = {
  count: 'tables.aggregationType.count',
  sum: 'tables.aggregationType.sum',
  avg: 'tables.aggregationType.avg',
  min: 'tables.aggregationType.min',
  max: 'tables.aggregationType.max',
};

function RecordsWidget({ records, fields }: { records: TableRecordPage; fields: TableField[] }) {
  const t = useT();
  const visibleFields = fields.slice(0, 5);
  return (
    <div className="overflow-auto rounded-md border border-edge">
      <table className="min-w-full text-left text-xs">
        <thead className="bg-surface-sunken">
          <tr>
            {visibleFields.map((field) => (
              <th key={field.id} className="border-b border-edge px-3 py-2 font-medium text-fg-muted">
                {field.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.records.map((record) => (
            <tr key={record.id}>
              {visibleFields.map((field) => {
                const value =
                  record.computed_values[String(field.id)] === undefined
                    ? record.values[String(field.id)]
                    : record.computed_values[String(field.id)];
                return (
                  <td key={field.id} className="max-w-56 truncate border-b border-edge px-3 py-2 text-fg-secondary">
                    {Array.isArray(value)
                      ? value.join(', ')
                      : value === null || value === undefined || value === ''
                        ? '—'
                        : typeof value === 'object'
                          ? JSON.stringify(value)
                          : String(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {records.records.length === 0 && (
        <div className="px-3 py-6 text-center text-xs text-fg-faint">{t('common.noMatchingRows')}</div>
      )}
    </div>
  );
}

function WidgetCard({
  result,
  fields,
  canBuild,
  onEdit,
  onDelete,
}: {
  result: WidgetResult;
  fields: TableField[];
  canBuild: boolean;
  onEdit: (widget: TableDashboardWidget) => void;
  onDelete: (widget: TableDashboardWidget) => void;
}) {
  const t = useT();
  const { widget } = result;
  const rows = result.rows ?? [];
  const chartType = widget.type === 'pie' ? 'pie' : widget.type === 'line' ? 'line' : 'bar';
  const chartData: ChartData = {
    type: chartType,
    labels: rows.map((row) => (row.group === null ? t('tables.dashboard.allRecords') : String(row.group))),
    datasets: [{ label: widget.title, data: rows.map((row) => row.value) }],
  };

  return (
    <section className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-edge bg-surface-card p-4 shadow-sm">
      <div
        className={`mb-3 flex flex-shrink-0 items-center justify-between gap-2 ${
          canBuild ? `${WIDGET_DRAG_HANDLE_CLASS} cursor-move` : ''
        }`}
      >
        <h3 className="truncate text-sm font-semibold text-fg">{widget.title}</h3>
        {canBuild && (
          <div className="flex">
            <IconButton
              label={t('tables.dashboard.editWidgetLabel', { name: widget.title })}
              tooltipMode="portal"
              onClick={() => onEdit(widget)}
              className="h-7 w-7 sm:h-7 sm:w-7"
            >
              <Edit3 size={13} />
            </IconButton>
            <IconButton
              label={t('tables.dashboard.deleteWidgetLabel', { name: widget.title })}
              variant="destructive"
              tooltipMode="portal"
              onClick={() => onDelete(widget)}
              className="h-7 w-7 sm:h-7 sm:w-7"
            >
              <Trash2 size={13} />
            </IconButton>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {widget.type === 'text' && (
          <p className="whitespace-pre-wrap text-sm leading-6 text-fg-secondary">{result.text || '—'}</p>
        )}
        {widget.type === 'kpi' && (
          <div className="py-3 text-4xl font-semibold tracking-tight text-fg">{rows[0]?.value ?? 0}</div>
        )}
        {(widget.type === 'bar' || widget.type === 'line' || widget.type === 'pie') && (
          <ChartBlock data={chartData} fill />
        )}
        {widget.type === 'records' && result.records && <RecordsWidget records={result.records} fields={fields} />}
      </div>
    </section>
  );
}

export function TablesDashboardView({ dashboardId, tables, role }: TablesDashboardViewProps) {
  const t = useT();
  const canBuild = ROLE_RANK[role] >= ROLE_RANK.builder;
  const [dashboard, setDashboard] = useState<TableDashboard | null>(null);
  const [results, setResults] = useState<WidgetResult[]>([]);
  const [fieldsByTable, setFieldsByTable] = useState<Record<number, TableField[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(false);
  const [editingWidget, setEditingWidget] = useState<TableDashboardWidget | null>(null);
  const [title, setTitle] = useState('');
  const [type, setType] = useState<TableDashboardWidgetType>('kpi');
  const [tableId, setTableId] = useState<number | ''>(tables[0]?.id ?? '');
  const [operation, setOperation] = useState<TableAggregation>('count');
  const [valueFieldId, setValueFieldId] = useState<number | ''>('');
  const [groupByFieldId, setGroupByFieldId] = useState<number | ''>('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteWidget, setDeleteWidget] = useState<TableDashboardWidget | null>(null);

  /**
   * Grid items for the shared widget grid.
   *
   * `layout` has existed on the row since Tables V1, but until this change
   * nothing rendered it: stored values are whatever the various default writers
   * put there (`w:6` from the service, `w:1|2,h:1` from the old dialog). Rather
   * than guess which of those a person meant, position is taken as-is and only
   * the *size* is clamped up to something usable for the widget type. A card
   * the user deliberately made bigger keeps its size; one left at a legacy
   * default stops rendering as a sliver or a full-width band.
   */
  const gridItems: WidgetGridItem[] = useMemo(
    () =>
      results.map(({ widget }) => {
        const compact = widget.type === 'kpi' || widget.type === 'text';
        const minW = compact ? 3 : 6;
        const minH = compact ? 2 : 4;
        const layout = safeParse<Partial<TableDashboardWidgetLayout>>(widget.layout, {});
        const w = Math.min(Math.max(typeof layout.w === 'number' ? layout.w : minW, minW), DASHBOARD_COLUMNS);
        return {
          id: String(widget.id),
          x: Math.min(layout.x ?? 0, DASHBOARD_COLUMNS - w),
          y: layout.y ?? 0,
          w,
          h: Math.max(typeof layout.h === 'number' ? layout.h : minH, minH),
          minW,
          minH,
        };
      }),
    [results],
  );

  const resultsById = useMemo(() => new Map(results.map((result) => [result.widget.id, result])), [results]);

  const persistLayout = useCallback(
    (items: WidgetGridItem[]) => {
      const byId = new Map(items.map((item) => [Number(item.id), item]));
      setResults((previous) =>
        previous.map((result) => {
          const item = byId.get(result.widget.id);
          return item
            ? {
                ...result,
                widget: {
                  ...result.widget,
                  layout: JSON.stringify({ x: item.x, y: item.y, w: item.w, h: item.h }),
                },
              }
            : result;
        }),
      );
      void Promise.all(
        results.map(async (result) => {
          const item = byId.get(result.widget.id);
          if (!item) return;
          const layout = { x: item.x, y: item.y, w: item.w, h: item.h };
          const current = safeParse<Partial<TableDashboardWidgetLayout>>(result.widget.layout, {});
          if (current.x === layout.x && current.y === layout.y && current.w === layout.w && current.h === layout.h) {
            return;
          }
          await updateTableDashboardWidget(result.widget.id, { revision: result.widget.revision, layout });
        }),
      ).catch((layoutError) => {
        setError(layoutError instanceof Error ? layoutError.message : 'Unable to save layout');
      });
    },
    [results],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await getTableDashboard(dashboardId);
      setDashboard(next.dashboard);
      const tableIds = [...new Set(next.widgets.flatMap((widget) => (widget.table_id ? [widget.table_id] : [])))];
      const schemas = await Promise.all(tableIds.map(async (id) => [id, (await getTableSchema(id)).fields] as const));
      setFieldsByTable(Object.fromEntries(schemas));
      setResults(await Promise.all(next.widgets.map((widget) => queryTableDashboardWidget(widget.id))));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tables.dashboard.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [dashboardId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tableId === '') {
      setValueFieldId('');
      setGroupByFieldId('');
      return;
    }
    if (fieldsByTable[tableId]) return;
    void getTableSchema(tableId).then((schema) =>
      setFieldsByTable((current) => ({ ...current, [tableId]: schema.fields })),
    );
  }, [fieldsByTable, tableId]);

  const selectedFields = useMemo(
    () => (tableId === '' ? [] : (fieldsByTable[tableId] ?? [])),
    [fieldsByTable, tableId],
  );
  const numericFields = useMemo(() => selectedFields.filter((field) => field.type === 'number'), [selectedFields]);
  const needsTable = type !== 'text';
  const needsGroup = type === 'bar' || type === 'line' || type === 'pie';

  const openWidgetDialog = (widget?: TableDashboardWidget) => {
    const config = widget ? safeParse<TableDashboardWidgetConfig>(widget.config, {}) : {};
    setEditingWidget(widget ?? null);
    setTitle(widget?.title ?? '');
    setType(widget?.type ?? 'kpi');
    setTableId(widget?.table_id ?? tables[0]?.id ?? '');
    setOperation(config.operation ?? 'count');
    setValueFieldId(config.valueFieldId ?? '');
    setGroupByFieldId(config.groupByFieldId ?? '');
    setText(config.text ?? '');
    setDialog(true);
  };

  const closeWidgetDialog = () => {
    setDialog(false);
    setEditingWidget(null);
    setTitle('');
    setText('');
  };

  const save = async () => {
    if (!title.trim() || (needsTable && tableId === '')) return;
    setSaving(true);
    setError('');
    try {
      const config: TableDashboardWidgetConfig =
        type === 'text'
          ? { text }
          : {
              operation,
              valueFieldId: operation === 'count' || valueFieldId === '' ? undefined : Number(valueFieldId),
              groupByFieldId: needsGroup && groupByFieldId !== '' ? Number(groupByFieldId) : undefined,
              limit: type === 'records' ? 20 : 30,
            };
      if (editingWidget) {
        await updateTableDashboardWidget(editingWidget.id, {
          revision: editingWidget.revision,
          title: title.trim(),
          tableId: needsTable ? Number(tableId) : null,
          config,
        });
      } else {
        await createTableDashboardWidget(dashboardId, {
          type,
          title: title.trim(),
          tableId: needsTable ? Number(tableId) : undefined,
          config,
          layout: { x: 0, y: 0, w: type === 'kpi' || type === 'text' ? 1 : 2, h: 1 },
        });
      }
      closeWidgetDialog();
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.dashboard.saveWidgetFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !dashboard)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-fg-faint" />
      </div>
    );

  return (
    <div className="h-full overflow-y-auto bg-surface-canvas">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-edge bg-surface-raised/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-fg">{dashboard?.name ?? t('tables.dashboard.title')}</h2>
          <p className="truncate text-xs text-fg-faint">
            {dashboard?.description || t('tables.dashboard.description')}
          </p>
        </div>
        {canBuild && (
          <Button size="sm" onClick={() => openWidgetDialog()}>
            <Plus size={13} className="mr-1.5" />
            {t('tables.dashboard.widget')}
          </Button>
        )}
      </header>
      {error && <div className="border-b border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">{error}</div>}
      <div className="p-4 sm:p-6">
        {results.length === 0 ? (
          <EmptyState
            icon={BarChart3}
            title={t('tables.dashboard.emptyTitle')}
            description={canBuild ? t('tables.dashboard.emptyBuilder') : t('tables.dashboard.emptyViewer')}
          />
        ) : (
          <WidgetGrid
            items={gridItems}
            editing={canBuild}
            columns={DASHBOARD_COLUMNS}
            onLayoutChange={persistLayout}
            renderItem={(id) => {
              const result = resultsById.get(Number(id));
              if (!result) return null;
              return (
                <WidgetCard
                  result={result}
                  fields={result.widget.table_id ? (fieldsByTable[result.widget.table_id] ?? []) : []}
                  canBuild={canBuild}
                  onEdit={openWidgetDialog}
                  onDelete={setDeleteWidget}
                />
              );
            }}
          />
        )}
      </div>

      <Dialog
        open={dialog}
        onClose={closeWidgetDialog}
        title={editingWidget ? t('tables.dashboard.editWidget') : t('tables.dashboard.addWidget')}
        size="lg"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.dashboard.widgetTitle')}</label>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-fg-muted">
              {t('tables.dashboard.widgetTypeLabel')}
            </label>
            <Select
              value={type}
              disabled={editingWidget !== null}
              onChange={(event) => setType(event.target.value as TableDashboardWidgetType)}
            >
              {TABLE_DASHBOARD_WIDGET_TYPES.map((entry) => (
                <option key={entry} value={entry}>
                  {t(WIDGET_LABEL_KEYS[entry])}
                </option>
              ))}
            </Select>
          </div>
          {needsTable && (
            <div>
              <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.automations.table')}</label>
              <Select value={tableId} onChange={(event) => setTableId(Number(event.target.value))}>
                {tables.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {type === 'text' ? (
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.fieldType.text')}</label>
              <Textarea rows={8} value={text} onChange={(event) => setText(event.target.value)} />
            </div>
          ) : type !== 'records' ? (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.aggregation')}</label>
                <Select value={operation} onChange={(event) => setOperation(event.target.value as TableAggregation)}>
                  {TABLE_AGGREGATIONS.map((entry) => (
                    <option key={entry} value={entry}>
                      {t(AGGREGATION_LABEL_KEYS[entry])}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-fg-muted">
                  {t('tables.dashboard.valueField')}
                </label>
                <Select
                  value={valueFieldId}
                  disabled={operation === 'count'}
                  onChange={(event) => setValueFieldId(event.target.value ? Number(event.target.value) : '')}
                >
                  <option value="">—</option>
                  {numericFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name}
                    </option>
                  ))}
                </Select>
              </div>
              {needsGroup && (
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-xs font-medium text-fg-muted">
                    {t('tables.dashboard.groupBy')}
                  </label>
                  <Select
                    value={groupByFieldId}
                    onChange={(event) => setGroupByFieldId(event.target.value ? Number(event.target.value) : '')}
                  >
                    <option value="">{t('tables.dashboard.noGrouping')}</option>
                    {selectedFields.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </>
          ) : null}
          <div className="flex justify-end gap-2 border-t border-edge pt-4 sm:col-span-2">
            <Button variant="ghost" onClick={closeWidgetDialog}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void save()} disabled={saving || !title.trim() || (needsTable && tableId === '')}>
              {saving
                ? t('common.saving')
                : editingWidget
                  ? t('tables.dashboard.saveWidget')
                  : t('tables.dashboard.addWidget')}
            </Button>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={deleteWidget !== null}
        onClose={() => setDeleteWidget(null)}
        onConfirm={() => {
          if (!deleteWidget) return;
          void deleteTableDashboardWidget(deleteWidget.id).then(async () => {
            setDeleteWidget(null);
            await load();
          });
        }}
        title={t('tables.dashboard.deleteTitle', { name: deleteWidget?.title ?? t('tables.dashboard.widget') })}
        description={t('tables.dashboard.deleteDescription')}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </div>
  );
}
