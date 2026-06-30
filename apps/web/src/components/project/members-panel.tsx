/**
 * 项目成员管理面板 — Drawer 内展示/添加/移除成员。
 */

import React, { useState } from 'react';
import { Button, Select, Drawer, Avatar, ConfirmDialog, toast } from '../ui';
import { authFetch } from '../../lib/auth';
import { Users, Plus, X, Shield, User, Crown } from '../../lib/icons';
import type { ProjectMember } from './types';
import { useT } from '../../lib/i18n';

interface MembersPanelProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
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
        toast(t('projects.memberAdded'), 'success');
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
        toast(t('projects.memberRemoved'), 'success');
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
      toast(t('projects.roleUpdated'), 'success');
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
              {t('projects.members')} ({members.length})
            </h3>
          </div>

          {/* Add member */}
          {isOwner && availableUsers.length > 0 && (
            <div className="px-4 py-3 border-b border-edge">
              <div className="flex gap-2">
                <Select value={addUserId} onChange={(e) => setAddUserId(e.target.value)} size="sm" className="flex-1">
                  <option value="">{t('projects.selectMember')}</option>
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
                        <span className="text-[10px] text-fg-faint">({t('common.you')})</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-fg-faint">
                      <RoleIcon size={10} />
                      <span>{m.role === 'owner' ? t('projects.owner') : t('projects.member')}</span>
                    </div>
                  </div>
                  {isOwner && m.user_id !== currentUserId && (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 touch-visible transition-opacity">
                      <button
                        onClick={() => handleRoleChange(m.user_id, m.role === 'owner' ? 'member' : 'owner')}
                        className="p-1 text-fg-faint hover:text-primary-fg rounded hover:bg-surface-muted"
                        title={m.role === 'owner' ? t('projects.setMember') : t('projects.setOwner')}
                      >
                        <Shield size={12} />
                      </button>
                      <button
                        onClick={() => setRemoveTarget(m)}
                        className="p-1 text-fg-faint hover:text-danger rounded hover:bg-surface-muted"
                        title={t('projects.removeMember')}
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
        title={t('projects.removeMemberConfirm')}
        description={`${t('projects.removeMemberConfirmDesc')} ${removeTarget?.nickname}?`}
        confirmLabel={t('common.remove')}
        confirmVariant="destructive"
      />
    </>
  );
}
