/**
 * Memory panel — view, edit, and delete AI-learned memories, on @greenhouse/crud (cards).
 * Only visible to users with the 'memory' feature enabled.
 *
 * The card grid, the edit Dialog, delete-confirm, empty state and toolbar all
 * come from `defineCrud` with `variant: 'cards'`. Memories are AI-populated so
 * there is no Add (edit + delete only). A category select filter switches groups.
 * The list endpoint returns 403 when the feature is off — a thin wrapper renders
 * the dedicated "not enabled" EmptyState instead of CrudPage in that case.
 *
 * Embedded as a sub-module of the Settings page.
 */

import React, { useMemo, useState } from 'react';
import { defineCrud, CrudPage, type CrudDataSource, type CrudActionContext } from '@greenhouse/crud';
import { Button, EmptyState } from '../../components/ui';
import { authFetch } from '../../lib/auth';
import { Brain, Pencil, Trash2, Sparkles, User, Wrench } from '../../lib/icons';

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

// ─── Card ────────────────────────────────────────────────

/** One memory card: content, created date + "used N×", and edit/delete actions. */
function MemoryCard({ row, ctx }: { row: Memory; ctx: CrudActionContext }) {
  const meta = CATEGORY_META[row.category] || { label: row.category, icon: Brain, color: 'text-fg-muted' };
  const Icon = meta.icon;

  return (
    <div className="group bg-surface-raised border border-edge rounded-lg p-4 h-full flex flex-col justify-between gap-3">
      <div className="min-w-0 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Icon className={`w-3.5 h-3.5 ${meta.color}`} />
          <span className="text-xs font-medium text-fg-muted">{meta.label}</span>
        </div>
        <p className="text-sm text-fg-default">{row.content}</p>
        <p className="text-xs text-fg-muted">
          {new Date(row.created_at).toLocaleDateString()}
          {row.access_count > 0 && ` · used ${row.access_count}×`}
        </p>
      </div>
      <div className="flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => ctx.openEdit(row as unknown as Record<string, unknown>)}
          title="Edit"
        >
          <Pencil size={13} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-danger hover:text-danger"
          onClick={() => ctx.openDelete(row as unknown as Record<string, unknown>)}
          title="Delete"
        >
          <Trash2 size={13} />
        </Button>
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────

export function MemoryPanel() {
  const [notEnabled, setNotEnabled] = useState(false);

  const dataSource = useMemo<CrudDataSource<Memory>>(
    () => ({
      async list(params) {
        const res = await authFetch('/api/auth/me/memories');
        if (res.status === 403) {
          setNotEnabled(true);
          return { items: [], total: 0 };
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to load memories');
        }
        const data = await res.json();
        const memories: Memory[] = data.memories || [];
        const cat = params.filter?.find((f) => f.key === 'category')?.value?.[0] as string | undefined;
        const filtered = cat ? memories.filter((m) => m.category === cat) : memories;
        return { items: filtered, total: filtered.length };
      },
      async update(id, data) {
        const res = await authFetch(`/api/auth/me/memories/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: String(data.content ?? '').trim(), category: data.category }),
        });
        if (!res.ok) {
          throw new Error((await res.json().catch(() => ({}))).error || 'Failed to update memory');
        }
        return res.json();
      },
      async remove(id) {
        const res = await authFetch(`/api/auth/me/memories/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          throw new Error((await res.json().catch(() => ({}))).error || 'Failed to delete memory');
        }
        return res.json();
      },
    }),
    [],
  );

  const schema = useMemo(
    () =>
      defineCrud<Memory>({
        name: 'Memory',
        icon: Brain,
        idField: 'id',
        dataSource,
        variant: 'cards',
        pageSize: 50,
        storageKey: 'settings-memory',
        formMode: 'dialog',
        formTitle: () => 'Edit memory',
        columns: [
          { key: 'content', label: 'Memory', truncate: 80 },
          {
            key: 'category',
            label: 'Category',
            type: 'badge',
            badgeMap: { fact: 'default', preference: 'secondary', behavior: 'success' },
          },
          { key: 'created_at', label: 'Created', type: 'date' },
          { key: 'access_count', label: 'Used', type: 'number' },
        ],
        filters: [
          {
            key: 'category',
            label: 'Category',
            kind: 'select',
            options: [
              { value: 'fact', label: 'Fact' },
              { value: 'preference', label: 'Preference' },
              { value: 'behavior', label: 'Behavior' },
            ],
          },
        ],
        formFields: [
          { key: 'content', label: 'Memory', type: 'textarea', rows: 3, width: 4, required: true },
          {
            key: 'category',
            label: 'Category',
            type: 'select',
            width: 4,
            required: true,
            options: [
              { value: 'preference', label: 'Preference' },
              { value: 'fact', label: 'Fact' },
              { value: 'behavior', label: 'Behavior' },
            ],
          },
        ],
        access: { canAdd: false, canEdit: true, canDelete: true },
        slots: {
          renderCard: (row, ctx) => <MemoryCard row={row} ctx={ctx} />,
          empty: (
            <EmptyState
              icon={Brain}
              title="No memories yet"
              description="Memories are extracted from your conversations during the daily processing job."
            />
          ),
        },
      }),
    [dataSource],
  );

  if (notEnabled) {
    return (
      <EmptyState
        icon={Brain}
        title="Memory is not enabled"
        description="Contact your administrator to enable AI Memory for your account."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted max-w-2xl">
        Facts the AI has learned about you from past conversations — these personalize your experience. You can edit or
        delete any memory.
      </p>
      <CrudPage schema={schema} />
    </div>
  );
}
