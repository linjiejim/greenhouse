/**
 * TagManagerDialog — full CRUD for managing user's tag library.
 * Create, rename, recolor, delete, and reorder tags.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Dialog, Button, Input, ConfirmDialog, toast } from '../ui';
import { Pencil, Trash2, GripVertical, Plus } from '../../lib/icons';
import { TagBadge } from './tag-badge';
import { TAG_COLORS } from './colors';
import type { SessionTag } from '@greenhouse/types/api';
import * as api from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useListReorder } from '../../hooks/use-list-reorder';

interface TagManagerDialogProps {
  open: boolean;
  onClose: () => void;
  onTagsChanged: () => void;
}

export function TagManagerDialog({ open, onClose, onTagsChanged }: TagManagerDialogProps) {
  const t = useT();
  const [tags, setTags] = useState<SessionTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(TAG_COLORS[0].value);
  const [showCreate, setShowCreate] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SessionTag | null>(null);

  const loadTags = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listSessionTags();
      setTags(data);
    } catch {
      toast(t('sessionTags.loadFailed'), 'error');
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    if (open) loadTags();
  }, [open, loadTags]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await api.createSessionTag(newName.trim(), newColor);
      setNewName('');
      setNewColor(TAG_COLORS[0].value);
      setShowCreate(false);
      loadTags();
      onTagsChanged();
      toast(t('sessionTags.created'), 'success');
    } catch (err: any) {
      toast(err.message || t('common.createFailed'), 'error');
    }
  };

  const handleEdit = async () => {
    if (editingId == null || !editName.trim()) return;
    try {
      await api.updateSessionTag(editingId, { name: editName.trim(), color: editColor });
      setEditingId(null);
      loadTags();
      onTagsChanged();
      toast(t('sessionTags.updated'), 'success');
    } catch (err: any) {
      toast(err.message || t('sessionTags.updateFailed'), 'error');
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.deleteSessionTag(pendingDelete.id);
      setPendingDelete(null);
      loadTags();
      onTagsChanged();
      toast(t('sessionTags.deleted'), 'success');
    } catch {
      toast(t('common.deleteFailed'), 'error');
    }
  };

  // Shared pointer-based reorder (works on touch; HTML5 DnD did not).
  const reorder = useListReorder(
    tags.map((tag) => tag.id),
    async (ids) => {
      const byId = new Map(tags.map((tag) => [tag.id, tag]));
      setTags(ids.map((id) => byId.get(id)!).filter(Boolean));
      try {
        await api.reorderSessionTags(ids.map((id, i) => ({ id, sort_order: i })));
        onTagsChanged();
      } catch {
        toast(t('sessionTags.reorderFailed'), 'error');
        void loadTags();
      }
    },
  );
  const orderedTags = reorder.order.map((id) => tags.find((tag) => tag.id === id)!).filter(Boolean);

  if (!open) return null;

  return (
    <>
      <Dialog open={open} onClose={onClose} title={t('sessionTags.manage')} size="sm">
        <div className="space-y-3">
          {/* Tag list */}
          <div className="space-y-1 min-h-[60px]">
            {loading && tags.length === 0 && (
              <div className="text-xs text-fg-faint text-center py-4">{t('common.loading')}</div>
            )}
            {!loading && tags.length === 0 && (
              <div className="text-xs text-fg-faint text-center py-4">{t('sessionTags.empty')}</div>
            )}
            {orderedTags.map((tag) => (
              <div
                key={tag.id}
                {...reorder.itemProps(tag.id)}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md border border-transparent hover:border-edge hover:bg-surface-muted transition-colors group cursor-grab active:cursor-grabbing ${
                  reorder.draggingId === tag.id ? 'opacity-50' : ''
                }`}
              >
                <GripVertical size={12} className="text-fg-faint flex-shrink-0" />
                {editingId === tag.id ? (
                  // No drag from the edit form — a press there is text selection.
                  <div className="flex-1 flex items-center gap-2" data-no-drag>
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
                      {t('common.save')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                ) : (
                  <>
                    <TagBadge name={tag.name} color={tag.color} size="md" />
                    <span className="flex-1" />
                    <button
                      onClick={() => {
                        setEditingId(tag.id);
                        setEditName(tag.name);
                        setEditColor(tag.color);
                      }}
                      className="p-1 text-fg-faint hover:text-fg-secondary rounded transition-colors opacity-0 group-hover:opacity-100 touch-visible"
                      title={t('common.edit')}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={() => setPendingDelete(tag)}
                      className="p-1 text-fg-faint hover:text-danger rounded transition-colors opacity-0 group-hover:opacity-100 touch-visible"
                      title={t('common.delete')}
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Create new */}
          {showCreate ? (
            <div className="border border-edge rounded-lg p-3 space-y-2 bg-surface-sunken">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('sessionTags.namePlaceholder')}
                size="sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') setShowCreate(false);
                }}
                autoFocus
              />
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-fg-faint mr-1">{t('common.color')}:</span>
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
              <div className="flex items-center gap-2">
                <TagBadge name={newName || t('sessionTags.preview')} color={newColor} size="md" />
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>
                  {t('common.cancel')}
                </Button>
                <Button size="sm" onClick={handleCreate} disabled={!newName.trim()}>
                  {t('common.create')}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setShowCreate(true)}>
              <Plus size={14} className="mr-1" />
              {t('sessionTags.newTag')}
            </Button>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={handleDelete}
        title={t('sessionTags.deleteTitle')}
        description={t('sessionTags.deleteDescription', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </>
  );
}
