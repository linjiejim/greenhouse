import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { TableBaseRole } from '@greenhouse/types/tables';
import { getTableBase, listTableBases, type TableBaseWithRole, type TableBaseWorkspace } from '../../../lib/api/tables';
import { LayoutDashboard, MoreHorizontal, Pencil, Plus, Table2, Trash2 } from '../../../lib/icons';
import { BaseDialog } from '../../tables/base-dialog';
import { ResourceDialog, type TableResource } from '../../tables/resource-dialog';
import { DeleteDialog, type DeletionTarget } from '../../tables/delete-dialog';
import { SidebarPrimaryAction } from '../sidebar-primary-action';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../context-menu';
import { IconButton, Spinner } from '../../ui';
import { useT, type TranslationKey } from '../../../lib/i18n';

interface TablesNavPanelProps {
  subPath: string;
}

const ROLE_RANK: Record<TableBaseRole, number> = { viewer: 0, editor: 1, builder: 2, owner: 3 };

export function TablesNavPanel({ subPath }: TablesNavPanelProps) {
  const t = useT();
  const segments = useMemo(() => subPath.split('/').filter(Boolean), [subPath]);
  const selectedBaseId = Number(segments[0]) || null;
  const selectedType = segments[1] === 'table' || segments[1] === 'dashboard' ? segments[1] : null;
  const selectedResourceId = Number(segments[2]) || null;
  const [bases, setBases] = useState<TableBaseWithRole[]>([]);
  const [workspace, setWorkspace] = useState<TableBaseWorkspace | null>(null);
  const [loadingBases, setLoadingBases] = useState(true);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [baseDialog, setBaseDialog] = useState(false);
  const [editingBase, setEditingBase] = useState<TableBaseWithRole | null>(null);
  const [resourceDialog, setResourceDialog] = useState<'table' | 'dashboard' | null>(null);
  const [editingResource, setEditingResource] = useState<TableResource | null>(null);
  const [deleting, setDeleting] = useState<DeletionTarget | null>(null);
  const [error, setError] = useState('');
  const { menu, openMenu, closeMenu } = useContextMenu();

  const loadBases = useCallback(async () => {
    setLoadingBases(true);
    try {
      setBases(await listTableBases());
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tables.home.loadFailed'));
    } finally {
      setLoadingBases(false);
    }
  }, [t]);

  const loadWorkspace = useCallback(async () => {
    if (!selectedBaseId) {
      setWorkspace(null);
      return;
    }
    setLoadingWorkspace(true);
    try {
      setWorkspace(await getTableBase(selectedBaseId));
      setError('');
    } catch (loadError) {
      setWorkspace(null);
      setError(loadError instanceof Error ? loadError.message : t('tables.home.loadBaseFailed'));
    } finally {
      setLoadingWorkspace(false);
    }
  }, [selectedBaseId, t]);

  useEffect(() => {
    void loadBases();
  }, [loadBases, selectedBaseId]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace, subPath]);

  const canBuild = workspace ? ROLE_RANK[workspace.role] >= ROLE_RANK.builder : false;
  const isOwner = workspace?.role === 'owner';

  const baseMenu = useCallback(
    (base: TableBaseWithRole): ContextMenuItem[] => {
      const items: ContextMenuItem[] = [
        { label: t('common.open'), icon: Table2, onClick: () => (window.location.hash = `#/tables/${base.id}`) },
      ];
      if (base.role === 'owner') {
        items.push(
          { label: t('common.edit'), icon: Pencil, onClick: () => setEditingBase(base) },
          {
            label: t('common.delete'),
            icon: Trash2,
            danger: true,
            onClick: () => setDeleting({ kind: 'base', value: base }),
          },
        );
      }
      return items;
    },
    [t],
  );

  const resourceMenu = useCallback(
    (resource: TableResource): ContextMenuItem[] => {
      const items: ContextMenuItem[] = [
        {
          label: t('common.open'),
          icon: resource.kind === 'table' ? Table2 : LayoutDashboard,
          onClick: () => (window.location.hash = `#/tables/${selectedBaseId}/${resource.kind}/${resource.value.id}`),
        },
      ];
      if (canBuild) items.push({ label: t('common.edit'), icon: Pencil, onClick: () => setEditingResource(resource) });
      // Deleting structure is the Base creator's call, not every builder's.
      if (isOwner) {
        items.push({
          label: t('common.delete'),
          icon: Trash2,
          danger: true,
          onClick: () => setDeleting(resource),
        });
      }
      return items;
    },
    [canBuild, isOwner, selectedBaseId, t],
  );

  /**
   * Right-click and this button open the same menu. Touch devices have no
   * right-click, so without the button those actions would not exist there.
   */
  const rowMenuButton = (label: string, items: ContextMenuItem[]) =>
    items.length > 1 ? (
      <IconButton
        label={label}
        tooltip="top"
        tooltipMode="portal"
        className="h-6 w-6 flex-shrink-0 opacity-0 group-hover:opacity-100 touch-visible sm:h-6 sm:w-6"
        onClick={(event) => {
          event.preventDefault();
          openMenu(event, items);
        }}
      >
        <MoreHorizontal size={13} />
      </IconButton>
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <section className="flex max-h-[40%] min-h-0 flex-col border-b border-edge pb-2">
        <div className="flex-shrink-0 px-3 pb-2">
          <SidebarPrimaryAction icon={Plus} onClick={() => setBaseDialog(true)}>
            {t('tables.sidebar.newBase')}
          </SidebarPrimaryAction>
        </div>
        <div className="flex items-center px-3 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
            {t('tables.sidebar.bases')}
          </span>
        </div>
        <div className="min-h-0 overflow-y-auto">
          {loadingBases && bases.length === 0 ? (
            <div className="flex justify-center py-5">
              <Spinner className="h-4 w-4 text-fg-faint" />
            </div>
          ) : bases.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-fg-faint">{t('tables.sidebar.noBases')}</p>
          ) : (
            bases.map((base) => {
              const items = baseMenu(base);
              return (
                <a
                  key={base.id}
                  href={`#/tables/${base.id}`}
                  onContextMenu={(event) => openMenu(event, items)}
                  className={`group flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                    selectedBaseId === base.id
                      ? 'bg-primary-subtle font-medium text-primary-fg-strong'
                      : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
                  }`}
                >
                  <Table2 size={14} className="flex-shrink-0" />
                  <span className="min-w-0 flex-1 truncate" title={base.description || base.name}>
                    {base.name}
                  </span>
                  <span className="sidebar-secondary-meta text-[10px] uppercase text-fg-faint">
                    {t(`tables.home.role.${base.role}` as TranslationKey)}
                  </span>
                  {rowMenuButton(t('tables.sidebar.actionsFor', { name: base.name }), items)}
                </a>
              );
            })
          )}
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col pt-2">
        {!selectedBaseId ? (
          <p className="px-3 py-6 text-center text-xs leading-5 text-fg-faint">{t('tables.sidebar.selectBase')}</p>
        ) : loadingWorkspace && !workspace ? (
          <div className="flex justify-center py-6">
            <Spinner className="h-4 w-4 text-fg-faint" />
          </div>
        ) : workspace ? (
          <>
            <div className="flex-shrink-0 px-3 pb-2">
              <h2 className="truncate text-xs font-semibold text-fg" title={workspace.base.name}>
                {workspace.base.name}
              </h2>
              <p className="mt-0.5 text-[10px] text-fg-faint">
                {t(workspace.base.visibility === 'team' ? 'tables.home.teamVisible' : 'tables.home.private')} ·{' '}
                {t(`tables.home.role.${workspace.role}` as TranslationKey)}
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="flex items-center justify-between px-3 py-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
                  {t('tables.home.title')}
                </span>
                {canBuild && (
                  <IconButton
                    label={t('tables.home.createTable')}
                    tooltip="top"
                    tooltipMode="portal"
                    className="h-7 w-7 sm:h-7 sm:w-7"
                    onClick={() => setResourceDialog('table')}
                  >
                    <Plus size={13} />
                  </IconButton>
                )}
              </div>
              {workspace.tables.map((table) => {
                const items = resourceMenu({ kind: 'table', value: table });
                return (
                  <a
                    key={table.id}
                    href={`#/tables/${workspace.base.id}/table/${table.id}`}
                    onContextMenu={(event) => openMenu(event, items)}
                    className={`group flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                      selectedType === 'table' && selectedResourceId === table.id
                        ? 'bg-primary-subtle font-medium text-primary-fg-strong'
                        : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
                    }`}
                  >
                    <Table2 size={14} className="flex-shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={table.description || table.name}>
                      {table.name}
                    </span>
                    {rowMenuButton(t('tables.sidebar.actionsFor', { name: table.name }), items)}
                  </a>
                );
              })}
              <div className="mx-3 my-1 border-t border-edge" />
              <div className="flex items-center justify-between px-3 py-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
                  {t('tables.sidebar.dashboards')}
                </span>
                {canBuild && (
                  <IconButton
                    label={t('tables.home.createDashboard')}
                    tooltip="top"
                    tooltipMode="portal"
                    className="h-7 w-7 sm:h-7 sm:w-7"
                    onClick={() => setResourceDialog('dashboard')}
                  >
                    <Plus size={13} />
                  </IconButton>
                )}
              </div>
              {workspace.dashboards.map((dashboard) => {
                const items = resourceMenu({ kind: 'dashboard', value: dashboard });
                return (
                  <a
                    key={dashboard.id}
                    href={`#/tables/${workspace.base.id}/dashboard/${dashboard.id}`}
                    onContextMenu={(event) => openMenu(event, items)}
                    className={`group flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                      selectedType === 'dashboard' && selectedResourceId === dashboard.id
                        ? 'bg-primary-subtle font-medium text-primary-fg-strong'
                        : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
                    }`}
                  >
                    <LayoutDashboard size={14} className="flex-shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={dashboard.description || dashboard.name}>
                      {dashboard.name}
                    </span>
                    {rowMenuButton(t('tables.sidebar.actionsFor', { name: dashboard.name }), items)}
                  </a>
                );
              })}
            </div>
          </>
        ) : (
          <p className="px-3 py-4 text-center text-xs text-danger">{error || t('tables.home.baseNotFound')}</p>
        )}
      </section>

      {menu && <ContextMenu {...menu} onClose={closeMenu} />}

      <BaseDialog
        open={baseDialog}
        onClose={() => setBaseDialog(false)}
        onCreated={(baseId) => {
          setBaseDialog(false);
          void loadBases();
          window.location.hash = `#/tables/${baseId}`;
        }}
      />
      <BaseDialog
        open={editingBase !== null}
        base={editingBase}
        onClose={() => setEditingBase(null)}
        onSaved={() => {
          setEditingBase(null);
          void loadBases();
          void loadWorkspace();
        }}
      />
      {selectedBaseId && (
        <>
          <ResourceDialog
            baseId={selectedBaseId}
            type={resourceDialog}
            onClose={() => setResourceDialog(null)}
            onCreated={(type, resourceId) => {
              setResourceDialog(null);
              void loadWorkspace();
              window.location.hash = `#/tables/${selectedBaseId}/${type}/${resourceId}`;
            }}
          />
          <ResourceDialog
            baseId={selectedBaseId}
            type={null}
            resource={editingResource}
            onClose={() => setEditingResource(null)}
            onSaved={() => {
              setEditingResource(null);
              void loadWorkspace();
            }}
          />
        </>
      )}
      <DeleteDialog
        target={deleting}
        baseTableCount={
          deleting?.kind === 'base' && deleting.value.id === selectedBaseId ? (workspace?.tables.length ?? 0) : 0
        }
        onClose={() => setDeleting(null)}
        onDeleted={(target) => {
          setDeleting(null);
          void loadBases();
          // Navigate away from whatever just disappeared, or the pane 404s.
          if (target.kind === 'base') {
            if (target.value.id === selectedBaseId) window.location.hash = '#/tables';
          } else {
            void loadWorkspace();
            if (selectedType === target.kind && selectedResourceId === target.value.id) {
              window.location.hash = `#/tables/${selectedBaseId}`;
            }
          }
        }}
      />
    </div>
  );
}
