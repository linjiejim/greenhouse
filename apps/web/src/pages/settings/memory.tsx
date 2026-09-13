/**
 * Memory panel — read, edit, pin, archive and delete what the agent remembers.
 *
 * The title is the line the agent actually sees in its prompt, so it is the
 * primary text here and is editable; the body is what it opens on demand.
 * Dormant and archived memories stay visible behind a filter — nothing the
 * system retires disappears without the user seeing it.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, Input, Textarea, Select, SearchInput, EmptyState, Tag } from '../../components/ui';
import { authFetch } from '../../lib/auth';
import { formatDay } from '../../lib/utils';
import { Brain, Pencil, Trash2, Check, X, Sparkles, User, Wrench, Pin, Archive, RotateCcw } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { ModulePage } from '../../components/app/module-page';

// ─── Types ───────────────────────────────────────────────

type MemoryStatus = 'active' | 'dormant' | 'archived' | 'superseded';

interface Memory {
  id: number;
  category: string;
  title: string;
  content: string;
  status: MemoryStatus;
  pinned: boolean;
  source: string;
  source_session_id: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

const CATEGORY_META: Record<string, { labelKey: TranslationKey; icon: React.ElementType; color: string }> = {
  preference: { labelKey: 'memory.preference', icon: Sparkles, color: 'text-purple-500' },
  fact: { labelKey: 'memory.fact', icon: User, color: 'text-blue-500' },
  behavior: { labelKey: 'memory.behavior', icon: Wrench, color: 'text-green-500' },
};

const STATUS_TONE: Record<MemoryStatus, 'neutral' | 'warning' | 'info'> = {
  active: 'neutral',
  dormant: 'warning',
  archived: 'neutral',
  superseded: 'info',
};

const STATUS_HINT: Record<MemoryStatus, TranslationKey> = {
  active: 'memory.activeHint',
  dormant: 'memory.dormantHint',
  archived: 'memory.archivedHint',
  superseded: 'memory.supersededHint',
};

const STATUS_LABEL: Record<MemoryStatus, TranslationKey> = {
  active: 'common.active',
  dormant: 'memory.dormant',
  archived: 'memory.archived',
  superseded: 'memory.superseded',
};

// ─── Component ───────────────────────────────────────────

export function MemoryPanel() {
  const t = useT();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'live' | MemoryStatus>('live');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

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
        throw new Error(data.error || t('memory.loadFailed'));
      }
      const data = await res.json();
      setMemories(data.memories || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('memory.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  const patchMemory = async (id: number, body: Record<string, unknown>) => {
    try {
      setBusyId(id);
      const res = await authFetch(`/api/auth/me/memories/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('memory.updateFailed'));
      }
      await loadMemories();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('memory.updateFailed'));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editTitle.trim() || !editContent.trim()) return;
    const ok = await patchMemory(editingId, {
      title: editTitle.trim(),
      content: editContent.trim(),
      category: editCategory,
    });
    if (ok) setEditingId(null);
  };

  const handleDelete = async (id: number) => {
    try {
      setBusyId(id);
      const res = await authFetch(`/api/auth/me/memories/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('memory.deleteFailed'));
      }
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('memory.deleteFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return memories.filter((m) => {
      const statusOk =
        statusFilter === 'live' ? m.status === 'active' || m.status === 'dormant' : m.status === statusFilter;
      if (!statusOk) return false;
      if (!term) return true;
      return m.title.toLowerCase().includes(term) || m.content.toLowerCase().includes(term);
    });
  }, [memories, search, statusFilter]);

  const grouped = useMemo(() => {
    const map: Record<string, Memory[]> = {};
    for (const m of visible) {
      (map[m.category] ??= []).push(m);
    }
    return map;
  }, [visible]);

  const sortedCategories = useMemo(() => {
    const order = ['fact', 'preference', 'behavior'];
    const known = order.filter((c) => grouped[c]?.length);
    return [...known, ...Object.keys(grouped).filter((c) => !known.includes(c))];
  }, [grouped]);

  const activeCount = memories.filter((m) => m.status === 'active').length;

  if (error === 'not_enabled') {
    return (
      <ModulePage moduleId="settings.memory" layout="list">
        <EmptyState icon={Brain} title={t('memory.notEnabled')} description={t('memory.notEnabledHint')} />
      </ModulePage>
    );
  }

  return (
    <ModulePage moduleId="settings.memory" layout="list">
      <div className="space-y-4">
        {/* Header info */}
        <div className="flex items-center gap-3 bg-surface-card border border-edge rounded-xl p-4">
          <div className="p-2 rounded-lg bg-purple-500/10">
            <Brain className="w-5 h-5 text-purple-500" />
          </div>
          <div className="flex-1">
            <p className="text-sm text-fg-muted">{t('memory.intro')}</p>
          </div>
          <div className="text-sm text-fg-muted font-medium tabular-nums shrink-0">
            {t('memory.activeCount', { count: activeCount })}
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap">
          <SearchInput
            size="sm"
            value={search}
            onChange={setSearch}
            placeholder={t('memory.search')}
            className="flex-1 min-w-[120px] sm:flex-none sm:w-[220px]"
          />
          <Select
            size="sm"
            inline
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'live' | MemoryStatus)}
          >
            <option value="live">{t('memory.activeDormant')}</option>
            <option value="active">{t('memory.activeOnly')}</option>
            <option value="dormant">{t('memory.dormant')}</option>
            <option value="archived">{t('memory.archived')}</option>
            <option value="superseded">{t('memory.superseded')}</option>
          </Select>
          <div className="flex-1" />
          <span className="text-xs text-fg-faint">{t('memory.shown', { count: visible.length })}</span>
        </div>

        {error && error !== 'not_enabled' && (
          <div className="bg-danger-subtle text-danger text-sm px-4 py-2 rounded-lg border border-edge">{error}</div>
        )}

        {loading && <div className="text-center text-fg-muted py-12">{t('memory.loading')}</div>}

        {!loading && visible.length === 0 && (
          <EmptyState
            icon={Brain}
            title={t(memories.length === 0 ? 'memory.nothingYet' : 'memory.noMatch')}
            description={memories.length === 0 ? t('memory.nothingYetHint') : t('memory.noMatchHint')}
          />
        )}

        {!loading &&
          sortedCategories.map((category) => {
            const meta = CATEGORY_META[category];
            const Icon = meta?.icon ?? Brain;
            const items = grouped[category];

            return (
              <div key={category} className="bg-surface-card border border-edge rounded-xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 bg-surface-sunken border-b border-edge">
                  <Icon className={`w-4 h-4 ${meta?.color ?? 'text-fg-muted'}`} />
                  <span className="text-sm font-medium text-fg">{meta ? t(meta.labelKey) : category}</span>
                  <span className="text-xs text-fg-muted">({items.length})</span>
                </div>

                <div className="divide-y divide-edge">
                  {items.map((mem) => (
                    <div key={mem.id} className="group px-4 py-3 hover:bg-surface-sunken transition-colors">
                      {editingId === mem.id ? (
                        <div className="space-y-2">
                          <Input
                            size="sm"
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            maxLength={80}
                            placeholder={t('memory.titlePlaceholder')}
                            autoFocus
                          />
                          <Textarea
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            rows={3}
                            className="w-full text-sm"
                            placeholder={t('memory.contentPlaceholder')}
                          />
                          <div className="flex items-center gap-2">
                            <Select
                              size="xs"
                              inline
                              value={editCategory}
                              onChange={(e) => setEditCategory(e.target.value)}
                            >
                              <option value="preference">{t('memory.preference')}</option>
                              <option value="fact">{t('memory.fact')}</option>
                              <option value="behavior">{t('memory.behavior')}</option>
                            </Select>
                            <div className="flex-1" />
                            <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                              <X className="w-3.5 h-3.5" />
                              {t('common.cancel')}
                            </Button>
                            <Button size="sm" onClick={handleSaveEdit} disabled={busyId === mem.id}>
                              <Check className="w-3.5 h-3.5" />
                              {t('common.save')}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {mem.pinned && <Pin className="w-3 h-3 text-primary-600 shrink-0" />}
                              <p className="text-sm text-fg font-medium">{mem.title}</p>
                              {mem.status !== 'active' && (
                                <Tag tone={STATUS_TONE[mem.status]} truncate title={t(STATUS_HINT[mem.status])}>
                                  {t(STATUS_LABEL[mem.status])}
                                </Tag>
                              )}
                            </div>
                            <p className="text-sm text-fg-secondary mt-1">{mem.content}</p>
                            <p className="text-xs text-fg-faint mt-1">
                              {formatDay(mem.created_at)}
                              {mem.last_used_at && ` · ${t('memory.lastUsed', { date: formatDay(mem.last_used_at) })}`}
                              {mem.source === 'consolidation' && ` · ${t('memory.merged')}`}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 touch-visible transition-opacity shrink-0">
                            <button
                              onClick={() => patchMemory(mem.id, { pinned: !mem.pinned })}
                              disabled={busyId === mem.id}
                              className={`p-1 rounded transition-colors ${mem.pinned ? 'text-primary-600' : 'text-fg-muted hover:text-primary-600'}`}
                              title={mem.pinned ? t('memory.unpin') : t('memory.pin')}
                            >
                              <Pin className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => {
                                setEditingId(mem.id);
                                setEditTitle(mem.title);
                                setEditContent(mem.content);
                                setEditCategory(mem.category);
                              }}
                              className="p-1 text-fg-muted hover:text-info rounded transition-colors"
                              title={t('common.edit')}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            {mem.status === 'archived' || mem.status === 'dormant' ? (
                              <button
                                onClick={() => patchMemory(mem.id, { status: 'active' })}
                                disabled={busyId === mem.id}
                                className="p-1 text-fg-muted hover:text-success rounded transition-colors"
                                title={t('memory.restore')}
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                            ) : (
                              <button
                                onClick={() => patchMemory(mem.id, { status: 'archived' })}
                                disabled={busyId === mem.id}
                                className="p-1 text-fg-muted hover:text-warning rounded transition-colors"
                                title={t('memory.archive')}
                              >
                                <Archive className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => handleDelete(mem.id)}
                              disabled={busyId === mem.id}
                              className="p-1 text-fg-muted hover:text-destructive rounded transition-colors disabled:opacity-50"
                              title={t('memory.deletePermanently')}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
      </div>
    </ModulePage>
  );
}
