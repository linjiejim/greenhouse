/**
 * Base sharing: visibility and per-person roles. Slice A rebuilds this into the
 * access dialog (groups, custom roles, team role, owner transfer).
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { TableBaseRole, TableBaseVisibility } from '@greenhouse/types/tables';
import {
  removeTableBaseMember,
  updateTableBase,
  upsertTableBaseMember,
  type TableBaseWorkspace,
  type TableUser,
} from '../../lib/api/tables';
import { Button, Dialog, Select } from '../../components/ui';
import { Trash2 } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';

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
