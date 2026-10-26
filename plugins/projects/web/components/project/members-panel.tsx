/**
 * 项目成员管理面板 — Drawer 内展示/添加/移除成员。
 */

import React, { useState } from 'react';
import { Button, Select, Drawer, Avatar, ConfirmDialog, toast } from '@greenhouse/web/extension-kit';
import { authFetch } from '@greenhouse/web/extension-kit';
import { Users, Plus, X, Shield, User, Crown } from '@greenhouse/web/extension-kit';
import type { ProjectMember } from './types.js';
import { useT } from '@greenhouse/web/extension-kit';

interface MembersPanelProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  members: ProjectMember[];
  users: Array<{ id: string; nickname: string }>;
  onUpdate: () => void;
  currentUserId: string;
  isOwner: boolean;
}

export function MembersPanel({
  open,
  onClose,
  projectId,
  members,
  users,
  onUpdate,
  currentUserId,
  isOwner,
}: MembersPanelProps) {
  const t = useT();
  const [addUserId, setAddUserId] = useState('');
  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ProjectMember | null>(null);

  const memberIds = new Set(members.map((m) => m.user_id));
  const availableUsers = users.filter((u) => !memberIds.has(u.id));

  const handleAdd = async () => {
    if (!addUserId) return;
    setAdding(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: addUserId }),
      });
      if (res.ok) {
        setAddUserId('');
        toast(t('ext.projects.projects.memberAdded'), 'success');
        onUpdate();
      }
    } catch (_err) {
      /* ignore */
    }
    setAdding(false);
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    try {
      const res = await authFetch(`/api/projects/${projectId}/members/${removeTarget.user_id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast(t('ext.projects.projects.memberRemoved'), 'success');
        onUpdate();
      }
    } catch (_err) {
      /* ignore */
    }
    setRemoveTarget(null);
  };

  const handleRoleChange = async (userId: string, role: 'owner' | 'member') => {
    try {
      await authFetch(`/api/projects/${projectId}/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      toast(t('ext.projects.projects.roleUpdated'), 'success');
      onUpdate();
    } catch (_err) {
      /* ignore */
    }
  };

  const roleIcon = (role: string) => (role === 'owner' ? Crown : User);

  return (
    <>
      <Drawer open={open} onClose={onClose} side="right" width={360}>
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="px-4 py-3 border-b border-edge">
            <h3 className="text-sm font-semibold text-fg flex items-center gap-2">
              <Users size={14} className="text-primary-fg" />
              {t('ext.projects.projects.members')} ({members.length})
            </h3>
          </div>

          {/* Add member */}
          {isOwner && availableUsers.length > 0 && (
            <div className="px-4 py-3 border-b border-edge">
              <div className="flex gap-2">
                <Select value={addUserId} onChange={(e) => setAddUserId(e.target.value)} size="sm" className="flex-1">
                  <option value="">{t('ext.projects.projects.selectMember')}</option>
                  {availableUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.nickname}
                    </option>
                  ))}
                </Select>
                <Button size="sm" onClick={handleAdd} disabled={!addUserId || adding}>
                  <Plus size={14} />
                </Button>
              </div>
            </div>
          )}

          {/* Member list */}
          <div className="flex-1 overflow-y-auto">
            {members.map((m) => {
              const RoleIcon = roleIcon(m.role);
              return (
                <div
                  key={m.id}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-muted transition-colors group"
                >
                  <Avatar name={m.nickname} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-fg truncate" title={m.nickname}>
                        {m.nickname}
                      </span>
                      {m.user_id === currentUserId && (
                        <span className="text-caption text-fg-faint">({t('common.you')})</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-caption text-fg-faint">
                      <RoleIcon size={10} />
                      <span>
                        {m.role === 'owner' ? t('ext.projects.projects.owner') : t('ext.projects.projects.member')}
                      </span>
                    </div>
                  </div>
                  {isOwner && m.user_id !== currentUserId && (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 touch-visible transition-opacity">
                      <button
                        onClick={() => handleRoleChange(m.user_id, m.role === 'owner' ? 'member' : 'owner')}
                        className="p-1 text-fg-faint hover:text-primary-fg rounded hover:bg-surface-muted"
                        title={
                          m.role === 'owner'
                            ? t('ext.projects.projects.setMember')
                            : t('ext.projects.projects.setOwner')
                        }
                      >
                        <Shield size={12} />
                      </button>
                      <button
                        onClick={() => setRemoveTarget(m)}
                        className="p-1 text-fg-faint hover:text-danger rounded hover:bg-surface-muted"
                        title={t('ext.projects.projects.removeMember')}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Drawer>

      <ConfirmDialog
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={handleRemove}
        title={t('ext.projects.projects.removeMemberConfirm')}
        description={`${t('ext.projects.projects.removeMemberConfirmDesc')} ${removeTarget?.nickname}?`}
        confirmLabel={t('common.remove')}
        confirmVariant="destructive"
      />
    </>
  );
}
