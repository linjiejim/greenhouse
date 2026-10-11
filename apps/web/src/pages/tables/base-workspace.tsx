/**
 * One Base: header (automations, activity, sharing), the mobile resource strip,
 * and the selected table (view container) or dashboard.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { tableRoleAtLeast } from '@greenhouse/types/table-access';
import { getTableBase, listTableUsers, type TableBaseWorkspace, type TableUser } from '../../lib/api/tables';
import { Button, EmptyState, IconButton, Spinner } from '../../components/ui';
import { ArrowLeft, BarChart3, History, LayoutDashboard, Share2, Table2, Zap } from '../../lib/icons';
import { useAgentContext } from '../../components/agent-context';
import { ResourceDialog } from '../../components/tables/resource-dialog';
import { useT } from '../../lib/i18n';
import { TablesViewContainer } from './view-container';
import { TablesDashboardView } from './dashboard-view';
import { TablesAuditDialog } from './audit-dialog';
import { TablesAutomationDialog } from './automation-dialog';
import { ShareDialog } from './share-dialog';
import { BaseAppsSection } from './base-apps-section';

export function BaseWorkspace({
  baseId,
  resourceType,
  resourceId,
  recordId,
}: {
  baseId: number;
  resourceType?: 'table' | 'dashboard';
  resourceId?: number;
  /** `?record=<id>`: open this record of the selected table. */
  recordId?: number;
}) {
  const t = useT();
  const { enrichPageContext } = useAgentContext();
  const [workspace, setWorkspace] = useState<TableBaseWorkspace | null>(null);
  const [users, setUsers] = useState<TableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newResource, setNewResource] = useState<'table' | 'dashboard' | null>(null);
  const [share, setShare] = useState(false);
  const [audit, setAudit] = useState(false);
  const [automations, setAutomations] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextWorkspace, nextUsers] = await Promise.all([getTableBase(baseId), listTableUsers()]);
      setWorkspace(nextWorkspace);
      setUsers(nextUsers);
      const selectedResourceExists =
        !resourceType ||
        !resourceId ||
        (resourceType === 'table'
          ? nextWorkspace.tables.some((table) => table.id === resourceId)
          : nextWorkspace.dashboards.some((dashboard) => dashboard.id === resourceId));
      setError(selectedResourceExists ? '' : t('tables.home.resourceNotFound'));
      if (!resourceType) {
        const firstTable = nextWorkspace.tables[0];
        const firstDashboard = nextWorkspace.dashboards[0];
        if (firstTable) window.location.hash = `#/tables/${baseId}/table/${firstTable.id}`;
        else if (firstDashboard) window.location.hash = `#/tables/${baseId}/dashboard/${firstDashboard.id}`;
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tables.home.loadBaseFailed'));
    } finally {
      setLoading(false);
    }
  }, [baseId, resourceId, resourceType, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedTable =
    resourceType === 'table' ? workspace?.tables.find((table) => table.id === resourceId) : undefined;
  const selectedDashboard =
    resourceType === 'dashboard' ? workspace?.dashboards.find((dashboard) => dashboard.id === resourceId) : undefined;

  useEffect(() => {
    if (!workspace) return;
    enrichPageContext({
      baseName: workspace.base.name,
      baseDescription: workspace.base.description ?? undefined,
      tableName: selectedTable?.name,
      tableDescription: selectedTable?.description ?? undefined,
      dashboardName: selectedDashboard?.name,
    });
    return () => enrichPageContext(null);
  }, [enrichPageContext, selectedDashboard?.name, selectedTable?.description, selectedTable?.name, workspace]);

  if (loading && !workspace)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-fg-faint" />
      </div>
    );
  if (!workspace)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-fg-muted">
        <p>{error || t('tables.home.baseNotFound')}</p>
        <a href="#/tables" className="text-primary-fg hover:underline">
          {t('tables.home.backToTables')}
        </a>
      </div>
    );

  const canBuild = tableRoleAtLeast(workspace.role, 'builder');

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-canvas">
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-edge bg-surface-raised px-3 py-2">
        <a
          href="#/tables"
          className="rounded-md p-2 text-fg-muted hover:bg-surface-muted hover:text-fg"
          aria-label={t('tables.home.backToTables')}
        >
          <ArrowLeft size={16} />
        </a>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-fg">{workspace.base.name}</h1>
          <p className="truncate text-[11px] text-fg-faint">
            {workspace.base.visibility === 'team' ? t('tables.home.teamVisible') : t('tables.home.private')} ·{' '}
            {workspace.access.customRole?.name ?? t(`tables.home.role.${workspace.role}`)}
          </p>
        </div>
        <BaseAppsSection baseId={baseId} baseName={workspace.base.name} canBuild={canBuild} />
        {canBuild && (
          <Button variant="outline" size="sm" onClick={() => setAutomations(true)}>
            <Zap size={13} className="mr-1.5" />
            {t('tables.automations.title')}
          </Button>
        )}
        {workspace.role === 'owner' && (
          <>
            <Button variant="outline" size="sm" onClick={() => setAudit(true)}>
              <History size={13} className="mr-1.5" />
              {t('tables.home.activity')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShare(true)}>
              <Share2 size={13} className="mr-1.5" />
              {t('tables.home.share')}
            </Button>
          </>
        )}
      </header>
      {error && (
        <div className="flex-shrink-0 border-b border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">
          {error}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <nav className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-edge bg-surface-raised p-2 md:hidden">
          {workspace.tables.map((table) => (
            <a
              key={table.id}
              href={`#/tables/${baseId}/table/${table.id}`}
              className={`flex min-w-max items-center gap-2 rounded-md px-2.5 py-2 text-xs transition-colors ${selectedTable?.id === table.id ? 'bg-primary-subtle font-medium text-primary-fg-strong' : 'text-fg-muted hover:bg-surface-muted hover:text-fg'}`}
            >
              <Table2 size={14} />
              {table.name}
            </a>
          ))}
          {workspace.dashboards.map((dashboard) => (
            <a
              key={dashboard.id}
              href={`#/tables/${baseId}/dashboard/${dashboard.id}`}
              className={`flex min-w-max items-center gap-2 rounded-md px-2.5 py-2 text-xs transition-colors ${selectedDashboard?.id === dashboard.id ? 'bg-primary-subtle font-medium text-primary-fg-strong' : 'text-fg-muted hover:bg-surface-muted hover:text-fg'}`}
            >
              <LayoutDashboard size={14} />
              {dashboard.name}
            </a>
          ))}
          {canBuild && (
            <div className="ml-auto flex gap-1">
              <IconButton
                label={t('tables.home.createTable')}
                tooltip="top"
                tooltipMode="portal"
                className="h-9 w-9 border border-edge sm:h-9 sm:w-9"
                onClick={() => setNewResource('table')}
              >
                <Table2 size={14} />
              </IconButton>
              <IconButton
                label={t('tables.home.createDashboard')}
                tooltip="top"
                tooltipMode="portal"
                className="h-9 w-9 border border-edge sm:h-9 sm:w-9"
                onClick={() => setNewResource('dashboard')}
              >
                <BarChart3 size={14} />
              </IconButton>
            </div>
          )}
        </nav>
        <main className="min-h-0 min-w-0 flex-1">
          {selectedTable ? (
            <TablesViewContainer
              // A different table is a fresh view: its own query, view and dialogs.
              key={selectedTable.id}
              table={selectedTable}
              tables={workspace.tables}
              role={workspace.role}
              access={workspace.access}
              users={users}
              focusRecordId={recordId}
            />
          ) : selectedDashboard ? (
            <TablesDashboardView dashboardId={selectedDashboard.id} tables={workspace.tables} role={workspace.role} />
          ) : (
            <EmptyState
              icon={workspace.tables.length === 0 ? Table2 : LayoutDashboard}
              title={t('tables.home.chooseResource')}
              description={canBuild && workspace.tables.length === 0 ? t('tables.home.createTableHint') : undefined}
            />
          )}
        </main>
      </div>

      <ResourceDialog
        baseId={baseId}
        type={newResource}
        onClose={() => setNewResource(null)}
        onCreated={(type, createdResourceId) => {
          setNewResource(null);
          window.location.hash = `#/tables/${baseId}/${type}/${createdResourceId}`;
        }}
      />
      <ShareDialog open={share} workspace={workspace} users={users} onClose={() => setShare(false)} onChanged={load} />
      <TablesAuditDialog open={audit} baseId={baseId} users={users} onClose={() => setAudit(false)} />
      <TablesAutomationDialog
        open={automations}
        baseId={baseId}
        tables={workspace.tables}
        users={users}
        onClose={() => setAutomations(false)}
      />
    </div>
  );
}
