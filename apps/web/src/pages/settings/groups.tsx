/**
 * GroupsPanel — manage groups ("小组") used as knowledge-sharing targets.
 *
 * Create a group, add/remove members. A group can then be picked in the
 * knowledge doc share dialog to grant a whole group at once. Owner (creator)
 * and super manage their groups.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Button,
  Input,
  Spinner,
  Badge,
  toast,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ListToolbar,
} from '../../components/ui';
import { Users, Plus, Trash2, UserPlus, X } from '../../lib/icons';
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

export function GroupsPanel() {
  const t = useT();
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserGroup | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    listGroups()
      .then(setGroups)
      .catch(() => toast(t('groups.loadFailed'), 'error'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const g = await createGroup({ name: newName.trim() });
      toast(t('groups.created'), 'success');
      setNewName('');
      setCreateOpen(false);
      setGroups((prev) => [g, ...prev]);
      setSelectedId(g.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : t('groups.createFailed'), 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (g: UserGroup) => {
    try {
      await deleteGroup(g.id);
      toast(t('groups.deleted'), 'success');
      setDeleteTarget(null);
      if (selectedId === g.id) setSelectedId(null);
      setGroups((prev) => prev.filter((x) => x.id !== g.id));
    } catch (err) {
      toast(err instanceof Error ? err.message : t('groups.deleteFailed'), 'error');
    }
  };

  const createButton = (
    <Button
      size="sm"
      onClick={() => {
        setNewName('');
        setCreateOpen(true);
      }}
    >
      <Plus size={14} className="mr-1" />
      {t('groups.createGroup')}
    </Button>
  );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <ListToolbar hint={<span className="block max-w-2xl">{t('groups.intro')}</span>} actions={createButton} />

      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : groups.length === 0 ? (
        <EmptyState icon={Users} title={t('groups.noGroups')} action={createButton} />
      ) : (
        <div className="space-y-2">
          {groups.map((g) => (
            <div key={g.id} className="bg-surface-raised border border-edge rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5">
                <button
                  className="flex items-center gap-2 flex-1 min-w-0 text-left"
                  onClick={() => setSelectedId(selectedId === g.id ? null : g.id)}
                >
                  <Users size={15} className="text-fg-faint flex-shrink-0" />
                  <span className="text-sm font-medium text-fg-default truncate">{g.name}</span>
                  {g.member_count !== undefined && (
                    <Badge variant="secondary">
                      {g.member_count} {g.member_count === 1 ? t('groups.memberOne') : t('groups.memberOther')}
                    </Badge>
                  )}
                </button>
                <button
                  onClick={() => setDeleteTarget(g)}
                  className="p-1 text-fg-faint hover:text-danger rounded transition-colors"
                  title={t('groups.deleteGroup')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              {selectedId === g.id && <GroupMembers groupId={g.id} onChanged={load} />}
            </div>
          ))}
        </div>
      )}

      {/* Create group dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title={t('groups.createGroup')} size="sm">
        <div className="space-y-4">
          <Input
            placeholder={t('groups.newGroupName')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={creating || !newName.trim()}>
              {creating ? <Spinner className="w-4 h-4 mr-1" /> : <Plus size={14} className="mr-1" />}
              {t('groups.createGroup')}
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && handleDelete(deleteTarget)}
        title={t('groups.deleteGroupTitle')}
        description={deleteTarget ? t('groups.deleteGroupConfirm', { name: deleteTarget.name }) : undefined}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </div>
  );
}

// ─── Group members editor ────────────────────────────────

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
      <div className="flex justify-center py-4 border-t border-edge">
        <Spinner className="h-4 w-4" />
      </div>
    );
  }

  return (
    <div className="border-t border-edge p-3 space-y-3 bg-surface-sunken">
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
