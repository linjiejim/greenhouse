/**
 * CrudPage — the full list experience from a schema: toolbar, filter bar,
 * sortable table with row actions, pagination, and the built-in create/edit
 * (CrudForm) + detail (CrudDetail) + delete-confirm flows. Slots and
 * tableActions/pageActions are the escape hatches for anything bespoke.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Select,
  Input,
  Pagination,
  EmptyState,
  Spinner,
  ListToolbar,
  ConfirmDialog,
  toast,
} from '@greenhouse/ui/components/ui';
import {
  Plus,
  Pencil,
  Trash2,
  Eye,
  Search,
  Filter,
  ChevronDown,
  ChevronUp,
  Inbox,
  type LucideIcon,
} from '@greenhouse/ui/lib/icons';
import { useT } from '@greenhouse/ui/lib/i18n';

import type { FilterDef, ResolvedCrudSchema, CrudActionContext, TableActionDef } from './schema.js';
import type { FilterItem, SortItem } from '../protocol/types.js';
import type { OptionsSource, SelectOption } from './schema.js';
import { renderCell } from './columns.js';
import { CrudForm } from './crud-form.js';
import { CrudDetail } from './crud-detail.js';
import { tr, usePersistedPageSize } from './util.js';

export interface CrudPageProps<TRow> {
  schema: ResolvedCrudSchema<TRow>;
}

const ACTION_TONE: Record<string, string> = {
  default: 'text-fg-muted hover:text-fg hover:bg-surface-muted',
  primary: 'text-fg-muted hover:text-primary-fg hover:bg-surface-muted',
  success: 'text-fg-muted hover:text-success hover:bg-success-subtle',
  warning: 'text-fg-muted hover:text-warning hover:bg-warning-subtle',
  danger: 'text-fg-muted hover:text-danger hover:bg-danger-subtle',
};

export function CrudPage<TRow>({ schema }: CrudPageProps<TRow>) {
  const t = useT();
  const idField = schema.idField;

  const [items, setItems] = useState<TRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = usePersistedPageSize(schema.storageKey, schema.pageSize);
  const [sort, setSort] = useState<SortItem | null>(schema.defaultSort ?? null);
  const [filterValues, setFilterValues] = useState<Record<string, unknown>>({});
  const [showMore, setShowMore] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Overlays
  const [formState, setFormState] = useState<{ mode: 'add' | 'edit'; row: TRow | null } | null>(null);
  const [detailRow, setDetailRow] = useState<TRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TRow | null>(null);

  const buildParams = useCallback(() => {
    const filter: FilterItem[] = [];
    for (const def of schema.filters) {
      const v = filterValues[def.key];
      if (def.kind === 'text') {
        if (v && String(v).trim())
          filter.push({ key: def.key, method: def.method ?? 'like', value: [String(v).trim()] });
      } else if (def.kind === 'select') {
        if (v !== undefined && v !== '' && v !== null)
          filter.push({ key: def.key, method: def.method ?? 'eq', value: [v] });
      } else if (def.kind === 'boolean') {
        if (v === 'true' || v === 'false') filter.push({ key: def.key, method: 'eq', value: [v === 'true'] });
      } else if (def.kind === 'daterange') {
        const range = (v as { from?: string; to?: string }) ?? {};
        if (range.from && range.to) filter.push({ key: def.key, method: 'between', value: [range.from, range.to] });
        else if (range.from) filter.push({ key: def.key, method: 'gte', value: [range.from] });
        else if (range.to) filter.push({ key: def.key, method: 'lte', value: [range.to] });
      }
    }
    return {
      skip: page * pageSize,
      limit: pageSize,
      filter: filter.length ? filter : undefined,
      sort: sort ? [sort] : undefined,
    };
  }, [schema.filters, filterValues, page, pageSize, sort]);

  // Monotonic request id — a slower in-flight list must not clobber a newer one.
  const reqSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const res = await schema.dataSource.list(buildParams());
      if (seq !== reqSeq.current) return; // a newer request superseded this one
      // If a shrink (delete / external removal) left `page` past the last page,
      // step back instead of stranding the user on an out-of-range empty page.
      const maxPage = Math.max(0, Math.ceil(res.total / pageSize) - 1);
      if (res.total > 0 && page > maxPage) {
        setPage(maxPage);
        return; // the page change re-fires the effect → fresh load
      }
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      toast(err instanceof Error ? err.message : t('crud.loadFailed'), 'error');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [schema.dataSource, buildParams, page, pageSize, t]);

  // Debounced reload on any query change (filters typed live).
  const filterKey = JSON.stringify(filterValues);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, sort?.key, sort?.order, filterKey]);

  const reload = useCallback(() => void load(), [load]);

  const ctx: CrudActionContext = useMemo(
    () => ({
      reload,
      openCreate: () => setFormState({ mode: 'add', row: null }),
      openEdit: (row) => setFormState({ mode: 'edit', row: row as TRow }),
      openDetail: (row) => setDetailRow(row as TRow),
    }),
    [reload],
  );

  const setFilter = (key: string, value: unknown) => {
    setPage(0);
    setFilterValues((f) => ({ ...f, [key]: value }));
  };

  const toggleSort = (key: string) => {
    setPage(0); // re-sorting from a deep page should show the newly-top rows
    setSort((s) => (s?.key === key ? { key, order: s.order === 'asc' ? 'desc' : 'asc' } : { key, order: 'asc' }));
  };

  const confirmDelete = async () => {
    if (!deleteTarget || !schema.dataSource.remove) return;
    try {
      await schema.dataSource.remove(String((deleteTarget as Record<string, unknown>)[idField]));
      toast(t('crud.deleted'), 'success');
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('crud.deleteFailed'), 'error');
    } finally {
      setDeleteTarget(null);
    }
  };

  const visibleColumns = schema.columns.filter((c) => !c.hidden);
  const rowActions = buildRowActions(schema);
  const hasActionsCol = rowActions.length > 0 || schema.tableActions.length > 0;
  const rowClick = resolveRowClick(schema);

  const onRowClick = (row: TRow) => {
    if (schema.slots?.rowExpand) {
      const id = String((row as Record<string, unknown>)[idField]);
      setExpanded((e) => (e === id ? null : id));
      return;
    }
    if (rowClick === 'detail') setDetailRow(row);
    else if (rowClick === 'edit' && schema.access.canEdit) setFormState({ mode: 'edit', row });
  };

  // ── Toolbar ────────────────────────────────────────────
  const addButton = schema.access.canAdd ? (
    <Button size="sm" onClick={() => setFormState({ mode: 'add', row: null })}>
      <Plus size={14} className="mr-1" />
      {`${t('crud.add')} ${tr(t, schema.name)}`}
    </Button>
  ) : null;

  const pageActionButtons = schema.pageActions.map((a) => (
    <Button key={a.key} size="sm" variant="ghost" onClick={() => void a.onClick(ctx)}>
      {a.icon ? <a.icon size={14} className="mr-1" /> : null}
      {tr(t, a.label)}
    </Button>
  ));

  const primaryFilters = schema.filters.filter((f) => !f.secondary);
  const secondaryFilters = schema.filters.filter((f) => f.secondary);

  return (
    <div className="space-y-4">
      {schema.slots?.toolbar ? (
        schema.slots.toolbar({ ...ctx, total })
      ) : (
        <ListToolbar
          count={t('crud.total', { count: total })}
          actions={
            <>
              {pageActionButtons}
              {addButton}
            </>
          }
        />
      )}

      {schema.slots?.banner?.(ctx)}

      {/* Filter bar */}
      {schema.filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {primaryFilters.map((def) => (
            <FilterControl
              key={def.key}
              def={def}
              value={filterValues[def.key]}
              onChange={(v) => setFilter(def.key, v)}
              t={t}
            />
          ))}
          {showMore &&
            secondaryFilters.map((def) => (
              <FilterControl
                key={def.key}
                def={def}
                value={filterValues[def.key]}
                onChange={(v) => setFilter(def.key, v)}
                t={t}
              />
            ))}
          {secondaryFilters.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setShowMore((s) => !s)}>
              <Filter size={13} className="mr-1" />
              {t('crud.moreFilters')}
            </Button>
          )}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        (schema.slots?.empty ?? (
          <EmptyState
            icon={schema.icon ?? Inbox}
            title={schema.emptyMessage ? tr(t, schema.emptyMessage) : t('crud.empty')}
            action={addButton ?? undefined}
          />
        ))
      ) : (
        <div className="bg-surface-raised border border-edge rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-fg-muted">
              <tr>
                {visibleColumns.map((col) => (
                  <th
                    key={col.key}
                    className={`px-3 py-2 font-medium ${col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'} ${
                      col.responsiveHide === 'md'
                        ? 'hidden md:table-cell'
                        : col.responsiveHide === 'lg'
                          ? 'hidden lg:table-cell'
                          : col.responsiveHide === 'sm'
                            ? 'hidden sm:table-cell'
                            : ''
                    } ${col.sortable ? 'cursor-pointer select-none' : ''}`}
                    style={col.width ? { width: col.width } : undefined}
                    onClick={col.sortable ? () => toggleSort(col.key) : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {tr(t, col.label)}
                      {col.sortable &&
                        sort?.key === col.key &&
                        (sort.order === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </span>
                  </th>
                ))}
                {hasActionsCol && (
                  <th className="px-3 py-2 text-right font-medium w-px whitespace-nowrap">{t('crud.actions')}</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {items.map((row) => {
                const id = String((row as Record<string, unknown>)[idField]);
                const clickable = rowClick !== 'none' || !!schema.slots?.rowExpand;
                return (
                  <React.Fragment key={id}>
                    <tr
                      className={`transition-colors ${clickable ? 'cursor-pointer hover:bg-surface-sunken' : ''} ${expanded === id ? 'bg-surface-sunken' : ''}`}
                      onClick={clickable ? () => onRowClick(row) : undefined}
                    >
                      {visibleColumns.map((col) => (
                        <td
                          key={col.key}
                          className={`px-3 py-2.5 ${col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : ''} ${
                            col.responsiveHide === 'md'
                              ? 'hidden md:table-cell'
                              : col.responsiveHide === 'lg'
                                ? 'hidden lg:table-cell'
                                : col.responsiveHide === 'sm'
                                  ? 'hidden sm:table-cell'
                                  : ''
                          }`}
                        >
                          {renderCell(col, row)}
                        </td>
                      ))}
                      {hasActionsCol && (
                        <td className="px-3 py-2.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-0.5">
                            {schema.tableActions.map((a) => (
                              <TableActionButton key={a.key} action={a} row={row} ctx={ctx} t={t} />
                            ))}
                            {rowActions.includes('view') && (
                              <IconBtn
                                title={t('crud.view')}
                                tone="default"
                                onClick={() => setDetailRow(row)}
                                icon={Eye}
                              />
                            )}
                            {rowActions.includes('edit') &&
                              (!schema.access.canEditRow ||
                                schema.access.canEditRow(row as Record<string, unknown>)) && (
                                <IconBtn
                                  title={t('crud.edit')}
                                  tone="primary"
                                  onClick={() => setFormState({ mode: 'edit', row })}
                                  icon={Pencil}
                                />
                              )}
                            {rowActions.includes('delete') &&
                              (!schema.access.canDeleteRow ||
                                schema.access.canDeleteRow(row as Record<string, unknown>)) && (
                                <IconBtn
                                  title={t('crud.delete')}
                                  tone="danger"
                                  onClick={() => setDeleteTarget(row)}
                                  icon={Trash2}
                                />
                              )}
                          </div>
                        </td>
                      )}
                    </tr>
                    {schema.slots?.rowExpand && expanded === id && (
                      <tr>
                        <td
                          colSpan={visibleColumns.length + (hasActionsCol ? 1 : 0)}
                          className="px-4 py-3 bg-surface-sunken"
                        >
                          {schema.slots.rowExpand(row, ctx)}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > pageSize && (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(s) => {
            setPage(0);
            setPageSize(s);
          }}
        />
      )}

      {formState && (
        <CrudForm
          schema={schema}
          mode={formState.mode}
          initial={formState.row}
          onClose={() => setFormState(null)}
          onSaved={reload}
        />
      )}
      {detailRow && (
        <CrudDetail
          schema={schema}
          row={detailRow}
          onClose={() => setDetailRow(null)}
          onEdit={
            schema.access.canEdit
              ? () => {
                  const r = detailRow;
                  setDetailRow(null);
                  setFormState({ mode: 'edit', row: r });
                }
              : undefined
          }
        />
      )}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title={t('crud.confirmDeleteTitle')}
        description={t('crud.confirmDeleteBody')}
        confirmLabel={t('crud.delete')}
        confirmVariant="destructive"
      />
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────

function IconBtn({
  title,
  tone,
  onClick,
  icon: Icon,
}: {
  title: string;
  tone: string;
  onClick: () => void;
  icon: LucideIcon;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded transition-colors ${ACTION_TONE[tone] ?? ACTION_TONE.default}`}
    >
      <Icon size={14} />
    </button>
  );
}

function TableActionButton<TRow>({
  action,
  row,
  ctx,
  t,
}: {
  action: TableActionDef<TRow>;
  row: TRow;
  ctx: CrudActionContext;
  t: (k: string) => string;
}) {
  if (action.visible && !action.visible(row)) return null;
  const label = typeof action.label === 'function' ? action.label(row) : action.label;
  const Icon = action.icon;
  return (
    <button
      onClick={() => void action.onClick(row, ctx)}
      title={tr(t, label)}
      className={`p-1.5 rounded transition-colors ${ACTION_TONE[action.tone ?? 'default']}`}
    >
      {Icon ? <Icon size={14} /> : <span className="text-xs px-1">{tr(t, label)}</span>}
    </button>
  );
}

function FilterControl<TRow>({
  def,
  value,
  onChange,
  t,
}: {
  def: FilterDef<TRow>;
  value: unknown;
  onChange: (v: unknown) => void;
  t: (k: string) => string;
}) {
  if (def.kind === 'text') {
    return (
      <div className="relative">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-faint pointer-events-none" />
        <Input
          size="sm"
          className="pl-7 w-48"
          value={(value as string) ?? ''}
          placeholder={def.placeholder ? tr(t, def.placeholder) : tr(t, def.label)}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }
  if (def.kind === 'boolean') {
    return (
      <Select size="sm" className="w-auto" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{tr(t, def.label)}</option>
        <option value="true">✓</option>
        <option value="false">✗</option>
      </Select>
    );
  }
  if (def.kind === 'daterange') {
    const range = (value as { from?: string; to?: string }) ?? {};
    return (
      <div className="flex items-center gap-1">
        <Input
          size="sm"
          type="date"
          value={range.from ?? ''}
          onChange={(e) => onChange({ ...range, from: e.target.value })}
        />
        <span className="text-fg-faint text-xs">–</span>
        <Input
          size="sm"
          type="date"
          value={range.to ?? ''}
          onChange={(e) => onChange({ ...range, to: e.target.value })}
        />
      </div>
    );
  }
  // select
  return <FilterSelect def={def} value={value} onChange={onChange} t={t} />;
}

function FilterSelect<TRow>({
  def,
  value,
  onChange,
  t,
}: {
  def: FilterDef<TRow>;
  value: unknown;
  onChange: (v: unknown) => void;
  t: (k: string) => string;
}) {
  const [opts, setOpts] = useState<SelectOption[]>(Array.isArray(def.options) ? def.options : []);
  useEffect(() => {
    const src = def.options as OptionsSource | undefined;
    let alive = true;
    if (typeof src === 'function')
      src()
        .then((r) => alive && setOpts(r))
        .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Select
      size="sm"
      className="w-auto"
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') return onChange('');
        // Re-emit the typed option value (number/boolean), not the stringified <option> value.
        const match = opts.find((o) => String(o.value) === raw);
        onChange(match ? match.value : raw);
      }}
    >
      <option value="">{tr(t, def.label)}</option>
      {opts.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

// ─── Helpers ─────────────────────────────────────────────

function buildRowActions<TRow>(schema: ResolvedCrudSchema<TRow>): Array<'view' | 'edit' | 'delete'> {
  const out: Array<'view' | 'edit' | 'delete'> = [];
  // View is only useful when not already the row-click target and there is something to show.
  if (schema.access.canView && (schema.detailTabs || schema.columns.some((c) => c.hidden))) out.push('view');
  if (schema.access.canEdit && schema.formFields.length > 0) out.push('edit');
  if (schema.access.canDelete) out.push('delete');
  return out;
}

function resolveRowClick<TRow>(schema: ResolvedCrudSchema<TRow>): 'detail' | 'edit' | 'none' {
  if (schema.onRowClick) return schema.onRowClick;
  if (schema.slots?.rowExpand) return 'none';
  if (schema.access.canView && (schema.detailTabs || schema.columns.some((c) => c.hidden))) return 'detail';
  return 'none';
}
