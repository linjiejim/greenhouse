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

interface TagManagerDialogProps {
  open: boolean;
  onClose: () => void;
  onTagsChanged: () => void;
}

export function TagManagerDialog({ open, onClose, onTagsChanged }: TagManagerDialogProps) {
  const [tags, setTags] = useState<SessionTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(TAG_COLORS[0].value);
  const [showCreate, setShowCreate] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SessionTag | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const loadTags = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listSessionTags();
      setTags(data);
    } catch {
      toast('Failed to load tags', 'error');
    }
    setLoading(false);
  }, []);

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
      toast('Tag created', 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to create', 'error');
    }
  };

  const handleEdit = async () => {
    if (editingId == null || !editName.trim()) return;
    try {
      await api.updateSessionTag(editingId, { name: editName.trim(), color: editColor });
      setEditingId(null);
      loadTags();
      onTagsChanged();
      toast('Tag updated', 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to update', 'error');
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.deleteSessionTag(pendingDelete.id);
      setPendingDelete(null);
      loadTags();
      onTagsChanged();
      toast('Tag deleted', 'success');
    } catch {
      toast('Failed to delete', 'error');
    }
  };

  const handleDragStart = (idx: number) => setDragIdx(idx);
  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx == null || dragIdx === idx) return;
    const next = [...tags];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(idx, 0, moved);
    setTags(next);
    setDragIdx(idx);
  };
  const handleDragEnd = async () => {
    setDragIdx(null);
    const updates = tags.map((t, i) => ({ id: t.id, sort_order: i }));
    try {
      await api.reorderSessionTags(updates);
      onTagsChanged();
    } catch {
      toast('Failed to reorder', 'error');
    }
  };

  if (!open) return null;

  return (
    <>
      <Dialog open={open} onClose={onClose} title="Manage Tags" size="sm">
        <div className="space-y-3">
          {/* Tag list */}
          <div className="space-y-1 min-h-[60px]">
            {loading && tags.length === 0 && <div className="text-xs text-fg-faint text-center py-4">Loading...</div>}
            {!loading && tags.length === 0 && (
              <div className="text-xs text-fg-faint text-center py-4">No tags yet. Create your first tag below.</div>
            )}
            {tags.map((tag, idx) => (
              <div
                key={tag.id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDragEnd={handleDragEnd}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md border border-transparent hover:border-edge hover:bg-surface-muted transition-colors group cursor-move ${
                  dragIdx === idx ? 'opacity-50' : ''
                }`}
              >
                <GripVertical size={12} className="text-fg-faint flex-shrink-0" />
                {editingId === tag.id ? (
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
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      Cancel
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
                      title="Edit"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={() => setPendingDelete(tag)}
                      className="p-1 text-fg-faint hover:text-danger rounded transition-colors opacity-0 group-hover:opacity-100 touch-visible"
                      title="Delete"
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
                placeholder="Tag name"
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
              <div className="flex items-center gap-2">
                <TagBadge name={newName || 'Preview'} color={newColor} size="md" />
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleCreate} disabled={!newName.trim()}>
                  Create
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setShowCreate(true)}>
              <Plus size={14} className="mr-1" />
              New Tag
            </Button>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={handleDelete}
        title="Delete tag?"
        description={`Tag "${pendingDelete?.name}" will be removed from all sessions.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
      />
    </>
  );
}
