/**
 * The view container of one table: loads the schema and pages of records for
 * the current query (view, search, filters, sort), owns every dialog (record,
 * field, save view, filter, forms, recycle bin), the record drawer and the
 * toolbar, and hands the records to the body for the view's type (./views).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TableBaseRole, TableRecordValues, TableViewConfig, TableViewScope } from '@greenhouse/types/tables';
import type { TableBaseAccessView } from '@greenhouse/types/table-access';
import {
  archiveTableField,
  createTableRecord,
  createTableView,
  deleteTableRecord,
  getTableRecord,
  getTableSchema,
  updateTableRecord,
  updateTableView,
  upsertTableRecordBatch,
  validateTableRecordBatch,
  type TableDefinition,
  type TableField,
  type TableRecord,
  type TableSchema,
  type TableUserOption,
} from '../../lib/api/tables';
import { ConfirmDialog, Pagination, Spinner } from '../../components/ui';
import { safeParse } from '../../lib/utils';
import { useAuthStore } from '../../stores';
import { useT } from '../../lib/i18n';
import { RecordDialog } from './record-dialog';
import { RecordDetailDrawer } from './record-drawer/record-detail-drawer';
import { RecycleBinDrawer } from './recycle-bin-drawer';
import { buildPasteBatch, parseClipboardMatrix } from './grid-utils';
import { TablesViewToolbar } from './view-toolbar';
import { TablesFormsDialog } from './forms-dialog';
import { FieldSettingsDialog } from './field-settings-dialog';
import { SaveViewDialog } from './save-view-dialog';
import { FilterDialog } from './filter-dialog';
import { viewBodyFor, type TableViewPermissions } from './views';
import { orderedViewFields } from './view-fields';
import { DEFAULT_RECORD_SORT, useRecordQuery } from './use-record-query';
import { tableCapabilities } from './capabilities';
import { isComputedField } from '../../components/tables/field-types';

interface TablesViewContainerProps {
  table: TableDefinition;
  tables: TableDefinition[];
  role: TableBaseRole;
  /** The effective access (`getBase.access`); a custom role's per-table view narrows every affordance. Default: `role`. */
  access?: TableBaseAccessView;
  users: TableUserOption[];
  /** `?record=<id>` on the route: open this record's drawer. */
  focusRecordId?: number;
}

export function TablesViewContainer({ table, tables, role, access, users, focusRecordId }: TablesViewContainerProps) {
  const t = useT();
  // One mirror of the server's decision (built-in role or compiled custom role):
  // nothing below offers a write the server would refuse.
  const capabilities = useMemo(() => tableCapabilities(access ?? { level: role }, table), [access, role, table]);
  const { canEdit, canBuild } = capabilities;
  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [selectedViewId, setSelectedViewId] = useState('');
  const [error, setError] = useState('');
  const query = useRecordQuery(table.id, setError);
  const { records, search, sort, where, setQuery } = query;
  const [detailRecord, setDetailRecord] = useState<TableRecord | null>(null);
  const [recordDialog, setRecordDialog] = useState<TableRecord | 'new' | null>(null);
  const [savingRecord, setSavingRecord] = useState(false);
  const [deleteRecord, setDeleteRecord] = useState<TableRecord | null>(null);
  const [fieldDialog, setFieldDialog] = useState<TableField | 'new' | null>(null);
  const [archiveField, setArchiveField] = useState<TableField | null>(null);
  const [viewDialog, setViewDialog] = useState(false);
  /** A view-only change made on the unsaved default view, carried into Save view. */
  const [pendingConfig, setPendingConfig] = useState<Partial<TableViewConfig> | null>(null);
  const [recycleBin, setRecycleBin] = useState(false);
  const [formsDialog, setFormsDialog] = useState(false);
  const [filterDialog, setFilterDialog] = useState(false);
  const [pasting, setPasting] = useState(false);
  const currentUser = useAuthStore((state) => state.currentUser);

  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

  const loadSchema = useCallback(async () => {
    const next = await getTableSchema(table.id);
    setSchema(next);
    return next;
  }, [table.id]);

  useEffect(() => {
    void loadSchema().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : t('tables.loadSchemaFailed'));
    });
  }, [loadSchema, t]);

  // `#/tables/<base>/table/<table>?record=<id>` (entity links, notifications,
  // drill-down) opens that record, whether or not it is on the current page.
  useEffect(() => {
    if (!focusRecordId) return;
    let cancelled = false;
    getTableRecord(table.id, focusRecordId)
      .then((record) => {
        if (!cancelled) setDetailRecord(record);
      })
      .catch(() => {
        if (!cancelled) setError(t('tables.recordNotFound', { id: focusRecordId }));
      });
    return () => {
      cancelled = true;
    };
  }, [focusRecordId, table.id, t]);

  const closeDetail = () => {
    setDetailRecord(null);
    // Drop `?record=` so closing sticks and the same link opens it again later.
    if (focusRecordId) window.location.replace(`#/tables/${table.base_id}/table/${table.id}`);
  };

  const refreshDetail = async () => {
    if (detailRecord) {
      try {
        setDetailRecord(await getTableRecord(table.id, detailRecord.id));
      } catch {
        setDetailRecord(null);
      }
    }
    await query.reload();
  };

  const toggleSort = (field: TableField) => {
    const current = sort?.[0];
    const direction = current?.fieldId === field.id && current.direction === 'asc' ? 'desc' : 'asc';
    setQuery({ sort: [{ fieldId: field.id, direction }] });
  };

  const saveRecord = async (values: TableRecordValues) => {
    setSavingRecord(true);
    try {
      if (recordDialog === 'new') await createTableRecord(table.id, values);
      else if (recordDialog) await updateTableRecord(table.id, recordDialog.id, recordDialog.revision, values);
      setRecordDialog(null);
      await query.reload();
    } finally {
      setSavingRecord(false);
    }
  };

  const selectView = (viewId: string, views = schema?.views) => {
    setSelectedViewId(viewId);
    const view = views?.find((entry) => String(entry.id) === viewId);
    if (!view) return setQuery({ search: '', sort: DEFAULT_RECORD_SORT, where: undefined });
    const config = safeParse<TableViewConfig>(view.config, {});
    setQuery({
      search: config.query?.search ?? '',
      sort: config.query?.sort ?? DEFAULT_RECORD_SORT,
      where: config.query?.where,
    });
  };

  const commitValue = async (record: TableRecord, field: TableField, value: unknown) => {
    const updated = await updateTableRecord(table.id, record.id, record.revision, { [String(field.id)]: value });
    query.setRecords((current) => current.map((entry) => (entry.id === record.id ? updated : entry)));
  };

  const selectedView = useMemo(
    () => schema?.views.find((entry) => String(entry.id) === selectedViewId) ?? null,
    [schema, selectedViewId],
  );
  const selectedViewConfig = useMemo(
    () => (selectedView ? safeParse<TableViewConfig>(selectedView.config, {}) : {}),
    [selectedView],
  );
  const visibleFields = useMemo(
    () => orderedViewFields(schema?.fields ?? [], selectedViewConfig.fieldIds),
    [schema?.fields, selectedViewConfig.fieldIds],
  );

  const pasteAt = async (rowIndex: number, columnIndex: number, text: string) => {
    if (!canEdit) return;
    setPasting(true);
    setError('');
    try {
      const items = buildPasteBatch({
        matrix: parseClipboardMatrix(text),
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
      await query.reload();
    } catch (pasteError) {
      setError(pasteError instanceof Error ? pasteError.message : t('tables.pasteFailed'));
    } finally {
      setPasting(false);
    }
  };

  /**
   * Editing a shared view needs builder; your own personal view needs editor —
   * the same split the server enforces, so the menu never offers a change that
   * would come back as a 404.
   */
  const permissions: TableViewPermissions = {
    canEdit,
    canBuild,
    canChangeView:
      selectedView === null
        ? capabilities.canSaveView
        : selectedView.scope === 'personal' && selectedView.owner_id === currentUser?.id
          ? capabilities.canSaveView
          : canBuild,
    canEditField: capabilities.canEditField,
    canDelete: capabilities.canDelete,
  };

  // The record dialog writes every field it shows, so it only shows what this
  // person may write (computed fields stay as read-only context).
  const dialogFields = useMemo(
    () => (schema?.fields ?? []).filter((field) => isComputedField(field) || capabilities.canEditField(field.id)),
    [capabilities, schema?.fields],
  );

  const updateViewConfig = async (patch: Partial<TableViewConfig>) => {
    // The unsaved default view has nowhere to keep a view setting, so send the
    // user through Save view instead of silently dropping the choice.
    if (!selectedView) {
      setPendingConfig(patch);
      setViewDialog(true);
      return;
    }
    setError('');
    try {
      await updateTableView(selectedView.id, {
        revision: selectedView.revision,
        config: { ...selectedViewConfig, ...patch },
      });
      await loadSchema();
    } catch (viewError) {
      setError(viewError instanceof Error ? viewError.message : t('tables.freezeFailed'));
    }
  };

  const saveView = async (name: string, scope: TableViewScope) => {
    const view = await createTableView(table.id, {
      name,
      scope,
      config: {
        fieldIds: visibleFields.map((field) => field.id),
        ...pendingConfig,
        query: { where, search: search || undefined, sort },
      },
    });
    setViewDialog(false);
    setPendingConfig(null);
    const next = await loadSchema();
    // Select it, or the setting the user just asked for would sit in a view they are not looking at.
    if (next.views.some((entry) => entry.id === view.id)) selectView(String(view.id), next.views);
  };

  const ViewBody = viewBodyFor(selectedView?.type);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-raised">
      <TablesViewToolbar
        views={schema?.views ?? []}
        selectedViewId={selectedViewId}
        search={search}
        filterCount={where?.clauses.length ?? 0}
        canEdit={canEdit}
        canBuild={canBuild}
        canCreate={capabilities.canCreate}
        canDelete={capabilities.canDelete}
        canSaveView={capabilities.canSaveView}
        pasting={pasting}
        onSelectView={(viewId) => selectView(viewId)}
        onSearch={(value) => setQuery({ search: value })}
        onOpenFilters={() => setFilterDialog(true)}
        onSaveView={() => setViewDialog(true)}
        onOpenRecycleBin={() => setRecycleBin(true)}
        onOpenForms={() => setFormsDialog(true)}
        onAddField={() => setFieldDialog('new')}
        onAddRecord={() => setRecordDialog('new')}
      />

      {error && (
        <div className="flex-shrink-0 border-b border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {query.loading && records.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="h-6 w-6 text-fg-faint" />
          </div>
        ) : (
          <ViewBody
            table={table}
            view={selectedView}
            config={selectedViewConfig}
            fields={visibleFields}
            records={records}
            loading={query.loading}
            users={users}
            usersById={usersById}
            sort={sort}
            permissions={permissions}
            onToggleSort={toggleSort}
            onOpenRecord={setDetailRecord}
            onEditRecord={setRecordDialog}
            onDeleteRecord={setDeleteRecord}
            onCommitValue={commitValue}
            onPaste={(rowIndex, columnIndex, text) => void pasteAt(rowIndex, columnIndex, text)}
            onEditField={setFieldDialog}
            onUpdateViewConfig={updateViewConfig}
          />
        )}
      </div>

      <Pagination
        page={query.page}
        pageSize={query.pageSize}
        total={query.total}
        onPageChange={query.setPage}
        onPageSizeChange={query.setPageSize}
      />

      <RecycleBinDrawer
        open={recycleBin}
        tableId={table.id}
        primaryField={schema?.fields.find((field) => field.is_primary) ?? schema?.fields[0]}
        usersById={usersById}
        onClose={() => setRecycleBin(false)}
        onRestored={() => void query.reload()}
      />

      {schema && (
        <>
          <RecordDialog
            open={recordDialog !== null}
            baseId={table.base_id}
            fields={dialogFields}
            record={recordDialog === 'new' ? null : recordDialog}
            users={users}
            saving={savingRecord}
            onClose={() => setRecordDialog(null)}
            onSave={saveRecord}
          />
          <RecordDetailDrawer
            table={table}
            record={detailRecord}
            fields={schema.fields}
            users={users}
            usersById={usersById}
            canEdit={canEdit}
            onClose={closeDetail}
            onEdit={() => {
              if (!detailRecord) return;
              setRecordDialog(detailRecord);
              closeDetail();
            }}
            onRecordChanged={() => void refreshDetail()}
          />
          <TablesFormsDialog
            open={formsDialog}
            tableId={table.id}
            fields={schema.fields}
            onClose={() => setFormsDialog(false)}
          />
          <FilterDialog
            open={filterDialog}
            value={where}
            fields={schema.fields}
            users={users}
            onClose={() => setFilterDialog(false)}
            onApply={(group) => {
              setQuery({ where: group });
              setFilterDialog(false);
            }}
          />
          <FieldSettingsDialog
            field={fieldDialog}
            table={table}
            tables={tables}
            fields={schema.fields}
            onClose={() => setFieldDialog(null)}
            onSaved={async () => {
              setFieldDialog(null);
              await loadSchema();
              await query.reload();
            }}
            onArchive={(field) => {
              setArchiveField(field);
              setFieldDialog(null);
            }}
          />
        </>
      )}

      <SaveViewDialog
        open={viewDialog}
        canShare={canBuild}
        pendingConfig={pendingConfig}
        onClose={() => {
          setViewDialog(false);
          setPendingConfig(null);
        }}
        onSave={saveView}
      />

      <ConfirmDialog
        open={deleteRecord !== null}
        onClose={() => setDeleteRecord(null)}
        onConfirm={() => {
          if (!deleteRecord) return;
          void deleteTableRecord(table.id, deleteRecord.id, deleteRecord.revision).then(async () => {
            setDeleteRecord(null);
            await query.reload();
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
