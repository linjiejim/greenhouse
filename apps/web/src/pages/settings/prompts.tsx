/**
 * Quick Prompts management — Settings sub-page.
 *
 * Available to all internal users.
 * Super users can create/edit global prompts.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Button,
  Dialog,
  Input,
  Textarea,
  Badge,
  Spinner,
  ConfirmDialog,
  EmptyState,
  ListToolbar,
  Checkbox,
  toast,
} from '../../components/ui';
import { Plus, Pencil, Trash2, Globe, MessageSquare } from '../../lib/icons';
import * as api from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useAuthStore } from '../../stores';

export function PromptsPage() {
  const t = useT();
  const { currentUser } = useAuthStore();
  const isSuper = currentUser?.role === 'super';
  const [prompts, setPrompts] = useState<api.UserPrompt[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<api.UserPrompt | null>(null);
  const [form, setForm] = useState({ title: '', content: '', shortcut: '', is_global: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadPrompts = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.fetchPrompts();
      setPrompts(list);
    } catch (_err) {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadPrompts();
  }, [loadPrompts]);

  const openCreate = () => {
    setEditingPrompt(null);
    setForm({ title: '', content: '', shortcut: '', is_global: false });
    setError('');
    setDialogOpen(true);
  };

  const openEdit = (prompt: api.UserPrompt) => {
    setEditingPrompt(prompt);
    setForm({
      title: prompt.title,
      content: prompt.content,
      shortcut: prompt.shortcut || '',
      is_global: prompt.is_global,
    });
    setError('');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.title.trim() || !form.content.trim()) {
      setError('Title and content are required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        title: form.title.trim(),
        content: form.content.trim(),
        shortcut: form.shortcut.trim() || undefined,
        is_global: isSuper ? form.is_global : undefined,
      };
      if (editingPrompt) {
        await api.updatePrompt(editingPrompt.id, payload);
      } else {
        await api.createPrompt(payload);
      }
      setDialogOpen(false);
      loadPrompts();
    } catch (err: any) {
      setError(err.message || t('common.saveFailed'));
    }
    setSaving(false);
  };

  const [pendingDelete, setPendingDelete] = useState<api.UserPrompt | null>(null);

  const executeDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.deletePrompt(pendingDelete.id);
      toast(t('settings.promptDeleted'), 'success');
      loadPrompts();
    } catch (_err) {
      toast(t('common.deleteFailed'), 'error');
    }
    setPendingDelete(null);
  };

  const createButton = (
    <Button size="sm" onClick={openCreate}>
      <Plus size={14} className="mr-1" /> Create prompt
    </Button>
  );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <ListToolbar
        hint={
          <>
            Type <kbd className="px-1 py-0.5 bg-surface-muted rounded text-[10px] font-mono">/</kbd> in chat to use
            prompts
          </>
        }
        count={`${prompts.length} total`}
        actions={createButton}
      />

      {loading && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {!loading && prompts.length === 0 && (
        <EmptyState
          icon={MessageSquare}
          title="No quick prompts yet"
          description="Create your first prompt to speed up common tasks."
          action={createButton}
        />
      )}

      {/* Table */}
      {!loading && prompts.length > 0 && (
        <div className="bg-surface-raised border border-edge rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-fg-muted">
              <tr>
                <th className="text-left px-3 py-2">Title</th>
                <th className="text-left px-3 py-2 w-24">Shortcut</th>
                <th className="text-left px-3 py-2 w-20">Scope</th>
                <th className="text-left px-3 py-2">Content</th>
                <th className="text-center px-3 py-2 w-16">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {prompts.map((p) => {
                const canEdit = isSuper || !p.is_global;
                return (
                  <tr key={p.id} className="hover:bg-surface-sunken transition-colors">
                    <td className="px-3 py-2.5">
                      <span className="font-medium text-fg">{p.title}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      {p.shortcut ? (
                        <span className="text-[11px] font-mono text-fg-muted bg-surface-muted px-1.5 py-0.5 rounded">
                          /{p.shortcut}
                        </span>
                      ) : (
                        <span className="text-fg-faint">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {p.is_global ? (
                        <Badge variant="default" className="text-[10px]">
                          <Globe size={10} className="mr-0.5" /> Global
                        </Badge>
                      ) : (
                        <span className="text-xs text-fg-muted">Personal</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-fg-muted truncate max-w-md">{p.content}</td>
                    <td className="px-3 py-2.5 text-center">
                      {canEdit && (
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => openEdit(p)}
                            className="p-1 text-fg-muted hover:text-primary-fg hover:bg-surface-muted rounded transition-colors"
                            title="Edit"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={() => setPendingDelete(p)}
                            className="p-1 text-fg-muted hover:text-danger hover:bg-danger-subtle rounded transition-colors"
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editingPrompt ? t('settings.editPrompt') : t('settings.newPrompt')}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-fg-secondary mb-1">Title *</label>
            <Input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Translate to English"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-fg-secondary mb-1">Shortcut</label>
            <div className="flex items-center gap-1">
              <span className="text-fg-muted text-sm">/</span>
              <Input
                value={form.shortcut}
                onChange={(e) => setForm((f) => ({ ...f, shortcut: e.target.value.replace(/\s/g, '') }))}
                placeholder="translate"
                className="flex-1"
              />
            </div>
            <p className="text-[10px] text-fg-faint mt-0.5">Optional. Used for quick filtering when typing /</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-fg-secondary mb-1">Prompt Content *</label>
            <Textarea
              value={form.content}
              onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
              placeholder="Please translate the above content to English..."
              rows={5}
            />
          </div>
          {isSuper && (
            <Checkbox
              checked={form.is_global}
              onChange={(e) => setForm((f) => ({ ...f, is_global: e.target.checked }))}
              label={
                <span className="flex items-center gap-1.5">
                  <Globe size={14} className="text-fg-muted" />
                  Global prompt (visible to all users)
                </span>
              }
            />
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? <Spinner className="mr-1" /> : null}
              {editingPrompt ? t('common.save') : t('common.create')}
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={executeDelete}
        title={`Delete "${pendingDelete?.title}"?`}
        confirmLabel="Delete"
        confirmVariant="destructive"
      />
    </div>
  );
}
