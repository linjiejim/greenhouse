import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TABLE_FIELD_TYPES,
  type TableBaseRole,
  type TableFieldConfig,
  type TableFieldType,
  type TableFilterClause,
  type TableFilterGroup,
  type TableFilterOperator,
  type TableFormulaBinaryOperator,
  type TableFormulaResultType,
  type TableQuery,
  type TableRecordValues,
  type TableRollupAggregation,
  type TableViewConfig,
} from '@greenhouse/types/tables';
import {
  archiveTableField,
  createTableField,
  createTableRecord,
  createTableView,
  deleteTableRecord,
  getTableSchema,
  queryTableRecords,
  updateTableField,
  updateTableRecord,
  updateTableView,
  upsertTableRecordBatch,
  validateTableRecordBatch,
  type TableDefinition,
  type TableField,
  type TableRecord,
  type TableSchema,
} from '../../lib/api/tables';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  Pagination,
  Select,
  Spinner,
  Textarea,
} from '../../components/ui';
import { Archive, ArrowDown, ArrowUp, Edit3, LayoutGrid, MoreHorizontal, Pin, PinOff, Plus, X } from '../../lib/icons';
import { safeParse } from '../../lib/utils';
import { usePersistedPageSize } from '../../hooks/use-persisted-page-size';
import { useAuthStore } from '../../stores';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../../components/app/context-menu';
import { RecordDialog } from './record-dialog';
import { RecordDetailDrawer } from './record-detail-drawer';
import { RecycleBinDrawer } from './recycle-bin-drawer';
import { RecordRowActions } from './record-row-actions';
import { InlineCell } from './inline-cell';
import { buildPasteBatch, parseClipboardMatrix, parsePastedCell } from './grid-utils';
import { TablesGridToolbar } from './grid-toolbar';
import { TablesFormsDialog } from './forms-dialog';
import { renderTableFieldValue } from './field-value';
import { useT, type TranslationKey } from '../../lib/i18n';

interface TablesGridViewProps {
  table: TableDefinition;
  tables: TableDefinition[];
  role: TableBaseRole;
  users: Array<{ id: string; nickname: string; email: string }>;
}

const ROLE_RANK: Record<TableBaseRole, number> = { viewer: 0, editor: 1, builder: 2, owner: 3 };

/** Freeze more than this and the frozen block itself stops fitting on screen. */
const MAX_FROZEN_COLUMNS = 4;

const FIELD_LABEL_KEYS: Record<TableFieldType, TranslationKey> = {
  text: 'tables.fieldType.text',
  long_text: 'tables.fieldType.longText',
  number: 'tables.fieldType.number',
  boolean: 'tables.fieldType.boolean',
  date: 'tables.fieldType.date',
  datetime: 'tables.fieldType.datetime',
  single_select: 'tables.fieldType.singleSelect',
  multi_select: 'tables.fieldType.multiSelect',
  user: 'tables.fieldType.user',
  multi_user: 'tables.fieldType.multiUser',
  url: 'tables.fieldType.url',
  email: 'tables.fieldType.email',
  phone: 'tables.fieldType.phone',
  attachment: 'tables.fieldType.attachment',
  relation: 'tables.fieldType.relation',
  formula: 'tables.fieldType.formula',
  rollup: 'tables.fieldType.rollup',
};

const FILTER_LABEL_KEYS: Partial<Record<TableFilterOperator, TranslationKey>> = {
  eq: 'tables.filter.eq',
  neq: 'tables.filter.neq',
  contains: 'tables.filter.contains',
  not_contains: 'tables.filter.notContains',
  gt: 'tables.filter.gt',
  gte: 'tables.filter.gte',
  lt: 'tables.filter.lt',
  lte: 'tables.filter.lte',
  is_empty: 'tables.filter.isEmpty',
  is_not_empty: 'tables.filter.isNotEmpty',
};

interface FilterDraft {
  fieldId: number;
  operator: TableFilterOperator;
  value: string;
}

function filterOperators(field?: TableField): TableFilterOperator[] {
  if (!field) return ['eq', 'neq', 'is_empty', 'is_not_empty'];
  const common: TableFilterOperator[] = ['eq', 'neq', 'is_empty', 'is_not_empty'];
  if (field.type === 'number' || field.type === 'date' || field.type === 'datetime') {
    return [...common, 'gt', 'gte', 'lt', 'lte'];
  }
  if (['text', 'long_text', 'url', 'email', 'phone'].includes(field.type)) {
    return [...common, 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte'];
  }
  if (field.type === 'multi_select' || field.type === 'multi_user' || field.type === 'attachment') {
    return [...common, 'contains', 'not_contains'];
  }
  return common;
}

function filterValue(field: TableField, draft: FilterDraft, users: TablesGridViewProps['users']): unknown {
  if (draft.operator === 'is_empty' || draft.operator === 'is_not_empty') return undefined;
  if (draft.operator === 'contains' || draft.operator === 'not_contains') {
    if (field.type === 'multi_select') return parsePastedCell({ ...field, type: 'single_select' }, draft.value, users);
    if (field.type === 'multi_user') return parsePastedCell({ ...field, type: 'user' }, draft.value, users);
    return draft.value;
  }
  return parsePastedCell(field, draft.value, users);
}

function optionConfig(text: string, current: TableFieldConfig = {}): TableFieldConfig {
  const labels = text
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    options: labels.map((label, index) => ({
      id:
        current.options?.[index]?.id ??
        `${
          label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'option'
        }-${index + 1}`,
      label,
    })),
  };
}

function optionsText(config: string): string {
  return (safeParse<TableFieldConfig>(config, {}).options ?? []).map((option) => option.label).join('\n');
}

export function TablesGridView({ table, tables, role, users }: TablesGridViewProps) {
  const t = useT();
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.editor;
  const canBuild = ROLE_RANK[role] >= ROLE_RANK.builder;
  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [records, setRecords] = useState<TableRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<TableQuery['sort']>([{ systemField: 'updated_at', direction: 'desc' }]);
  const [where, setWhere] = useState<TableFilterGroup | undefined>();
  const [selectedViewId, setSelectedViewId] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = usePersistedPageSize(`tables.${table.id}`, 20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detailRecord, setDetailRecord] = useState<TableRecord | null>(null);
  const [recordDialog, setRecordDialog] = useState<TableRecord | 'new' | null>(null);
  const [savingRecord, setSavingRecord] = useState(false);
  const [deleteRecord, setDeleteRecord] = useState<TableRecord | null>(null);
  const [fieldDialog, setFieldDialog] = useState<TableField | 'new' | null>(null);
  const [fieldName, setFieldName] = useState('');
  const [fieldType, setFieldType] = useState<TableFieldType>('text');
  const [fieldRequired, setFieldRequired] = useState(false);
  const [fieldOptions, setFieldOptions] = useState('');
  const [relationTargetTableId, setRelationTargetTableId] = useState<number | ''>('');
  const [relationMultiple, setRelationMultiple] = useState(false);
  const [formulaLeftFieldId, setFormulaLeftFieldId] = useState<number | ''>('');
  const [formulaOperator, setFormulaOperator] = useState<TableFormulaBinaryOperator>('concat');
  const [formulaRightFieldId, setFormulaRightFieldId] = useState<number | ''>('');
  const [formulaResultType, setFormulaResultType] = useState<TableFormulaResultType>('text');
  const [rollupRelationFieldId, setRollupRelationFieldId] = useState<number | ''>('');
  const [rollupTargetFieldId, setRollupTargetFieldId] = useState<number | ''>('');
  const [rollupAggregation, setRollupAggregation] = useState<TableRollupAggregation>('count');
  const [modelTargetFields, setModelTargetFields] = useState<TableField[]>([]);
  const [savingField, setSavingField] = useState(false);
  const [archiveField, setArchiveField] = useState<TableField | null>(null);
  const [viewDialog, setViewDialog] = useState(false);
  /** Carried into the Save view dialog when freezing without a saved view. */
  const [pendingFrozenCount, setPendingFrozenCount] = useState<number | null>(null);
  const [recycleBin, setRecycleBin] = useState(false);
  const [formsDialog, setFormsDialog] = useState(false);
  const [viewName, setViewName] = useState('');
  const [viewScope, setViewScope] = useState<'personal' | 'shared'>('personal');
  const [filterDialog, setFilterDialog] = useState(false);
  const [filterCombinator, setFilterCombinator] = useState<'and' | 'or'>('and');
  const [filterDrafts, setFilterDrafts] = useState<FilterDraft[]>([]);
  const [pasting, setPasting] = useState(false);
  const cursorByPage = React.useRef(new Map<number, string | undefined>([[0, undefined]]));
  const currentUser = useAuthStore((state) => state.currentUser);
  const { menu, openMenu, closeMenu } = useContextMenu();

  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

  const loadSchema = useCallback(async () => {
    const next = await getTableSchema(table.id);
    setSchema(next);
    return next;
  }, [table.id]);

  const loadPage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      let cursor = cursorByPage.current.get(0);
      let result = await queryTableRecords(table.id, {
        where,
        search: search || undefined,
        sort,
        limit: pageSize,
        cursor,
      });
      cursorByPage.current.set(1, result.nextCursor ?? undefined);
      for (let currentPage = 1; currentPage <= page; currentPage += 1) {
        cursor = cursorByPage.current.get(currentPage);
        if (!cursor) {
          result = { ...result, records: [] };
          break;
        }
        result = await queryTableRecords(table.id, {
          where,
          search: search || undefined,
          sort,
          limit: pageSize,
          cursor,
        });
        cursorByPage.current.set(currentPage + 1, result.nextCursor ?? undefined);
      }
      setRecords(result.records);
      setTotal(result.total);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tables.loadRecordsFailed'));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, sort, table.id, where, t]);

  useEffect(() => {
    setSchema(null);
    setPage(0);
    setSelectedViewId('');
    setWhere(undefined);
    cursorByPage.current = new Map([[0, undefined]]);
    void loadSchema().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : t('tables.loadSchemaFailed'));
    });
  }, [loadSchema, t]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const resetQuery = (nextSearch = search, nextSort = sort, nextWhere = where) => {
    cursorByPage.current = new Map([[0, undefined]]);
    setPage(0);
    setSearch(nextSearch);
    setSort(nextSort);
    setWhere(nextWhere);
  };

  const toggleSort = (field: TableField) => {
    const current = sort?.[0];
    const direction = current?.fieldId === field.id && current.direction === 'asc' ? 'desc' : 'asc';
    resetQuery(search, [{ fieldId: field.id, direction }], where);
  };

  const openFieldDialog = (field: TableField | 'new') => {
    const config = field === 'new' ? {} : safeParse<TableFieldConfig>(field.config, {});
    const formula = config.formula?.expression;
    setFieldDialog(field);
    setFieldName(field === 'new' ? '' : field.name);
    setFieldType(field === 'new' ? 'text' : field.type);
    setFieldRequired(field === 'new' ? false : field.required);
    setFieldOptions(field === 'new' ? '' : optionsText(field.config));
    setRelationTargetTableId(config.relation?.targetTableId ?? '');
    setRelationMultiple(config.relation?.multiple === true);
    setFormulaLeftFieldId(formula?.type === 'binary' && formula.left.type === 'field' ? formula.left.fieldId : '');
    setFormulaOperator(formula?.type === 'binary' ? formula.operator : 'concat');
    setFormulaRightFieldId(formula?.type === 'binary' && formula.right.type === 'field' ? formula.right.fieldId : '');
    setFormulaResultType(config.formula?.resultType ?? 'text');
    setRollupRelationFieldId(config.rollup?.relationFieldId ?? '');
    setRollupTargetFieldId(config.rollup?.targetFieldId ?? '');
    setRollupAggregation(config.rollup?.aggregation ?? 'count');
  };

  const relationFields = useMemo(
    () => (schema?.fields ?? []).filter((field) => field.type === 'relation'),
    [schema?.fields],
  );
  const formulaFields = useMemo(
    () => (schema?.fields ?? []).filter((field) => field.type !== 'formula' && field.type !== 'rollup'),
    [schema?.fields],
  );
  const rollupTargetTableId = useMemo(() => {
    const relationField = relationFields.find((field) => field.id === rollupRelationFieldId);
    return relationField ? safeParse<TableFieldConfig>(relationField.config, {}).relation?.targetTableId : undefined;
  }, [relationFields, rollupRelationFieldId]);

  useEffect(() => {
    const targetTableId =
      fieldType === 'relation'
        ? relationTargetTableId || undefined
        : fieldType === 'rollup'
          ? rollupTargetTableId
          : undefined;
    if (!targetTableId) {
      setModelTargetFields([]);
      return;
    }
    void getTableSchema(targetTableId).then((targetSchema) => setModelTargetFields(targetSchema.fields));
  }, [fieldType, relationTargetTableId, rollupTargetTableId]);

  const saveField = async () => {
    if (!fieldDialog || !fieldName.trim()) return;
    setSavingField(true);
    setError('');
    try {
      const config: TableFieldConfig | undefined =
        fieldType === 'single_select' || fieldType === 'multi_select'
          ? optionConfig(fieldOptions, fieldDialog === 'new' ? {} : safeParse<TableFieldConfig>(fieldDialog.config, {}))
          : fieldType === 'relation' && relationTargetTableId !== ''
            ? { relation: { targetTableId: relationTargetTableId, multiple: relationMultiple } }
            : fieldType === 'formula' && formulaLeftFieldId !== '' && formulaRightFieldId !== ''
              ? {
                  formula: {
                    resultType: formulaResultType,
                    expression: {
                      type: 'binary',
                      operator: formulaOperator,
                      left: { type: 'field', fieldId: formulaLeftFieldId },
                      right: { type: 'field', fieldId: formulaRightFieldId },
                    },
                  },
                }
              : fieldType === 'rollup' && rollupRelationFieldId !== '' && rollupTargetFieldId !== ''
                ? {
                    rollup: {
                      relationFieldId: rollupRelationFieldId,
                      targetFieldId: rollupTargetFieldId,
                      aggregation: rollupAggregation,
                    },
                  }
                : undefined;
      if ((fieldType === 'relation' || fieldType === 'formula' || fieldType === 'rollup') && !config) {
        throw new Error(t('tables.completeFieldConfiguration', { type: t(FIELD_LABEL_KEYS[fieldType]) }));
      }
      if (fieldDialog === 'new') {
        await createTableField(table.id, {
          name: fieldName.trim(),
          type: fieldType,
          required: fieldType === 'formula' || fieldType === 'rollup' ? false : fieldRequired,
          config,
        });
      } else {
        await updateTableField(fieldDialog.id, { name: fieldName.trim(), required: fieldRequired, config });
      }
      setFieldDialog(null);
      await loadSchema();
      await loadPage();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.saveFieldFailed'));
    } finally {
      setSavingField(false);
    }
  };

  const saveRecord = async (values: TableRecordValues) => {
    setSavingRecord(true);
    try {
      if (recordDialog === 'new') await createTableRecord(table.id, values);
      else if (recordDialog) await updateTableRecord(table.id, recordDialog.id, recordDialog.revision, values);
      setRecordDialog(null);
      await loadPage();
    } finally {
      setSavingRecord(false);
    }
  };

  const selectView = (viewId: string) => {
    setSelectedViewId(viewId);
    const view = schema?.views.find((entry) => String(entry.id) === viewId);
    if (!view) return resetQuery('', [{ systemField: 'updated_at', direction: 'desc' }], undefined);
    const config = safeParse<TableViewConfig>(view.config, {});
    resetQuery(
      config.query?.search ?? '',
      config.query?.sort ?? [{ systemField: 'updated_at', direction: 'desc' }],
      config.query?.where,
    );
  };

  const openFilters = () => {
    setFilterCombinator(where?.combinator ?? 'and');
    setFilterDrafts(
      (where?.clauses ?? []).map((clause) => ({
        fieldId: clause.fieldId,
        operator: clause.operator,
        value: Array.isArray(clause.value) ? clause.value.join(', ') : String(clause.value ?? ''),
      })),
    );
    setFilterDialog(true);
  };

  const applyFilters = () => {
    try {
      const clauses = filterDrafts.map((draft): TableFilterClause => {
        const field = schema?.fields.find((entry) => entry.id === draft.fieldId);
        if (!field) throw new Error(t('tables.chooseEveryFilterField'));
        return { fieldId: field.id, operator: draft.operator, value: filterValue(field, draft, users) };
      });
      resetQuery(search, sort, clauses.length > 0 ? { combinator: filterCombinator, clauses } : undefined);
      setFilterDialog(false);
      setError('');
    } catch (filterError) {
      setError(filterError instanceof Error ? filterError.message : t('tables.applyFiltersFailed'));
    }
  };

  const commitCell = async (record: TableRecord, field: TableField, value: unknown) => {
    const updated = await updateTableRecord(table.id, record.id, record.revision, { [String(field.id)]: value });
    setRecords((current) => current.map((entry) => (entry.id === record.id ? updated : entry)));
  };

  const pasteAt = async (rowIndex: number, columnIndex: number, event: React.ClipboardEvent<HTMLDivElement>) => {
    if (!canEdit) return;
    event.preventDefault();
    setPasting(true);
    setError('');
    try {
      const matrix = parseClipboardMatrix(event.clipboardData.getData('text/plain'));
      const items = buildPasteBatch({
        matrix,
        startRow: rowIndex,
        startColumn: columnIndex,
        records,
        fields: visibleFields,
        users,
      });
      if (items.length === 0 || items.length > 100) throw new Error(t('tables.pasteRowLimit'));
      const validation = await validateTableRecordBatch(table.id, items);
      const invalid = validation.filter((result) => !result.ok);
      if (invalid.length > 0) {
        const first = invalid[0]!;
        throw new Error(
          t('tables.pasteValidationFailed', {
            row: first.index + 1,
            detail: first.message ? `: ${first.message}` : ` (${first.reason})`,
          }),
        );
      }
      const results = await upsertTableRecordBatch(table.id, items);
      const failed = results.find((result) => !result.ok);
      if (failed && !failed.ok)
        throw new Error(failed.message || t('tables.pasteFailedReason', { reason: failed.reason }));
      await loadPage();
    } catch (pasteError) {
      setError(pasteError instanceof Error ? pasteError.message : t('tables.pasteFailed'));
    } finally {
      setPasting(false);
    }
  };

  const selectedView = useMemo(
    () => schema?.views.find((entry) => String(entry.id) === selectedViewId) ?? null,
    [schema, selectedViewId],
  );
  const selectedViewConfig = useMemo(
    () => (selectedView ? safeParse<TableViewConfig>(selectedView.config, {}) : {}),
    [selectedView],
  );

  const visibleFields = useMemo(() => {
    const ids = selectedViewConfig.fieldIds?.length ? new Set(selectedViewConfig.fieldIds) : null;
    return (schema?.fields ?? []).filter((field) => !ids || ids.has(field.id));
  }, [schema?.fields, selectedViewConfig.fieldIds]);

  const frozenCount = Math.min(selectedViewConfig.frozenCount ?? 0, visibleFields.length, MAX_FROZEN_COLUMNS);

  /**
   * Frozen columns need a real pixel offset, and the only honest source is the
   * rendered table: column widths come from content and `min-w-40`, never from
   * config, so computing them from `widths` would drift the moment a cell is
   * wider than expected.
   */
  const headerCells = React.useRef<Array<HTMLTableCellElement | null>>([]);
  const [columnWidths, setColumnWidths] = useState<number[]>([]);

  useEffect(() => {
    if (frozenCount === 0) return;
    const measure = () => {
      const next = headerCells.current.map((cell) => cell?.offsetWidth ?? 0);
      setColumnWidths((current) =>
        current.length === next.length && current.every((width, index) => width === next[index]) ? current : next,
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    for (const cell of headerCells.current) if (cell) observer.observe(cell);
    return () => observer.disconnect();
  }, [frozenCount, records, visibleFields]);

  /** Left edge of data column `index`, past the row-number column at slot 0. */
  const frozenOffset = (index: number) => columnWidths.slice(0, index + 1).reduce((total, width) => total + width, 0);

  /**
   * Editing a shared view needs builder; your own personal view needs editor —
   * the same split the server enforces, so the menu never offers a freeze that
   * would come back as a 404.
   */
  const canReorderView =
    selectedView === null
      ? canEdit
      : selectedView.scope === 'personal' && selectedView.owner_id === currentUser?.id
        ? canEdit
        : canBuild;

  const columnMenu = (field: TableField, columnIndex: number): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (canBuild) items.push({ label: t('tables.editField'), icon: Edit3, onClick: () => openFieldDialog(field) });
    if (canReorderView) {
      if (columnIndex < MAX_FROZEN_COLUMNS && frozenCount !== columnIndex + 1) {
        items.push({
          label: t('tables.freezeToColumn'),
          icon: Pin,
          onClick: () => void applyFrozenCount(columnIndex + 1),
        });
      }
      if (frozenCount > 0) {
        items.push({ label: t('tables.unfreezeColumns'), icon: PinOff, onClick: () => void applyFrozenCount(0) });
      }
    }
    return items;
  };

  const applyFrozenCount = async (next: number) => {
    // Frozen columns live on a view; the unsaved "Default view" has nowhere to
    // put them, so send the user through the existing Save view flow instead of
    // silently dropping the choice.
    if (!selectedView) {
      setPendingFrozenCount(next);
      setViewDialog(true);
      return;
    }
    setError('');
    try {
      await updateTableView(selectedView.id, {
        revision: selectedView.revision,
        config: { ...selectedViewConfig, frozenCount: next },
      });
      await loadSchema();
    } catch (freezeError) {
      setError(freezeError instanceof Error ? freezeError.message : t('tables.freezeFailed'));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-raised">
      <TablesGridToolbar
        views={schema?.views ?? []}
        selectedViewId={selectedViewId}
        search={search}
        filterCount={where?.clauses.length ?? 0}
        canEdit={canEdit}
        canBuild={canBuild}
        pasting={pasting}
        onSelectView={selectView}
        onSearch={(value) => resetQuery(value, sort, where)}
        onOpenFilters={openFilters}
        onSaveView={() => setViewDialog(true)}
        onOpenRecycleBin={() => setRecycleBin(true)}
        onOpenForms={() => setFormsDialog(true)}
        onAddField={() => openFieldDialog('new')}
        onAddRecord={() => setRecordDialog('new')}
      />

      {error && (
        <div className="flex-shrink-0 border-b border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && records.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="h-6 w-6 text-fg-faint" />
          </div>
        ) : visibleFields.length === 0 ? (
          <EmptyState icon={LayoutGrid} title={t('tables.noFields')} description={t('tables.noFieldsDescription')} />
        ) : (
          <table className="min-w-full border-separate border-spacing-0 text-left">
            <thead className="sticky top-0 z-10 bg-surface-sunken">
              <tr>
                <th
                  ref={(cell) => {
                    headerCells.current[0] = cell;
                  }}
                  className="sticky left-0 z-20 w-16 border-b border-r border-edge bg-surface-sunken px-3 py-2 text-[11px] font-medium text-fg-faint"
                >
                  #
                </th>
                {visibleFields.map((field, columnIndex) => {
                  const activeSort = sort?.[0]?.fieldId === field.id ? sort[0] : null;
                  const frozen = columnIndex < frozenCount;
                  return (
                    <th
                      key={field.id}
                      ref={(cell) => {
                        headerCells.current[columnIndex + 1] = cell;
                      }}
                      style={frozen ? { left: frozenOffset(columnIndex) } : undefined}
                      className={`min-w-40 border-b border-r border-edge px-3 py-2 text-xs font-medium text-fg-secondary ${
                        frozen ? 'sticky z-20 bg-surface-sunken' : ''
                      }`}
                      onContextMenu={(event) => openMenu(event, columnMenu(field, columnIndex))}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-1 hover:text-fg"
                          onClick={() => toggleSort(field)}
                        >
                          <span className="truncate" title={field.name}>
                            {field.name}
                          </span>
                          {activeSort?.direction === 'asc' && <ArrowUp size={11} />}
                          {activeSort?.direction === 'desc' && <ArrowDown size={11} />}
                        </button>
                        {/*
                          No z-index on the wrapper: the tooltip is portalled to
                          the body, so it needed none, and a stacking context
                          here would paint this button of a scrolled-under
                          column on top of the frozen ones.
                        */}
                        <IconButton
                          label={t('tables.columnOptions', { name: field.name })}
                          tooltip="top"
                          tooltipMode="portal"
                          onClick={(event) => openMenu(event, columnMenu(field, columnIndex))}
                          className="h-6 w-6 sm:h-6 sm:w-6"
                        >
                          <MoreHorizontal size={12} />
                        </IconButton>
                      </div>
                    </th>
                  );
                })}
                <th
                  className={`sticky right-0 z-20 border-b border-edge bg-surface-sunken px-3 py-2 text-xs font-medium text-fg-secondary ${
                    canEdit ? 'w-28' : 'w-12'
                  }`}
                >
                  {t('common.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {records.map((record, rowIndex) => (
                <tr
                  key={record.id}
                  className="group cursor-pointer hover:bg-surface-sunken"
                  /* A plain click anywhere in the row opens it — cells no longer
                     swallow the click to disambiguate a double-click. */
                  onClick={() => setDetailRecord(record)}
                >
                  <td className="sticky left-0 z-[5] border-b border-r border-edge bg-surface-raised px-3 py-2 text-xs text-fg-faint group-hover:bg-surface-sunken">
                    {record.id}
                  </td>
                  {visibleFields.map((field, columnIndex) => (
                    <td
                      key={field.id}
                      style={columnIndex < frozenCount ? { left: frozenOffset(columnIndex) } : undefined}
                      className={`max-w-80 border-b border-r border-edge px-2 py-1.5 text-xs text-fg-secondary ${
                        columnIndex < frozenCount ? 'sticky z-[5] bg-surface-raised group-hover:bg-surface-sunken' : ''
                      }`}
                    >
                      <InlineCell
                        field={field}
                        value={
                          record.computed_values[String(field.id)] === undefined
                            ? record.values[String(field.id)]
                            : record.computed_values[String(field.id)]
                        }
                        users={users}
                        canEdit={canEdit && field.type !== 'formula' && field.type !== 'rollup'}
                        onCommit={(value) => commitCell(record, field, value)}
                        onPaste={(event) => void pasteAt(rowIndex, columnIndex, event)}
                      >
                        {renderTableFieldValue(
                          field,
                          record.computed_values[String(field.id)] === undefined
                            ? record.values[String(field.id)]
                            : record.computed_values[String(field.id)],
                          usersById,
                        )}
                      </InlineCell>
                    </td>
                  ))}
                  <td
                    className="sticky right-0 z-[5] border-b border-edge bg-surface-raised px-2 py-1 group-hover:bg-surface-sunken"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <RecordRowActions
                      record={record}
                      canEdit={canEdit}
                      onView={setDetailRecord}
                      onEdit={setRecordDialog}
                      onDelete={setDeleteRecord}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          cursorByPage.current = new Map([[0, undefined]]);
          setPage(0);
          setPageSize(size);
        }}
      />

      {menu && <ContextMenu {...menu} onClose={closeMenu} />}

      <RecycleBinDrawer
        open={recycleBin}
        tableId={table.id}
        primaryField={schema?.fields.find((field) => field.is_primary) ?? schema?.fields[0]}
        usersById={usersById}
        onClose={() => setRecycleBin(false)}
        onRestored={() => void loadPage()}
      />

      {schema && (
        <>
          <RecordDialog
            open={recordDialog !== null}
            baseId={table.base_id}
            fields={schema.fields}
            record={recordDialog === 'new' ? null : recordDialog}
            users={users}
            saving={savingRecord}
            onClose={() => setRecordDialog(null)}
            onSave={saveRecord}
          />
          <RecordDetailDrawer
            tableName={table.name}
            record={detailRecord}
            fields={schema.fields}
            users={users}
            canEdit={canEdit}
            onClose={() => setDetailRecord(null)}
            onEdit={() => {
              if (!detailRecord) return;
              setRecordDialog(detailRecord);
              setDetailRecord(null);
            }}
          />
          <TablesFormsDialog
            open={formsDialog}
            tableId={table.id}
            fields={schema.fields}
            onClose={() => setFormsDialog(false)}
          />
        </>
      )}

      <Dialog
        open={fieldDialog !== null}
        onClose={() => setFieldDialog(null)}
        title={fieldDialog === 'new' ? t('tables.newField') : t('tables.fieldSettings')}
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-fg-muted">{t('common.name')}</label>
            <Input value={fieldName} onChange={(event) => setFieldName(event.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.type')}</label>
            <Select
              value={fieldType}
              disabled={fieldDialog !== 'new'}
              onChange={(event) => setFieldType(event.target.value as TableFieldType)}
            >
              {TABLE_FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(FIELD_LABEL_KEYS[type])}
                </option>
              ))}
            </Select>
          </div>
          <Checkbox
            label={t('tables.required')}
            checked={fieldRequired}
            disabled={fieldType === 'formula' || fieldType === 'rollup'}
            onChange={(event) => setFieldRequired(event.target.checked)}
          />
          {(fieldType === 'single_select' || fieldType === 'multi_select') && (
            <div>
              <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.optionsPerLine')}</label>
              <Textarea rows={6} value={fieldOptions} onChange={(event) => setFieldOptions(event.target.value)} />
            </div>
          )}
          {fieldType === 'relation' && (
            <div className="space-y-3 rounded-md border border-edge bg-surface-sunken p-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.relatedTable')}</label>
                <Select
                  value={relationTargetTableId}
                  onChange={(event) => setRelationTargetTableId(event.target.value ? Number(event.target.value) : '')}
                >
                  <option value="">{t('tables.chooseTable')}</option>
                  {tables.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Checkbox
                label={t('tables.allowMultipleRelations')}
                checked={relationMultiple}
                onChange={(event) => setRelationMultiple(event.target.checked)}
              />
            </div>
          )}
          {fieldType === 'formula' && (
            <div className="grid grid-cols-1 gap-3 rounded-md border border-edge bg-surface-sunken p-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.leftField')}</label>
                <Select
                  value={formulaLeftFieldId}
                  onChange={(event) => setFormulaLeftFieldId(event.target.value ? Number(event.target.value) : '')}
                >
                  <option value="">{t('tables.chooseField')}</option>
                  {formulaFields.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.operator')}</label>
                <Select
                  value={formulaOperator}
                  onChange={(event) => setFormulaOperator(event.target.value as TableFormulaBinaryOperator)}
                >
                  <option value="concat">{t('tables.formula.concat')}</option>
                  <option value="add">{t('tables.formula.add')}</option>
                  <option value="subtract">{t('tables.formula.subtract')}</option>
                  <option value="multiply">{t('tables.formula.multiply')}</option>
                  <option value="divide">{t('tables.formula.divide')}</option>
                  <option value="eq">{t('tables.formula.eq')}</option>
                  <option value="neq">{t('tables.formula.neq')}</option>
                  <option value="gt">{t('tables.formula.gt')}</option>
                  <option value="gte">{t('tables.formula.gte')}</option>
                  <option value="lt">{t('tables.formula.lt')}</option>
                  <option value="lte">{t('tables.formula.lte')}</option>
                  <option value="and">{t('tables.formula.and')}</option>
                  <option value="or">{t('tables.formula.or')}</option>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.rightField')}</label>
                <Select
                  value={formulaRightFieldId}
                  onChange={(event) => setFormulaRightFieldId(event.target.value ? Number(event.target.value) : '')}
                >
                  <option value="">{t('tables.chooseField')}</option>
                  {formulaFields.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.resultType')}</label>
                <Select
                  value={formulaResultType}
                  onChange={(event) => setFormulaResultType(event.target.value as TableFormulaResultType)}
                >
                  <option value="text">{t('tables.fieldType.text')}</option>
                  <option value="number">{t('tables.fieldType.number')}</option>
                  <option value="boolean">{t('tables.fieldType.booleanValue')}</option>
                  <option value="date">{t('tables.fieldType.date')}</option>
                  <option value="datetime">{t('tables.fieldType.datetime')}</option>
                </Select>
              </div>
              <p className="text-[11px] text-fg-faint sm:col-span-2">{t('tables.formulaSafety')}</p>
            </div>
          )}
          {fieldType === 'rollup' && (
            <div className="grid grid-cols-1 gap-3 rounded-md border border-edge bg-surface-sunken p-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.relationField')}</label>
                <Select
                  value={rollupRelationFieldId}
                  onChange={(event) => {
                    setRollupRelationFieldId(event.target.value ? Number(event.target.value) : '');
                    setRollupTargetFieldId('');
                  }}
                >
                  <option value="">{t('tables.chooseRelation')}</option>
                  {relationFields.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.targetField')}</label>
                <Select
                  value={rollupTargetFieldId}
                  disabled={!rollupTargetTableId}
                  onChange={(event) => setRollupTargetFieldId(event.target.value ? Number(event.target.value) : '')}
                >
                  <option value="">{t('tables.chooseTargetField')}</option>
                  {modelTargetFields.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.aggregation')}</label>
                <Select
                  value={rollupAggregation}
                  onChange={(event) => setRollupAggregation(event.target.value as TableRollupAggregation)}
                >
                  <option value="count">{t('tables.aggregationType.count')}</option>
                  <option value="sum">{t('tables.aggregationType.sum')}</option>
                  <option value="avg">{t('tables.aggregationType.avg')}</option>
                  <option value="min">{t('tables.aggregationType.min')}</option>
                  <option value="max">{t('tables.aggregationType.max')}</option>
                  <option value="join">{t('tables.aggregationType.join')}</option>
                </Select>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-edge pt-4">
            {fieldDialog && fieldDialog !== 'new' && !fieldDialog.is_primary ? (
              <Button
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  setArchiveField(fieldDialog);
                  setFieldDialog(null);
                }}
              >
                <Archive size={13} className="mr-1.5" />
                {t('common.archive')}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setFieldDialog(null)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void saveField()} disabled={savingField || !fieldName.trim()}>
                {savingField ? t('common.saving') : t('tables.saveField')}
              </Button>
            </div>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={viewDialog}
        onClose={() => {
          setViewDialog(false);
          setPendingFrozenCount(null);
        }}
        title={t('tables.saveCurrentView')}
      >
        <div className="space-y-4">
          {pendingFrozenCount !== null && (
            <p className="rounded-md bg-info-subtle px-3 py-2 text-xs text-info">
              {t('tables.frozenColumnsHint', { count: pendingFrozenCount })}
            </p>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-fg-muted">{t('common.name')}</label>
            <Input
              value={viewName}
              onChange={(event) => setViewName(event.target.value)}
              placeholder={t('tables.viewNamePlaceholder')}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.scope')}</label>
            <Select value={viewScope} onChange={(event) => setViewScope(event.target.value as 'personal' | 'shared')}>
              <option value="personal">{t('tables.onlyMe')}</option>
              {canBuild && <option value="shared">{t('tables.everyoneInBase')}</option>}
            </Select>
          </div>
          <div className="flex justify-end gap-2 border-t border-edge pt-4">
            <Button
              variant="ghost"
              onClick={() => {
                setViewDialog(false);
                setPendingFrozenCount(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              disabled={!viewName.trim()}
              onClick={() =>
                void createTableView(table.id, {
                  name: viewName.trim(),
                  scope: viewScope,
                  config: {
                    fieldIds: visibleFields.map((field) => field.id),
                    ...(pendingFrozenCount === null ? {} : { frozenCount: pendingFrozenCount }),
                    query: { where, search: search || undefined, sort },
                  },
                }).then(async (view) => {
                  setViewDialog(false);
                  setViewName('');
                  const next = await loadSchema();
                  // Select it, or the freeze the user just asked for would sit
                  // in a view they are not looking at.
                  if (next.views.some((entry) => entry.id === view.id)) selectView(String(view.id));
                  setPendingFrozenCount(null);
                })
              }
            >
              {t('tables.saveView')}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={filterDialog} onClose={() => setFilterDialog(false)} title={t('tables.filterRecords')} size="lg">
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            {t('tables.match')}
            <Select
              inline
              size="sm"
              value={filterCombinator}
              onChange={(event) => setFilterCombinator(event.target.value as 'and' | 'or')}
            >
              <option value="and">{t('tables.allConditions')}</option>
              <option value="or">{t('tables.anyCondition')}</option>
            </Select>
          </div>
          <div className="space-y-2">
            {filterDrafts.map((draft, index) => {
              const field = schema?.fields.find((entry) => entry.id === draft.fieldId);
              const noValue = draft.operator === 'is_empty' || draft.operator === 'is_not_empty';
              return (
                <div
                  key={`${draft.fieldId}-${index}`}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
                >
                  <Select
                    value={draft.fieldId || ''}
                    onChange={(event) => {
                      const fieldId = Number(event.target.value);
                      setFilterDrafts((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, fieldId, operator: 'eq', value: '' } : entry,
                        ),
                      );
                    }}
                  >
                    <option value="">{t('tables.chooseField')}</option>
                    {(schema?.fields ?? []).map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </Select>
                  <Select
                    value={draft.operator}
                    onChange={(event) =>
                      setFilterDrafts((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index
                            ? { ...entry, operator: event.target.value as TableFilterOperator }
                            : entry,
                        ),
                      )
                    }
                  >
                    {filterOperators(field).map((operator) => (
                      <option key={operator} value={operator}>
                        {FILTER_LABEL_KEYS[operator] ? t(FILTER_LABEL_KEYS[operator]) : operator}
                      </option>
                    ))}
                  </Select>
                  <Input
                    value={draft.value}
                    disabled={noValue}
                    placeholder={noValue ? t('tables.noValueNeeded') : t('tables.value')}
                    onChange={(event) =>
                      setFilterDrafts((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, value: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                  <IconButton
                    label={t('tables.removeFilter')}
                    tooltipMode="portal"
                    onClick={() =>
                      setFilterDrafts((current) => current.filter((_, entryIndex) => entryIndex !== index))
                    }
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              );
            })}
            {filterDrafts.length === 0 && (
              <p className="rounded-md border border-dashed border-edge px-3 py-6 text-center text-xs text-fg-faint">
                {t('tables.noFilterConditions')}
              </p>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-edge pt-4">
            <Button
              variant="outline"
              onClick={() =>
                setFilterDrafts((current) => [
                  ...current,
                  { fieldId: schema?.fields[0]?.id ?? 0, operator: 'eq', value: '' },
                ])
              }
              disabled={!schema?.fields.length || filterDrafts.length >= 20}
            >
              <Plus size={13} className="mr-1.5" />
              {t('tables.condition')}
            </Button>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  resetQuery(search, sort, undefined);
                  setFilterDialog(false);
                }}
              >
                {t('common.clear')}
              </Button>
              <Button onClick={applyFilters}>{t('tables.applyFilters')}</Button>
            </div>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleteRecord !== null}
        onClose={() => setDeleteRecord(null)}
        onConfirm={() => {
          if (!deleteRecord) return;
          void deleteTableRecord(table.id, deleteRecord.id, deleteRecord.revision).then(async () => {
            setDeleteRecord(null);
            await loadPage();
          });
        }}
        title={t('tables.deleteRecordTitle')}
        description={t('tables.deleteRecordDescription')}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
      <ConfirmDialog
        open={archiveField !== null}
        onClose={() => setArchiveField(null)}
        onConfirm={() => {
          if (!archiveField) return;
          void archiveTableField(archiveField.id).then(async () => {
            setArchiveField(null);
            await loadSchema();
          });
        }}
        title={t('tables.archiveFieldTitle', { name: archiveField?.name ?? t('tables.field') })}
        description={t('tables.archiveFieldDescription')}
        confirmLabel={t('common.archive')}
        confirmVariant="destructive"
      />
    </div>
  );
}
