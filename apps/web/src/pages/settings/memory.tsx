/**
 * Memory panel — view, edit, and delete AI-learned memories.
 * Only visible to users with the 'memory' feature enabled.
 * Embedded as a sub-module of the Settings page.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, Textarea, Select, EmptyState, ListToolbar } from '../../components/ui';
import { authFetch } from '../../lib/auth';
import { Brain, Pencil, Trash2, Check, X, Sparkles, User, Wrench } from '../../lib/icons';

// ─── Types ───────────────────────────────────────────────

interface Memory {
  id: number;
  category: string;
  content: string;
  source_session_id: string | null;
  confidence: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
}

const CATEGORY_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  preference: { label: 'Preference', icon: Sparkles, color: 'text-info' },
  fact: { label: 'Fact', icon: User, color: 'text-primary-fg' },
  behavior: { label: 'Behavior', icon: Wrench, color: 'text-success' },
};

// ─── Component ───────────────────────────────────────────

export function MemoryPanel() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const loadMemories = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await authFetch('/api/auth/me/memories');
      if (res.status === 403) {
        setError('not_enabled');
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to load memories');
      }
      const data = await res.json();
      setMemories(data.memories || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load memories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  const handleEdit = (mem: Memory) => {
    setEditingId(mem.id);
    setEditContent(mem.content);
    setEditCategory(mem.category);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditContent('');
    setEditCategory('');
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editContent.trim()) return;
    try {
      const res = await authFetch(`/api/auth/me/memories/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent.trim(), category: editCategory }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update memory');
      }
      setEditingId(null);
      await loadMemories();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      setDeletingId(id);
      const res = await authFetch(`/api/auth/me/memories/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete memory');
      }
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeletingId(null);
    }
  };

  // Group by category
  const grouped: Record<string, Memory[]> = {};
  for (const m of memories) {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m);
  }

  const categoryOrder = ['fact', 'preference', 'behavior'];
  const sortedCategories = categoryOrder.filter((c) => grouped[c]?.length);
  // Include any unknown categories
  for (const c of Object.keys(grouped)) {
    if (!sortedCategories.includes(c)) sortedCategories.push(c);
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <ListToolbar
        hint={
          <span className="block max-w-2xl">
            Facts the AI has learned about you from past conversations — these personalize your experience. You can edit
            or delete any memory.
          </span>
        }
        count={`${memories.length} ${memories.length === 1 ? 'memory' : 'memories'}`}
      />

      {/* Not enabled */}
      {error === 'not_enabled' && (
        <EmptyState
          icon={Brain}
          title="Memory is not enabled"
          description="Contact your administrator to enable AI Memory for your account."
        />
      )}

      {/* Error */}
      {error && error !== 'not_enabled' && (
        <div className="bg-danger-subtle text-danger text-sm px-4 py-2 rounded-lg border border-edge">{error}</div>
      )}

      {/* Loading */}
      {loading && <div className="text-center text-fg-muted py-12">Loading memories...</div>}

      {/* Empty state */}
      {!loading && !error && memories.length === 0 && (
        <EmptyState
          icon={Brain}
          title="No memories yet"
          description="Memories are extracted from your conversations during the daily processing job."
        />
      )}

      {/* Memory groups */}
      {!loading &&
        sortedCategories.map((category) => {
          const meta = CATEGORY_META[category] || { label: category, icon: Brain, color: 'text-fg-muted' };
          const Icon = meta.icon;
          const items = grouped[category];

          return (
            <div key={category} className="bg-surface-raised border border-edge rounded-xl overflow-hidden">
              {/* Category header */}
              <div className="flex items-center gap-2 px-4 py-2.5 bg-surface-sunken border-b border-edge">
                <Icon className={`w-4 h-4 ${meta.color}`} />
                <span className="text-sm font-medium text-fg-default">{meta.label}</span>
                <span className="text-xs text-fg-muted">({items.length})</span>
              </div>

              {/* Memory items */}
              <div className="divide-y divide-edge">
                {items.map((mem) => (
                  <div
                    key={mem.id}
                    className="group flex items-start gap-3 px-4 py-3 hover:bg-surface-sunken transition-colors"
                  >
                    {editingId === mem.id ? (
                      /* Edit mode */
                      <div className="flex-1 space-y-2">
                        <Textarea
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          rows={2}
                          className="w-full text-sm"
                          autoFocus
                        />
                        <div className="flex items-center gap-2">
                          <Select
                            value={editCategory}
                            onChange={(e) => setEditCategory(e.target.value)}
                            size="sm"
                            inline
                          >
                            <option value="preference">Preference</option>
                            <option value="fact">Fact</option>
                            <option value="behavior">Behavior</option>
                          </Select>
                          <div className="flex-1" />
                          <Button size="sm" variant="ghost" onClick={handleCancelEdit}>
                            <X className="w-3.5 h-3.5" />
                            Cancel
                          </Button>
                          <Button size="sm" onClick={handleSaveEdit}>
                            <Check className="w-3.5 h-3.5" />
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      /* View mode */
                      <>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-fg-default">{mem.content}</p>
                          <p className="text-xs text-fg-muted mt-1">
                            {new Date(mem.created_at).toLocaleDateString()}
                            {mem.access_count > 0 && ` · used ${mem.access_count}×`}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <button
                            onClick={() => handleEdit(mem)}
                            className="p-1 text-fg-muted hover:text-primary-fg rounded transition-colors touch-visible"
                            title="Edit"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(mem.id)}
                            disabled={deletingId === mem.id}
                            className="p-1 text-fg-muted hover:text-danger rounded transition-colors disabled:opacity-50 touch-visible"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
    </div>
  );
}
