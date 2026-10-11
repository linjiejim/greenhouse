/**
 * Base sharing — the owner's (or a super's) access dialog:
 * - Members: people and groups (the one `PrincipalPicker`), each with a
 *   built-in role or a custom role (`./share-members.tsx`);
 * - Roles: custom roles and their row / field rules (`./roles-panel.tsx`);
 * - Team: who can open the Base and what everyone in the team gets;
 * - Owner: transfer ownership, choosing what the previous owner keeps.
 * Every change goes to the server, which enforces the same rules; this dialog
 * only reloads what it shows afterwards.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TableTeamRole } from '@greenhouse/types/table-access';
import type { TableBaseVisibility } from '@greenhouse/types/tables';
import {
  getTableSchema,
  listTableBaseAccess,
  listTableBaseRoles,
  setTableBaseTeamRole,
  transferTableBaseOwner,
  updateTableBase,
  type TableBaseAccessList,
  type TableBaseRoleList,
  type TableBaseWorkspace,
  type TableField,
  type TablePreviousOwnerRole,
  type TableUser,
} from '../../lib/api/tables';
import { Button, ConfirmDialog, Dialog, Select, Spinner, Tabs } from '../../components/ui';
import { FormField } from '../../components/form';
import { useT } from '../../lib/i18n';
import { ShareMembersTab } from './share-members';
import { RolesPanel } from './roles-panel';

type ShareTab = 'members' | 'roles' | 'team' | 'transfer';
const PREVIOUS_OWNER_ROLES: TablePreviousOwnerRole[] = ['builder', 'editor', 'viewer', 'remove'];

/** `custom:<id>` or a built-in team role, as one select value. */
function teamValue(role: TableTeamRole, customRoleId: number | null): string {
  return role === 'custom' ? `custom:${customRoleId ?? ''}` : role;
}

export function ShareDialog({
  open,
  workspace,
  users,
  onClose,
  onChanged,
}: {
  open: boolean;
  workspace: TableBaseWorkspace;
  users: TableUser[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const base = workspace.base;
  const [tab, setTab] = useState<ShareTab>('members');
  const [access, setAccess] = useState<TableBaseAccessList | null>(null);
  const [roles, setRoles] = useState<TableBaseRoleList | null>(null);
  const [fieldsByTable, setFieldsByTable] = useState<ReadonlyMap<number, TableField[]>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [visibility, setVisibility] = useState<TableBaseVisibility>(base.visibility);
  const [team, setTeam] = useState(teamValue(base.team_role, base.team_custom_role_id));
  const [newOwner, setNewOwner] = useState('');
  const [previousRole, setPreviousRole] = useState<TablePreviousOwnerRole>('builder');
  const [confirmTransfer, setConfirmTransfer] = useState(false);

  const reload = useCallback(async () => {
    const [nextAccess, nextRoles] = await Promise.all([listTableBaseAccess(base.id), listTableBaseRoles(base.id)]);
    setAccess(nextAccess);
    setRoles(nextRoles);
    // The rule editor's condition builder needs full field rows (options, configs).
    const schemas = await Promise.all(nextRoles.facts.tables.map((table) => getTableSchema(table.id)));
    setFieldsByTable(new Map(schemas.map((schema) => [schema.table.id, schema.fields])));
  }, [base.id]);

  useEffect(() => {
    if (!open) return;
    setError('');
    setVisibility(base.visibility);
    setTeam(teamValue(base.team_role, base.team_custom_role_id));
    reload().catch((loadError: unknown) =>
      setError(loadError instanceof Error ? loadError.message : t('tables.access.loadFailed')),
    );
  }, [base.team_custom_role_id, base.team_role, base.visibility, open, reload, t]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setSaving(true);
      setError('');
      try {
        await action();
        await Promise.all([reload(), onChanged()]);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : t('tables.access.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [onChanged, reload, t],
  );

  const roleViews = roles?.roles ?? [];
  const candidates = useMemo(() => users.filter((user) => user.id !== base.owner_id), [base.owner_id, users]);
  const owner = users.find((user) => user.id === base.owner_id);
  const teamChanged = team !== teamValue(base.team_role, base.team_custom_role_id) || visibility !== base.visibility;

  const applyTeam = () =>
    void run(async () => {
      if (visibility !== base.visibility) await updateTableBase(base.id, { visibility });
      const [role, id] = team.startsWith('custom:')
        ? ['custom' as const, Number(team.slice(7))]
        : [team as TableTeamRole];
      if (team !== teamValue(base.team_role, base.team_custom_role_id)) await setTableBaseTeamRole(base.id, role, id);
    });

  /** Not through `run`: after the transfer this dialog's data is no longer ours to reload. */
  const transfer = async () => {
    setConfirmTransfer(false);
    setSaving(true);
    setError('');
    try {
      await transferTableBaseOwner(base.id, newOwner, previousRole);
      onClose();
      await onChanged();
    } catch (transferError) {
      setError(transferError instanceof Error ? transferError.message : t('tables.access.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const tabs = (
    <Tabs
      ariaLabel={t('tables.home.shareBase')}
      active={tab}
      onChange={(key) => setTab(key as ShareTab)}
      tabs={[
        { key: 'members', label: t('tables.access.tabs.members'), testId: 'share-tab-members' },
        { key: 'roles', label: t('tables.access.tabs.roles'), count: roles?.roles.length, testId: 'share-tab-roles' },
        { key: 'team', label: t('tables.access.tabs.team'), testId: 'share-tab-team' },
        { key: 'transfer', label: t('tables.access.tabs.transfer'), testId: 'share-tab-transfer' },
      ]}
    />
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('tables.access.title', { name: base.name })}
      size="workspace"
      tabs={tabs}
    >
      {error && (
        <p className="mb-3 rounded-md border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>
      )}
      {!access || !roles ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : tab === 'members' ? (
        <ShareMembersTab
          baseId={base.id}
          ownerId={base.owner_id}
          users={users}
          access={access}
          roles={roleViews}
          saving={saving}
          run={run}
        />
      ) : tab === 'roles' ? (
        <RolesPanel
          baseId={base.id}
          list={roles}
          fieldsByTable={fieldsByTable}
          users={users}
          saving={saving}
          run={run}
        />
      ) : tab === 'team' ? (
        <div className="max-w-xl space-y-4">
          <FormField label={t('tables.access.visibility')}>
            <Select value={visibility} onChange={(event) => setVisibility(event.target.value as TableBaseVisibility)}>
              <option value="private">{t('tables.access.visibilityPrivate')}</option>
              <option value="team">{t('tables.access.visibilityTeam')}</option>
            </Select>
          </FormField>
          <FormField label={t('tables.access.teamRole')} help={t('tables.access.teamRoleHint')}>
            <Select value={team} disabled={visibility !== 'team'} onChange={(event) => setTeam(event.target.value)}>
              <option value="viewer">{t('tables.home.roleViewer')}</option>
              <option value="editor">{t('tables.home.roleEditor')}</option>
              {roleViews.map((role) => (
                <option key={role.id} value={`custom:${role.id}`}>
                  {t('tables.access.customRole', { name: role.name })}
                </option>
              ))}
            </Select>
          </FormField>
          <Button disabled={saving || !teamChanged} onClick={applyTeam}>
            {t('common.apply')}
          </Button>
        </div>
      ) : (
        <div className="max-w-xl space-y-4">
          <p className="text-sm text-fg-muted">{t('tables.access.transferHint')}</p>
          <div>
            <p className="mb-1.5 text-xs font-medium text-fg-secondary">{t('tables.access.ownerNow')}</p>
            <p className="text-sm text-fg">{owner ? `${owner.nickname} · ${owner.email}` : base.owner_id}</p>
          </div>
          <FormField label={t('tables.access.newOwner')}>
            <Select value={newOwner} onChange={(event) => setNewOwner(event.target.value)}>
              <option value="">{t('tables.access.chooseOwner')}</option>
              {candidates.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.nickname} · {user.email}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label={t('tables.access.previousOwnerRole')}>
            <Select
              value={previousRole}
              onChange={(event) => setPreviousRole(event.target.value as TablePreviousOwnerRole)}
            >
              {PREVIOUS_OWNER_ROLES.map((role) => (
                <option key={role} value={role}>
                  {t(`tables.access.previousRole.${role}`)}
                </option>
              ))}
            </Select>
          </FormField>
          <Button variant="destructive" disabled={saving || !newOwner} onClick={() => setConfirmTransfer(true)}>
            {t('tables.access.transfer')}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmTransfer}
        onClose={() => setConfirmTransfer(false)}
        onConfirm={() => void transfer()}
        title={t('tables.access.transferConfirmTitle', {
          name: candidates.find((user) => user.id === newOwner)?.nickname ?? '',
        })}
        description={t('tables.access.transferConfirmDescription')}
        confirmLabel={t('tables.access.transfer')}
        confirmVariant="destructive"
      />
    </Dialog>
  );
}
