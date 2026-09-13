/**
 * GroupsPanel — manage groups ("小组") used as knowledge-sharing targets.
 *
 * Rebuilt on @greenhouse/crud: the list + delete-confirm come from one defineCrud
 * schema; the intro card + inline create row live in the toolbar slot and the
 * per-group member editor rides the rowExpand slot (the framework's block-level
 * escape hatches). Data source adapts the existing groups client — no server
 * change. “Member” means membership in a group, not an account role; account
 * roles remain team/super. Owner (creator) and super manage their groups.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { defineCrud, CrudPage, type CrudDataSource } from './crud';
import { Badge, Button, Input, Spinner, toast } from '../../components/ui';
import { Users, Plus, UserPlus, X } from '../../lib/icons';
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
import { ModulePage } from '../../components/app/module-page';

const dataSource: CrudDataSource<UserGroup> = {
  async list(params) {
    const groups = await listGroups();
    const skip = params.skip ?? 0;
    return { items: groups.slice(skip, skip + (params.limit ?? 50)), total: groups.length };
  },
  remove: (id) => deleteGroup(Number(id)),
};

export function GroupsPanel() {
  const t = useT();

  const schema = useMemo(
    () =>
      defineCrud<UserGroup>({
        name: t('groups.group'),
        icon: Users,
        dataSource,
        pageSize: 50,
        storageKey: 'settings-groups',
        columns: [
          {
            key: 'name',
            label: t('groups.group'),
            type: 'custom',
            render: (g) => (
              <span className="flex items-center gap-2 min-w-0">
                <Users size={15} className="text-fg-faint flex-shrink-0" />
                <span className="truncate text-sm font-medium text-fg" title={g.name}>
                  {g.name}
                </span>
                {g.member_count !== undefined && (
                  <Badge variant="secondary">
                    {g.member_count} {g.member_count === 1 ? t('groups.memberOne') : t('groups.memberOther')}
                  </Badge>
                )}
              </span>
            ),
          },
        ],
        access: { canDelete: true },
        deleteConfirm: (g) => ({
          title: t('groups.deleteGroupTitle'),
          description: t('groups.deleteGroupConfirm', { name: g.name }),
        }),
        slots: {
          toolbar: (ctx) => (
            <div className="space-y-4">
              <div className="flex items-center gap-3 bg-surface-card border border-edge rounded-xl p-4">
                <div className="p-2 rounded-lg bg-primary-500/10">
                  <Users className="w-5 h-5 text-primary-fg" />
                </div>
                <p className="flex-1 text-sm text-fg-muted">{t('groups.intro')}</p>
              </div>
              <CreateGroupRow onCreated={ctx.reload} />
            </div>
          ),
          empty: (
            <div className="text-center text-fg-muted py-12">
              <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>{t('groups.noGroups')}</p>
            </div>
          ),
          rowExpand: (g, ctx) => <GroupMembers groupId={g.id} onChanged={ctx.reload} />,
        },
      }),
    [t],
  );

  return (
    <ModulePage moduleId="settings.groups" layout="list">
      <CrudPage schema={schema} />
    </ModulePage>
  );
}

// ─── Inline create row (toolbar slot) ────────────────────

function CreateGroupRow({ onCreated }: { onCreated: () => void }) {
  const t = useT();
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await createGroup({ name: newName.trim() });
      toast(t('groups.created'), 'success');
      setNewName('');
      onCreated();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('groups.createFailed'), 'error');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        placeholder={t('groups.newGroupName')}
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
        size="sm"
        className="max-w-xs"
      />
      <Button size="sm" onClick={handleCreate} disabled={creating || !newName.trim()}>
        {creating ? <Spinner className="w-4 h-4 mr-1" /> : <Plus size={14} className="mr-1" />}
        {t('groups.createGroup')}
      </Button>
    </div>
  );
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
      {/* Current members */}
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

      {/* Add member */}
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
