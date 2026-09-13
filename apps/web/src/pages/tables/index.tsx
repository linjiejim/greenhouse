import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { TableBaseRole, TableBaseVisibility } from '@greenhouse/types/tables';
import {
  getTableBase,
  listTableBases,
  listTableUsers,
  removeTableBaseMember,
  updateTableBase,
  upsertTableBaseMember,
  type TableBaseWithRole,
  type TableBaseWorkspace,
} from '../../lib/api/tables';
import { Button, Dialog, EmptyState, IconButton, SearchInput, Select, Spinner, Tag } from '../../components/ui';
import {
  ArrowLeft,
  BarChart3,
  History,
  Inbox,
  LayoutDashboard,
  Plus,
  Share2,
  Table2,
  Trash2,
  Zap,
} from '../../lib/icons';
import { formatDay } from '../../lib/utils';
import { useAgentContext } from '../../components/agent-context';
import { BaseDialog } from '../../components/tables/base-dialog';
import { ResourceDialog } from '../../components/tables/resource-dialog';
import { TablesGridView } from './grid-view';
import { TablesDashboardView } from './dashboard-view';
import { TablesAuditDialog } from './audit-dialog';
import { TablesAutomationDialog } from './automation-dialog';
import { TablesFormPage } from './form-page';
import { TablesNotificationsDialog } from './notifications-dialog';
import { useT, type TranslationKey } from '../../lib/i18n';
import { ModulePage } from '../../components/app/module-page';

interface TablesPageProps {
  subPath?: string;
}

type AssignableUser = { id: string; nickname: string; email: string; role: 'team' | 'super' };

const ROLE_RANK: Record<TableBaseRole, number> = { viewer: 0, editor: 1, builder: 2, owner: 3 };

/**
 * The roles a Base can be shared with, most to least capable. The identifiers
 * are the API contract; the labels say what each one actually gets, because
 * "Builder" on its own tells a sharer nothing about what they are handing over.
 * Owner is absent on purpose — it is the creator, and it is not assignable.
 */
const SHAREABLE_ROLES: Array<{
  value: Exclude<TableBaseRole, 'owner'>;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
}> = [
  {
    value: 'builder',
    labelKey: 'tables.home.roleBuilder',
    hintKey: 'tables.home.roleBuilderHint',
  },
  {
    value: 'editor',
    labelKey: 'tables.home.roleEditor',
    hintKey: 'tables.home.roleEditorHint',
  },
  { value: 'viewer', labelKey: 'tables.home.roleViewer', hintKey: 'tables.home.roleViewerHint' },
];

function TablesHome() {
  const t = useT();
  const [bases, setBases] = useState<TableBaseWithRole[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLoading(true);
      listTableBases(search)
        .then((next) => {
          setBases(next);
          setError('');
        })
        .catch((loadError) => setError(loadError instanceof Error ? loadError.message : t('tables.home.loadFailed')))
        .finally(() => setLoading(false));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [search, t]);

  return (
    <ModulePage
      moduleId="workspace.tables"
      layout="list"
      actions={
        <Button onClick={() => setDialog(true)} size="sm">
          <Plus size={14} className="mr-1.5" />
          {t('tables.base.create')}
        </Button>
      }
      notice={
        error ? (
          <div className="rounded-md border border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">{error}</div>
        ) : undefined
      }
      toolbar={
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t('tables.home.searchPlaceholder')}
          size="sm"
          className="w-full sm:max-w-sm"
        />
      }
    >
      {loading && bases.length === 0 ? (
        <div className="flex justify-center py-20">
          <Spinner className="h-6 w-6 text-fg-faint" />
        </div>
      ) : bases.length === 0 ? (
        <EmptyState
          icon={Table2}
          title={search ? t('tables.home.noMatchingBases') : t('tables.home.createFirstBase')}
          description={search ? t('tables.home.tryAnotherSearch') : t('tables.home.baseDescription')}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {bases.map((base) => (
            <a
              key={base.id}
              href={`#/tables/${base.id}`}
              className="group rounded-xl border border-edge bg-surface-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary-300 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="rounded-lg bg-primary-subtle p-2 text-primary-fg">
                  <Table2 size={18} />
                </div>
                <Tag tone="neutral">{t(`tables.home.role.${base.role}`)}</Tag>
              </div>
              <h2
                className="mt-4 truncate text-base font-semibold text-fg group-hover:text-primary-fg"
                title={base.name}
              >
                {base.name}
              </h2>
              <p className="mt-1 line-clamp-2 min-h-10 text-xs leading-5 text-fg-muted">
                {base.description || t('tables.home.noDescription')}
              </p>
              <div className="mt-4 flex items-center justify-between border-t border-edge pt-3 text-[11px] text-fg-faint">
                <span>{base.visibility === 'team' ? t('tables.home.teamVisible') : t('tables.home.private')}</span>
                <span>{t('tables.home.updatedAt', { date: formatDay(base.updated_at) })}</span>
              </div>
            </a>
          ))}
        </div>
      )}
      <BaseDialog
        open={dialog}
        onClose={() => setDialog(false)}
        onCreated={(baseId) => {
          setDialog(false);
          window.location.hash = `#/tables/${baseId}`;
        }}
      />
    </ModulePage>
  );
}

function ShareDialog({
  open,
  workspace,
  users,
  onClose,
  onChanged,
}: {
  open: boolean;
  workspace: TableBaseWorkspace;
  users: AssignableUser[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const [visibility, setVisibility] = useState<TableBaseVisibility>(workspace.base.visibility);
  const [selectedUser, setSelectedUser] = useState('');
  const [selectedRole, setSelectedRole] = useState<Exclude<TableBaseRole, 'owner'>>('editor');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const membersByUser = useMemo(
    () => new Map(workspace.members.map((member) => [member.user_id, member])),
    [workspace.members],
  );
  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const available = users.filter((user) => user.id !== workspace.base.owner_id && !membersByUser.has(user.id));

  useEffect(() => {
    if (open) setVisibility(workspace.base.visibility);
  }, [open, workspace.base.visibility]);

  const run = async (action: () => Promise<unknown>) => {
    setSaving(true);
    setError('');
    try {
      await action();
      await onChanged();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.home.updateSharingFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('tables.home.shareBase')} size="lg">
      <div className="space-y-5">
        <div>
          <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.home.visibility')}</label>
          <div className="flex gap-2">
            <Select value={visibility} onChange={(event) => setVisibility(event.target.value as TableBaseVisibility)}>
              <option value="private">{t('tables.home.privateMembersOnly')}</option>
              <option value="team">{t('tables.base.teamVisibility')}</option>
            </Select>
            <Button
              variant="outline"
              disabled={saving || visibility === workspace.base.visibility}
              onClick={() => void run(() => updateTableBase(workspace.base.id, { visibility }))}
            >
              {t('common.apply')}
            </Button>
          </div>
        </div>
        <div className="border-t border-edge pt-4">
          <label className="mb-2 block text-xs font-medium text-fg-muted">{t('tables.home.addMember')}</label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_130px_auto]">
            <Select value={selectedUser} onChange={(event) => setSelectedUser(event.target.value)}>
              <option value="">{t('tables.home.chooseTeammate')}</option>
              {available.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.nickname} · {user.email}
                </option>
              ))}
            </Select>
            <Select
              value={selectedRole}
              onChange={(event) => setSelectedRole(event.target.value as Exclude<TableBaseRole, 'owner'>)}
            >
              {SHAREABLE_ROLES.map((role) => (
                <option key={role.value} value={role.value}>
                  {t(role.labelKey)}
                </option>
              ))}
            </Select>
            <Button
              disabled={saving || !selectedUser}
              onClick={() =>
                void run(async () => {
                  await upsertTableBaseMember(workspace.base.id, selectedUser, selectedRole);
                  setSelectedUser('');
                })
              }
            >
              {t('common.add')}
            </Button>
          </div>
          <ul className="mt-2 space-y-0.5">
            {SHAREABLE_ROLES.map((role) => (
              <li key={role.value} className="text-[11px] text-fg-faint">
                <span className="font-medium text-fg-muted">{t(role.labelKey)}</span> — {t(role.hintKey)}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-fg-faint">{t('tables.home.ownerOnlyHint')}</p>
        </div>
        <div className="space-y-2 border-t border-edge pt-4">
          <div className="flex items-center justify-between rounded-lg bg-surface-sunken px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-fg">
                {usersById.get(workspace.base.owner_id)?.nickname ?? t('tables.home.baseOwner')}
              </p>
              <p className="truncate text-xs text-fg-faint">
                {usersById.get(workspace.base.owner_id)?.email ?? workspace.base.owner_id}
              </p>
            </div>
            <span className="text-xs font-medium text-fg-muted">{t('tables.home.owner')}</span>
          </div>
          {workspace.members
            .filter((member) => member.user_id !== workspace.base.owner_id)
            .map((member) => {
              const user = usersById.get(member.user_id);
              return (
                <div key={member.user_id} className="flex items-center gap-2 rounded-lg border border-edge px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{user?.nickname ?? member.user_id}</p>
                    <p className="truncate text-xs text-fg-faint">{user?.email ?? member.user_id}</p>
                  </div>
                  <Select
                    size="sm"
                    inline
                    value={member.role}
                    disabled={saving}
                    title={
                      SHAREABLE_ROLES.find((role) => role.value === member.role)
                        ? t(SHAREABLE_ROLES.find((role) => role.value === member.role)!.hintKey)
                        : undefined
                    }
                    onChange={(event) =>
                      void run(() =>
                        upsertTableBaseMember(
                          workspace.base.id,
                          member.user_id,
                          event.target.value as Exclude<TableBaseRole, 'owner'>,
                        ),
                      )
                    }
                  >
                    {SHAREABLE_ROLES.map((role) => (
                      <option key={role.value} value={role.value}>
                        {t(role.labelKey)}
                      </option>
                    ))}
                  </Select>
                  <button
                    type="button"
                    className="rounded p-2 text-fg-faint hover:bg-danger-subtle hover:text-danger"
                    aria-label={t('tables.home.removeMember', { name: user?.nickname ?? member.user_id })}
                    onClick={() => void run(() => removeTableBaseMember(workspace.base.id, member.user_id))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end border-t border-edge pt-4">
          <Button variant="ghost" onClick={onClose}>
            {t('common.done')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function BaseWorkspace({
  baseId,
  resourceType,
  resourceId,
}: {
  baseId: number;
  resourceType?: 'table' | 'dashboard';
  resourceId?: number;
}) {
  const t = useT();
  const { enrichPageContext } = useAgentContext();
  const [workspace, setWorkspace] = useState<TableBaseWorkspace | null>(null);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newResource, setNewResource] = useState<'table' | 'dashboard' | null>(null);
  const [share, setShare] = useState(false);
  const [audit, setAudit] = useState(false);
  const [automations, setAutomations] = useState(false);
  const [notifications, setNotifications] = useState(false);

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

  const canBuild = ROLE_RANK[workspace.role] >= ROLE_RANK.builder;

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
            {t(`tables.home.role.${workspace.role}`)}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setNotifications(true)}>
          <Inbox size={13} className="mr-1.5" />
          {t('tables.home.notifications')}
        </Button>
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
            <TablesGridView table={selectedTable} tables={workspace.tables} role={workspace.role} users={users} />
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
      <TablesNotificationsDialog open={notifications} onClose={() => setNotifications(false)} />
    </div>
  );
}

export function TablesPage({ subPath = '' }: TablesPageProps) {
  const t = useT();
  const segments = subPath.split('/').filter(Boolean);
  if (segments.length === 0) return <TablesHome />;
  if (segments[0] === 'form') {
    const formId = Number(segments[1]);
    return Number.isInteger(formId) && formId > 0 ? (
      <TablesFormPage formId={formId} />
    ) : (
      <div className="flex h-full items-center justify-center text-sm text-fg-faint">
        {t('tables.home.invalidFormRoute')}
      </div>
    );
  }
  const baseId = Number(segments[0]);
  const resourceType = segments[1] === 'table' || segments[1] === 'dashboard' ? segments[1] : undefined;
  const resourceId = segments[2] ? Number(segments[2]) : undefined;
  if (
    !Number.isInteger(baseId) ||
    baseId <= 0 ||
    (resourceId !== undefined && (!Number.isInteger(resourceId) || resourceId <= 0))
  ) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-faint">
        {t('tables.home.invalidRoute')}
      </div>
    );
  }
  return <BaseWorkspace baseId={baseId} resourceType={resourceType} resourceId={resourceId} />;
}
