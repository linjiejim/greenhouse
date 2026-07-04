/**
 * GroupsPanel — manage groups ("小组") used as knowledge-sharing targets.
 *
 * Rebuilt on @greenhouse/crud: the list + create dialog + delete come from one
 * defineCrud schema; the per-group member editor rides the rowExpand slot (the
 * framework's block-level escape hatch). Data source adapts the existing groups
 * client — no server change.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { defineCrud, CrudPage, type CrudDataSource } from '@greenhouse/crud';
import { Input, Spinner, toast } from '../../components/ui';
import { Users, UserPlus, X } from '../../lib/icons';
import { fetchShareableUsers } from '../../lib/api';
import {
  listGroups,
  getGroup,
  createGroup,
  deleteGroup,
  addGroupMembers,
  removeGroupMember,
} from '../../lib/api/groups';
import { useT } from '../../lib/i18n';
import type { ShareableUser, UserGroup, GroupMember } from '@greenhouse/types/api';

const dataSource: CrudDataSource<UserGroup> = {
  async list(params) {
    let groups = await listGroups();
    const nameF = params.filter?.find((f) => f.key === 'name');
    if (nameF) {
      const q = String(nameF.value[0]).toLowerCase();
      groups = groups.filter((g) => g.name.toLowerCase().includes(q));
    }
    const total = groups.length;
    const skip = params.skip ?? 0;
    return { items: groups.slice(skip, skip + (params.limit ?? 50)), total };
  },
  async get(id) {
    const { group } = await getGroup(Number(id));
    return group;
  },
  create: (data) => createGroup(data as { name: string; description?: string }),
  remove: (id) => deleteGroup(Number(id)),
};

export function GroupsPanel() {
  const t = useT();

  const schema = useMemo(
    () =>
      defineCrud<UserGroup>({
        name: t('groups.createGroup'),
        icon: Users,
        dataSource,
        pageSize: 50,
        emptyMessage: t('groups.noGroups'),
        defaultSort: { key: 'updated_at', order: 'desc' },
        columns: [
          {
            key: 'name',
            label: 'Group',
            type: 'custom',
            render: (g) => (
              <span className="inline-flex items-center gap-2">
                <Users size={15} className="text-fg-faint" />
                <span className="font-medium text-fg">{g.name}</span>
              </span>
            ),
          },
          {
            key: 'member_count',
            label: 'Members',
            type: 'custom',
            width: '8rem',
            render: (g) =>
              g.member_count !== undefined ? (
                <span className="text-xs text-fg-muted">
                  {g.member_count} {g.member_count === 1 ? t('groups.memberOne') : t('groups.memberOther')}
                </span>
              ) : (
                <span className="text-fg-faint">—</span>
              ),
          },
        ],
        filters: [{ key: 'name', label: 'Search groups', kind: 'text' }],
        formFields: [{ key: 'name', label: t('groups.newGroupName'), type: 'text', required: true }],
        formTitle: () => t('groups.createGroup'),
        access: { canAdd: true, canDelete: true },
        slots: {
          rowExpand: (g, ctx) => <GroupMembers groupId={g.id} onChanged={ctx.reload} />,
        },
      }),
    [t],
  );

  return <CrudPage schema={schema} />;
}

// ─── Group members editor (rowExpand slot) ───────────────

function GroupMembers({ groupId, onChanged }: { groupId: number; onChanged: () => void }) {
  const t = useT();
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [users, setUsers] = useState<ShareableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    Promise.all([getGroup(groupId), fetchShareableUsers()])
      .then(([g, u]) => {
        setMembers(g.members);
        setUsers(u);
      })
      .catch(() => toast(t('groups.loadMembersFailed'), 'error'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const memberIds = new Set(members.map((m) => m.user_id));

  const handleAdd = async (userId: string) => {
    setAdding(true);
    try {
      await addGroupMembers(groupId, [userId]);
      await reload();
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('groups.addFailed'), 'error');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (userId: string) => {
    try {
      await removeGroupMember(groupId, userId);
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('groups.removeFailed'), 'error');
    }
  };

  const candidates = users.filter(
    (u) =>
      !memberIds.has(u.id) &&
      (!search ||
        u.nickname.toLowerCase().includes(search.toLowerCase()) ||
        u.email.toLowerCase().includes(search.toLowerCase())),
  );

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner className="h-4 w-4" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {members.length === 0 && <span className="text-xs text-fg-faint">{t('groups.noMembers')}</span>}
        {members.map((m) => (
          <span
            key={m.user_id}
            className="inline-flex items-center gap-1 text-xs bg-surface-raised border border-edge rounded-full px-2 py-0.5"
          >
            {m.nickname}
            <button
              onClick={() => handleRemove(m.user_id)}
              className="text-fg-faint hover:text-danger"
              title={t('groups.remove')}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>

      <Input
        placeholder={t('groups.searchToAdd')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        size="sm"
      />
      {search && (
        <div className="max-h-40 overflow-y-auto border border-edge rounded-lg divide-y divide-edge bg-surface-raised">
          {candidates.length === 0 ? (
            <div className="px-3 py-2 text-xs text-fg-muted text-center">{t('groups.noMatchingMembers')}</div>
          ) : (
            candidates.slice(0, 20).map((u) => (
              <button
                key={u.id}
                disabled={adding}
                onClick={() => handleAdd(u.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-muted transition-colors"
              >
                <UserPlus size={13} className="text-fg-faint" />
                <span className="flex-1 min-w-0 truncate">{u.nickname}</span>
                <span className="text-[11px] text-fg-muted truncate">{u.email}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
