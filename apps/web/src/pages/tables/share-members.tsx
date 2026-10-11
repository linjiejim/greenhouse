/**
 * The Members tab of the share dialog: add people and groups through the one
 * `PrincipalPicker`, and change or remove each grant. A grant is a built-in
 * role or one of the Base's custom roles; groups never get Admin (builder —
 * spec D12), and each group shows who manages its membership.
 */

import { useMemo, useState } from 'react';
import type { TableBaseRoleView, TableGroupMemberRole } from '@greenhouse/types/table-access';
import {
  removeTableBaseGroup,
  removeTableBaseMember,
  setTableBaseGroupRole,
  setTableBaseMemberRole,
  type TableAssignableRole,
  type TableBaseAccessList,
  type TableUser,
} from '../../lib/api/tables';
import { Button, IconButton, Select } from '../../components/ui';
import { PrincipalPicker, type PrincipalSelection } from '../../components/tables/principal-picker';
import { Crown, Trash2, Users } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';

/** A grant as one select value: a built-in role, or `custom:<roleId>`. */
type GrantValue = Exclude<TableAssignableRole, 'custom'> | `custom:${number}`;

const BUILT_IN: Array<{
  value: Exclude<TableAssignableRole, 'custom'>;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
}> = [
  { value: 'builder', labelKey: 'tables.home.roleBuilder', hintKey: 'tables.home.roleBuilderHint' },
  { value: 'editor', labelKey: 'tables.home.roleEditor', hintKey: 'tables.home.roleEditorHint' },
  { value: 'viewer', labelKey: 'tables.home.roleViewer', hintKey: 'tables.home.roleViewerHint' },
];

function grantValue(role: string, customRoleId: number | null): GrantValue | '' {
  if (role === 'custom') return customRoleId ? `custom:${customRoleId}` : '';
  return role === 'builder' || role === 'editor' || role === 'viewer' ? role : '';
}

function parseGrant(value: GrantValue): { role: TableAssignableRole; customRoleId: number | null } {
  return value.startsWith('custom:')
    ? { role: 'custom', customRoleId: Number(value.slice('custom:'.length)) }
    : { role: value as TableAssignableRole, customRoleId: null };
}

function GrantSelect({
  value,
  roles,
  allowBuilder,
  label,
  disabled,
  onChange,
}: {
  value: GrantValue | '';
  roles: readonly TableBaseRoleView[];
  allowBuilder: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: GrantValue) => void;
}) {
  const t = useT();
  return (
    <Select
      size="sm"
      inline
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as GrantValue)}
    >
      {value === '' && <option value="">{t('tables.access.chooseCustomRole')}</option>}
      {BUILT_IN.filter((role) => allowBuilder || role.value !== 'builder').map((role) => (
        <option key={role.value} value={role.value}>
          {t(role.labelKey)}
        </option>
      ))}
      {roles.map((role) => (
        <option key={role.id} value={`custom:${role.id}`}>
          {t('tables.access.customRole', { name: role.name })}
        </option>
      ))}
    </Select>
  );
}

export function ShareMembersTab({
  baseId,
  ownerId,
  users,
  access,
  roles,
  saving,
  run,
}: {
  baseId: number;
  ownerId: string;
  users: TableUser[];
  access: TableBaseAccessList;
  roles: readonly TableBaseRoleView[];
  saving: boolean;
  /** Runs a change, then reloads the dialog and the workspace; reports errors. */
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const t = useT();
  const [selection, setSelection] = useState<PrincipalSelection>({ userIds: [], groupIds: [] });
  const [grant, setGrant] = useState<GrantValue>('editor');
  const [hint, setHint] = useState('');
  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const people = access.members.filter((member) => member.user_id !== ownerId);
  const groupSelected = selection.groupIds.length > 0;

  const add = () => {
    if (selection.userIds.length === 0 && selection.groupIds.length === 0)
      return setHint(t('tables.access.chooseSomeone'));
    if (groupSelected && grant === 'builder') return setHint(t('tables.access.groupsCannotBuild'));
    setHint('');
    const { role, customRoleId } = parseGrant(grant);
    void run(async () => {
      for (const userId of selection.userIds) await setTableBaseMemberRole(baseId, userId, role, customRoleId);
      for (const groupId of selection.groupIds) {
        await setTableBaseGroupRole(baseId, groupId, role as TableGroupMemberRole, customRoleId);
      }
      setSelection({ userIds: [], groupIds: [] });
    });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-fg">{t('tables.access.addPeople')}</h4>
        <PrincipalPicker
          value={selection}
          onChange={setSelection}
          users={users}
          excludeUserIds={[ownerId, ...people.map((member) => member.user_id)]}
          excludeGroupIds={access.groups.map((group) => group.groupId)}
          disabled={saving}
        />
        <div className="flex flex-wrap items-center gap-2">
          <GrantSelect
            value={grant}
            roles={roles}
            allowBuilder={!groupSelected}
            label={t('tables.access.role')}
            disabled={saving}
            onChange={setGrant}
          />
          <Button size="sm" disabled={saving} onClick={add}>
            {t('common.add')}
          </Button>
        </div>
        {hint && <p className="text-xs text-warning">{hint}</p>}
        <ul className="space-y-0.5">
          {BUILT_IN.map((role) => (
            <li key={role.value} className="text-[11px] text-fg-faint">
              <span className="font-medium text-fg-muted">{t(role.labelKey)}</span> — {t(role.hintKey)}
            </li>
          ))}
          <li className="text-[11px] text-fg-faint">{t('tables.access.groupsCannotBuild')}</li>
        </ul>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between rounded-lg bg-surface-sunken px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">{usersById.get(ownerId)?.nickname ?? ownerId}</p>
            <p className="truncate text-xs text-fg-faint">{usersById.get(ownerId)?.email ?? ''}</p>
          </div>
          <span className="flex items-center gap-1 text-xs font-medium text-fg-muted">
            <Crown size={12} />
            {t('tables.home.owner')}
          </span>
        </div>
        {people.length === 0 && access.groups.length === 0 && (
          <p className="text-xs text-fg-faint">{t('tables.access.noGrants')}</p>
        )}
        {access.groups.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-fg-muted">{t('tables.access.groups')}</p>
            {access.groups.map((group) => (
              <div key={group.groupId} className="flex items-center gap-2 rounded-lg border border-edge px-3 py-2">
                <Users size={14} className="flex-shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">
                    {group.name}
                    <span className="ml-1.5 text-xs font-normal text-fg-faint">
                      {t('tables.access.memberCount', { count: group.memberCount })}
                    </span>
                  </p>
                  {group.managedBy && (
                    <p className="truncate text-xs text-fg-faint">
                      {t('tables.access.managedBy', { name: group.managedBy.name })}
                    </p>
                  )}
                </div>
                <GrantSelect
                  value={grantValue(group.role, group.customRoleId)}
                  roles={roles}
                  allowBuilder={false}
                  label={t('tables.access.roleOf', { name: group.name })}
                  disabled={saving}
                  onChange={(next) => {
                    const { role, customRoleId } = parseGrant(next);
                    void run(() =>
                      setTableBaseGroupRole(baseId, group.groupId, role as TableGroupMemberRole, customRoleId),
                    );
                  }}
                />
                <IconButton
                  label={t('tables.access.removeGroup', { name: group.name })}
                  variant="destructive"
                  disabled={saving}
                  onClick={() => void run(() => removeTableBaseGroup(baseId, group.groupId))}
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
        {people.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-fg-muted">{t('tables.access.people')}</p>
            {people.map((member) => {
              const user = usersById.get(member.user_id);
              const name = user?.nickname ?? member.name;
              return (
                <div key={member.user_id} className="flex items-center gap-2 rounded-lg border border-edge px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{name}</p>
                    <p className="truncate text-xs text-fg-faint">{user?.email ?? member.user_id}</p>
                  </div>
                  <GrantSelect
                    value={grantValue(member.role, member.custom_role_id)}
                    roles={roles}
                    allowBuilder
                    label={t('tables.access.roleOf', { name })}
                    disabled={saving}
                    onChange={(next) => {
                      const { role, customRoleId } = parseGrant(next);
                      void run(() => setTableBaseMemberRole(baseId, member.user_id, role, customRoleId));
                    }}
                  />
                  <IconButton
                    label={t('tables.access.removePerson', { name })}
                    variant="destructive"
                    disabled={saving}
                    onClick={() => void run(() => removeTableBaseMember(baseId, member.user_id))}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
