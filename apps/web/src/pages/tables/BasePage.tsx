/**
 * A base (TBL-01 to TBL-10): its data tables as tabs, the table's views with their toolbar, the
 * view itself, and the record drawer (`?record=`). Toolbar changes save to the view when the
 * reader may change it, else they stay for this visit with 「另存为视图」.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ClipboardList,
  Download,
  History,
  Pencil,
  Pin,
  PinOff,
  Share2,
  Trash2,
  Upload,
} from 'lucide-react';
import { Badge, Banner, Button, Empty, ErrorBox, Skeleton, type MenuEntry } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import {
  roleAtLeast,
  type Base,
  type Field,
  type RecordValues,
  type TableRecord,
  type View,
  type ViewConfig,
} from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { useSession } from '../../app/session';
import { usePeople } from '../../data/people';
import {
  createRecord,
  putRecords,
  putView,
  queryOf,
  refreshBase,
  saveRecord,
  tablesKeys,
  useBase,
  useViewRecords,
} from '../../data/tables';
import { queryClient } from '../../data/query';
import { api } from '../../lib/api';
import { useMedia, NARROW } from '../../lib/media';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { saveBlob } from '../../lib/save';
import { Page, PageHeader } from '../../shell/Page';
import { useOpenOverlay } from '../../shell/overlays';
import { CalendarView } from './Calendar';
import { DashboardView } from './dashboards/DashboardView';
import { DeleteBaseDialog } from './DeleteBaseDialog';
import { FormsDrawer } from './forms/FormsDrawer';
import { ImportDialog } from './imports/ImportDialog';
import { forgetBase, rememberBase } from './entry';
import { tablesError } from './errors';
import { FieldDialog } from './FieldDialog';
import { GalleryView } from './Gallery';
import { GridView } from './Grid';
import { KanbanView } from './Kanban';
import { type CellLookups } from './model';
import { RecordDrawer } from './RecordDrawer';
import { AuditDrawer, RenameBaseDialog, ShareDialog, TrashDrawer } from './BaseDialogs';
import { TableTabs } from './TableTabs';
import { TimelineView } from './Timeline';
import { Toolbar } from './Toolbar';
import type { ViewProps } from './types';
import { ViewBar } from './ViewBar';
import '../../styles/tables.css';

type Panel = 'share' | 'trash' | 'audit' | 'rename' | 'forms' | 'import' | null;

export function BasePage({
  id,
  table,
  view,
  record,
  dashboard,
}: {
  id: string;
  table?: string;
  view?: string;
  record?: string;
  dashboard?: string;
}) {
  const { t } = useI18n();
  const base = useBase(id);
  const missing = base.error instanceof ApiClientError && (base.error.status === 404 || base.error.status === 403);
  const loaded = !!base.data;
  // The rail's 表格 opens the base seen last; one that is gone sends it back to the list.
  useEffect(() => {
    if (loaded) rememberBase(id);
    else if (missing) forgetBase(id);
  }, [id, loaded, missing]);
  if (base.isPending) {
    return (
      <Page header={<PageHeader title={t('nav.tables')} />} width="canvas">
        <Skeleton lines={6} />
      </Page>
    );
  }
  if (base.isError || !base.data) {
    return (
      <Page header={<PageHeader title={t('nav.tables')} />} width="canvas">
        {missing ? (
          <Empty
            title={
              base.error instanceof ApiClientError && base.error.status === 403
                ? t('tables.noAccess')
                : t('tables.notFound')
            }
            action={<Button onClick={() => navigate({ page: 'tables' })}>{t('tables.allBases')}</Button>}
          />
        ) : (
          <ErrorBox onRetry={() => void base.refetch()}>{tablesError(base.error, t)}</ErrorBox>
        )}
      </Page>
    );
  }
  return <BaseScreen base={base.data} tableId={table} viewId={view} recordId={record} dashboardId={dashboard} />;
}

/** The views of a table in order: shared ones by place, then my personal ones. */
const viewsOf = (base: Base, tableId: string) =>
  base.views
    .filter((entry) => entry.table_id === tableId)
    .sort((a, b) => Number(a.personal) - Number(b.personal) || a.position - b.position);

function BaseScreen({
  base,
  tableId,
  viewId,
  recordId,
  dashboardId,
}: {
  base: Base;
  tableId?: string;
  viewId?: string;
  recordId?: string;
  dashboardId?: string;
}) {
  const { t } = useI18n();
  const { me } = useSession();
  const notify = useNotify();
  const openOverlay = useOpenOverlay();
  const narrow = useMedia(NARROW);
  const { memberById } = usePeople();
  const dashboard = dashboardId
    ? base.views.find((entry) => entry.id === dashboardId && entry.type === 'dashboard')
    : undefined;
  const table = base.tables.find((entry) => entry.id === tableId) ?? base.tables[0];
  const views = table ? viewsOf(base, table.id) : [];
  const view = views.find((entry) => entry.id === viewId) ?? views[0];
  const canEdit = roleAtLeast(base.access, 'editor') && !base.archived_at;
  const canBuild = roleAtLeast(base.access, 'builder') && !base.archived_at;
  const isOwner = base.access === 'owner';

  // The address always names the table and view on screen (or the dashboard).
  useEffect(() => {
    if (dashboard || !table || !view) return;
    if (table.id !== tableId || view.id !== viewId) {
      navigate(
        { page: 'base', id: base.id, table: table.id, view: view.id, ...(recordId ? { record: recordId } : {}) },
        { replace: true },
      );
    }
  }, [base.id, table, view, tableId, viewId, recordId, dashboard]);

  const [drafts, setDrafts] = useState<Record<string, ViewConfig>>({});
  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [editingField, setEditingField] = useState<Field | 'new' | null>(null);
  const [creating, setCreating] = useState<RecordValues | null>(null);
  useEffect(() => setSearch(''), [view?.id]);

  const config: ViewConfig = useMemo(() => (view && drafts[view.id]) ?? view?.config ?? {}, [view, drafts]);
  const query = useMemo(() => queryOf(config, search), [config, search]);
  const records = useViewRecords(table?.id ?? '', query, !!table && !!view);

  // Saves to a view go one after another, each with the revision the one before left; the view
  // shows each change at once, and only the last save puts the server's view back in.
  const saving = useRef(Promise.resolve());
  const pending = useRef(0);
  const saveView = useCallback(
    (target: View, change: { config?: ViewConfig; name?: string; position?: number }) => {
      const cachedView = () =>
        queryClient.getQueryData<Base>(tablesKeys.base(base.id))?.views.find((entry) => entry.id === target.id);
      const now = cachedView() ?? target;
      putView(base.id, { ...now, ...change, config: change.config ?? now.config });
      pending.current += 1;
      saving.current = saving.current.then(async () => {
        try {
          const latest = cachedView() ?? target;
          const saved = await api.tables.views.update(target.id, { revision: latest.revision, ...change });
          pending.current -= 1;
          const shown = cachedView();
          putView(base.id, pending.current > 0 && shown ? { ...shown, revision: saved.revision } : saved);
        } catch (error) {
          pending.current -= 1;
          notify(tablesError(error, t));
          void refreshBase(base.id);
        }
      });
    },
    [base.id, notify, t],
  );

  const onConfig = useCallback(
    (next: ViewConfig) => {
      if (!view) return;
      if (view.editable && !base.archived_at) saveView(view, { config: next });
      else setDrafts((current) => ({ ...current, [view.id]: next }));
    },
    [view, base.archived_at, saveView],
  );

  const lookups: CellLookups = useMemo(
    () => ({
      members: memberById,
      linked: records.data?.linked ?? {},
      files: records.data?.files ?? {},
      timeZone: me?.timezone ?? 'Asia/Shanghai',
    }),
    [memberById, records.data, me?.timezone],
  );

  const openRecord = useCallback(
    (id: string) => navigate({ page: 'base', id: base.id, table: table?.id, view: view?.id, record: id }),
    [base.id, table?.id, view?.id],
  );
  const closeRecord = () => {
    setCreating(null);
    if (recordId) navigate({ page: 'base', id: base.id, table: table?.id, view: view?.id });
  };

  const onChange = useCallback(
    async (target: TableRecord, values: RecordValues) => {
      try {
        await saveRecord(target, values);
      } catch (error) {
        if (error instanceof ApiClientError && error.code === 'stale_revision') {
          const now = (error.details as { record?: TableRecord } | undefined)?.record;
          if (now) {
            // Someone else changed other fields: put this change on top of theirs.
            const untouched = Object.keys(values).every(
              (key) => JSON.stringify(now.values[key] ?? null) === JSON.stringify(target.values[key] ?? null),
            );
            if (untouched) {
              await saveRecord(now, values);
              return;
            }
            putRecords(now.table_id, [now]);
          }
          notify(t('tables.grid.conflict'));
          return;
        }
        throw error;
      }
    },
    [notify, t],
  );

  const onCreate = useCallback(
    async (values: RecordValues) => {
      if (!table) return null;
      try {
        return (await createRecord(table.id, values)).record;
      } catch (error) {
        notify(tablesError(error, t));
        return null;
      }
    },
    [table, notify, t],
  );

  const run = (work: () => Promise<unknown>, done?: string) =>
    void work()
      .then(() => {
        if (done) notify(done);
        return refreshBase(base.id);
      })
      .catch((error: unknown) => notify(tablesError(error, t)));

  const exportCsv = async () => {
    if (!table) return;
    try {
      const file = await api.tables.tables.export(table.id, view?.id);
      saveBlob(file.blob, file.filename);
    } catch (error) {
      notify(tablesError(error, t));
    }
  };

  const menu: MenuEntry[] = [
    ...(isOwner && !base.archived_at
      ? [{ label: t('tables.share'), icon: <Share2 size={icon.md} />, onClick: () => setPanel('share') }]
      : []),
    ...(canEdit
      ? [{ label: t('tables.trash'), icon: <Trash2 size={icon.md} />, onClick: () => setPanel('trash') }]
      : []),
    ...(canBuild && table && !dashboard
      ? [{ label: t('tables.forms'), icon: <ClipboardList size={icon.md} />, onClick: () => setPanel('forms') }]
      : []),
    ...(canEdit && table && !dashboard
      ? [{ label: t('tables.importCsv'), icon: <Upload size={icon.md} />, onClick: () => setPanel('import') }]
      : []),
    { label: t('tables.exportCsv'), icon: <Download size={icon.md} />, onClick: () => void exportCsv() },
    base.pinned
      ? {
          label: t('tables.unpin'),
          icon: <PinOff size={icon.md} />,
          onClick: () => run(() => api.tables.bases.update(base.id, { pinned: false })),
        }
      : {
          label: t('tables.pin'),
          icon: <Pin size={icon.md} />,
          onClick: () => run(() => api.tables.bases.update(base.id, { pinned: true })),
        },
    ...(canBuild
      ? [{ label: t('tables.rename'), icon: <Pencil size={icon.md} />, onClick: () => setPanel('rename') }]
      : []),
    ...(isOwner
      ? [{ label: t('tables.audit'), icon: <History size={icon.md} />, onClick: () => setPanel('audit') }]
      : []),
    ...(isOwner
      ? [
          '-' as const,
          base.archived_at
            ? {
                label: t('tables.restore'),
                icon: <ArchiveRestore size={icon.md} />,
                onClick: () =>
                  run(() => api.tables.bases.restore(base.id), t('tables.restoredToast', { name: base.name })),
              }
            : {
                label: t('tables.archive'),
                icon: <Archive size={icon.md} />,
                onClick: () =>
                  void api.tables.bases
                    .archive(base.id)
                    .then(() => {
                      notify(t('tables.archivedToast', { name: base.name }), {
                        label: t('tables.undo'),
                        onClick: () => run(() => api.tables.bases.restore(base.id)),
                      });
                      return refreshBase(base.id);
                    })
                    .catch((error: unknown) => notify(tablesError(error, t))),
              },
          {
            label: t('tables.delete'),
            icon: <Trash2 size={icon.md} />,
            danger: true,
            onClick: () =>
              openOverlay({ type: 'custom', render: (close) => <DeleteBaseDialog base={base} onClose={close} /> }),
          },
        ]
      : []),
  ];

  const fields = table?.fields ?? [];
  const props: ViewProps | null =
    table && view && records.data
      ? {
          base,
          table,
          fields,
          view,
          config,
          data: records.data,
          lookups,
          canEdit,
          canBuild,
          narrow,
          onOpen: openRecord,
          onChange,
          onCreate,
          onConfig,
          onEditField: (field) => setEditingField(field ?? 'new'),
        }
      : null;

  return (
    <Page
      width="canvas"
      scroll={false}
      className="app-tb-page"
      header={
        <PageHeader
          title={base.name}
          help={base.template_key === 'project' ? t('tables.templateHelp') : undefined}
          badge={
            base.archived_at ? (
              <Badge>{t('tables.archivedBadge')}</Badge>
            ) : base.access === 'viewer' ? (
              <Badge>{t('tables.readOnly')}</Badge>
            ) : undefined
          }
          primary={
            canEdit && table ? (
              <Button kind="primary" onClick={() => setCreating({})}>
                {t('tables.addRecord')}
              </Button>
            ) : undefined
          }
          menu={menu}
        />
      }
    >
      {base.archived_at && isOwner && (
        <Banner
          action={
            <Button
              size="sm"
              onClick={() =>
                run(() => api.tables.bases.restore(base.id), t('tables.restoredToast', { name: base.name }))
              }
            >
              {t('tables.restore')}
            </Button>
          }
        >
          {t('tables.archivedBadge')}
        </Banner>
      )}
      <TableTabs
        base={base}
        current={dashboard ? undefined : table?.id}
        dashboard={dashboard?.id}
        canBuild={canBuild}
      />
      {dashboard ? (
        <div className="app-tb-body">
          <DashboardView key={dashboard.id} base={base} view={dashboard} canBuild={canBuild} narrow={narrow} />
        </div>
      ) : !table ? (
        <div className="app-tb-body">
          <Empty title={t('tables.noTables')} />
        </div>
      ) : (
        <>
          {view && (
            <ViewBar
              base={base}
              table={table}
              views={views}
              current={view}
              canBuild={canBuild}
              draft={drafts[view.id] ?? null}
              onDraftDone={() =>
                setDrafts((current) => {
                  const next = { ...current };
                  delete next[view.id];
                  return next;
                })
              }
              onRename={(target, name) => saveView(target, { name })}
            />
          )}
          {view && (
            <Toolbar
              fields={fields}
              view={view}
              config={config}
              search={search}
              onSearch={setSearch}
              onConfig={onConfig}
              canBuild={canBuild}
              narrow={narrow}
              onAddField={() => setEditingField('new')}
            />
          )}
          <div className="app-tb-body">
            {records.isError ? (
              <ErrorBox onRetry={() => void records.refetch()}>{tablesError(records.error, t)}</ErrorBox>
            ) : !props ? (
              <Skeleton lines={8} />
            ) : (
              <>
                {props.data.truncated && (
                  <Banner>{t('tables.grid.truncated', { count: props.data.items.length })}</Banner>
                )}
                {view!.type === 'grid' && <GridView {...props} />}
                {view!.type === 'kanban' && <KanbanView {...props} />}
                {view!.type === 'calendar' && <CalendarView {...props} />}
                {view!.type === 'gallery' && <GalleryView {...props} />}
                {view!.type === 'timeline' && <TimelineView {...props} />}
              </>
            )}
          </div>
        </>
      )}
      {table && (recordId || creating) && (
        <RecordDrawer
          key={recordId ?? 'new'}
          base={base}
          table={table}
          recordId={recordId}
          initial={creating ?? undefined}
          canEdit={canEdit}
          lookups={lookups}
          onOpen={openRecord}
          onCreated={(created) => {
            setCreating(null);
            openRecord(created.id);
          }}
          onClose={closeRecord}
        />
      )}
      {table && editingField && (
        <FieldDialog
          base={base}
          table={table}
          field={editingField === 'new' ? undefined : editingField}
          onClose={() => setEditingField(null)}
        />
      )}
      {panel === 'share' && <ShareDialog base={base} onClose={() => setPanel(null)} />}
      {panel === 'trash' && <TrashDrawer base={base} onClose={() => setPanel(null)} />}
      {panel === 'audit' && <AuditDrawer base={base} onClose={() => setPanel(null)} />}
      {panel === 'rename' && <RenameBaseDialog base={base} onClose={() => setPanel(null)} />}
      {panel === 'forms' && table && <FormsDrawer base={base} table={table} onClose={() => setPanel(null)} />}
      {panel === 'import' && table && <ImportDialog base={base} table={table} onClose={() => setPanel(null)} />}
    </Page>
  );
}
