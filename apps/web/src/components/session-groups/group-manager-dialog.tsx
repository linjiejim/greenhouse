/**
 * GroupManagerDialog — full CRUD for the user's session-group (folder) library.
 * Create, rename, recolor, delete, and reorder folders. The built-in Pinned
 * group is shown read-only (cannot be renamed or deleted).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Dialog, Button, Input, ConfirmDialog, toast } from '../ui';
import { Pencil, Trash2, GripVertical, Plus } from '../../lib/icons';
import { TAG_COLORS } from '../session-tags/colors';
import { useT } from '../../lib/i18n';
import type { SessionGroup } from '@greenhouse/types/api';
import * as api from '../../lib/api';

interface GroupManagerDialogProps {
  open: boolean;
  onClose: () => void;
  onGroupsChanged: () => void;
}

export function GroupManagerDialog({ open, onClose, onGroupsChanged }: GroupManagerDialogProps) {
  const t = useT();
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(TAG_COLORS[0].value);
  const [showCreate, setShowCreate] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SessionGroup | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  // Custom folders only — the Pinned system group is managed implicitly.
  const customGroups = groups.filter((g) => g.kind !== 'pinned');

  const loadGroups = useCallback(async () => {
    setLoading(true);
    try {
      setGroups(await api.listSessionGroups());
    } catch {
      toast(t('common.loadFailed') || 'Failed to load groups', 'error');
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    if (open) loadGroups();
  }, [open, loadGroups]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await api.createSessionGroup(newName.trim(), newColor);
      setNewName('');
      setNewColor(TAG_COLORS[0].value);
      setShowCreate(false);
      loadGroups();
      onGroupsChanged();
      toast(t('sessionGroups.created') || 'Group created', 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to create', 'error');
    }
  };

  const handleEdit = async () => {
    if (editingId == null || !editName.trim()) return;
    try {
      await api.updateSessionGroup(editingId, { name: editName.trim(), color: editColor });
      setEditingId(null);
      loadGroups();
      onGroupsChanged();
      toast(t('sessionGroups.updated') || 'Group updated', 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to update', 'error');
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.deleteSessionGroup(pendingDelete.id);
      setPendingDelete(null);
      loadGroups();
      onGroupsChanged();
      toast(t('sessionGroups.deleted') || 'Group deleted', 'success');
    } catch {
      toast(t('common.deleteFailed') || 'Failed to delete', 'error');
    }
  };

  const handleDragStart = (idx: number) => setDragIdx(idx);
  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx == null || dragIdx === idx) return;
    const next = [...customGroups];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(idx, 0, moved);
    // Re-stitch: pinned (if any) stays, custom order replaced.
    setGroups([...groups.filter((g) => g.kind === 'pinned'), ...next]);
    setDragIdx(idx);
  };
  const handleDragEnd = async () => {
    setDragIdx(null);
    const updates = customGroups.map((g, i) => ({ id: g.id, sort_order: i }));
    try {
      await api.reorderSessionGroups(updates);
      onGroupsChanged();
    } catch {
      toast(t('sessionGroups.reorderFailed') || 'Failed to reorder', 'error');
    }
  };

  if (!open) return null;

  return (
    <>
      <Dialog open={open} onClose={onClose} title={t('sessionGroups.manageGroups') || 'Manage groups'} size="sm">
        <div className="space-y-3">
          <div className="space-y-1 min-h-[60px]">
            {loading && groups.length === 0 && (
              <div className="text-xs text-fg-faint text-center py-4">{t('common.loading') || 'Loading...'}</div>
            )}
            {!loading && customGroups.length === 0 && (
              <div className="text-xs text-fg-faint text-center py-4">
                {t('sessionGroups.noGroups') || 'No groups yet. Create your first group below.'}
              </div>
            )}
            {customGroups.map((group, idx) => (
              <div
                key={group.id}
                draggable={editingId !== group.id}
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDragEnd={handleDragEnd}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md border border-transparent hover:border-edge hover:bg-surface-muted transition-colors group cursor-move ${
                  dragIdx === idx ? 'opacity-50' : ''
                }`}
              >
                <GripVertical size={12} className="text-fg-faint flex-shrink-0" />
                {editingId === group.id ? (
                  <div className="flex-1 flex items-center gap-2">
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleEdit();
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      size="xs"
                      className="flex-1"
                      autoFocus
                    />
                    <div className="flex gap-0.5">
                      {TAG_COLORS.map((c) => (
                        <button
                          key={c.value}
                          onClick={() => setEditColor(c.value)}
                          className={`w-4 h-4 rounded-full border-2 transition-transform hover:scale-110 ${
                            editColor === c.value ? 'border-fg scale-110' : 'border-transparent'
                          }`}
                          style={{ backgroundColor: c.value }}
                          title={c.label}
                        />
                      ))}
                    </div>
                    <Button size="sm" onClick={handleEdit}>
                      {t('common.save') || 'Save'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      {t('common.cancel') || 'Cancel'}
                    </Button>
                  </div>
                ) : (
                  <>
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: group.color }} />
                    <span className="flex-1 text-xs text-fg truncate">{group.name}</span>
                    {group.member_count != null && group.member_count > 0 && (
                      <span className="text-[10px] text-fg-faint tabular-nums">{group.member_count}</span>
                    )}
                    <button
                      onClick={() => {
                        setEditingId(group.id);
                        setEditName(group.name);
                        setEditColor(group.color);
                      }}
                      className="p-1 text-fg-faint hover:text-fg-secondary rounded transition-colors opacity-0 group-hover:opacity-100 touch-visible"
                      title={t('common.edit') || 'Edit'}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={() => setPendingDelete(group)}
                      className="p-1 text-fg-faint hover:text-danger rounded transition-colors opacity-0 group-hover:opacity-100 touch-visible"
                      title={t('common.delete') || 'Delete'}
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>

          {showCreate ? (
            <div className="border border-edge rounded-lg p-3 space-y-2 bg-surface-sunken">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('sessionGroups.groupName') || 'Group name'}
                size="sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') setShowCreate(false);
                }}
                autoFocus
              />
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-fg-faint mr-1">Color:</span>
                {TAG_COLORS.map((c) => (
                  <button
                    key={c.value}
                    onClick={() => setNewColor(c.value)}
                    className={`w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 ${
                      newColor === c.value ? 'border-fg scale-110' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: c.value }}
                    title={c.label}
                  />
                ))}
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>
                  {t('common.cancel') || 'Cancel'}
                </Button>
                <Button size="sm" onClick={handleCreate} disabled={!newName.trim()}>
                  {t('common.create') || 'Create'}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setShowCreate(true)}>
              <Plus size={14} className="mr-1" />
              {t('sessionGroups.newGroup') || 'New group'}
            </Button>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={handleDelete}
        title={t('sessionGroups.deleteTitle') || 'Delete group?'}
        description={
          t('sessionGroups.deleteDescription', { name: pendingDelete?.name || '' }) ||
          `Group "${pendingDelete?.name}" will be removed.`
        }
        confirmLabel={t('common.delete') || 'Delete'}
        confirmVariant="destructive"
      />
    </>
  );
}
