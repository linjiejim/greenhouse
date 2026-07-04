/**
 * Quick Prompts management — Settings sub-page.
 *
 * Rebuilt on @greenhouse/crud: one defineCrud schema drives the list, the
 * add/edit dialog, filtering, and delete. The data source adapts the existing
 * hc-typed prompts client (fetchPrompts/create/update/delete) — no server change.
 * Available to all internal users; super users manage global prompts (per-row).
 */

import React, { useMemo } from 'react';
import { defineCrud, CrudPage, type CrudDataSource } from '@greenhouse/crud';
import { MessageSquare, Globe } from '../../lib/icons';
import { fetchPrompts, createPrompt, updatePrompt, deletePrompt } from '../../lib/api/prompts';
import { useT } from '../../lib/i18n';
import { useAuthStore } from '../../stores';
import type { UserPrompt } from '@greenhouse/types/api';

/** Client-side data source over the existing prompts API (small list, no server paging). */
const promptsDataSource: CrudDataSource<UserPrompt> = {
  async list(params) {
    let all = await fetchPrompts();
    for (const f of params.filter ?? []) {
      if (f.key === 'title' && f.method === 'like') {
        const q = String(f.value[0]).toLowerCase();
        all = all.filter((p) => p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q));
      } else if (f.key === 'is_global' && f.method === 'eq') {
        all = all.filter((p) => p.is_global === f.value[0]);
      }
    }
    const sort = params.sort?.[0];
    if (sort) {
      const { key, order } = sort;
      all = [...all].sort((a, b) => {
        const av = (a as unknown as Record<string, unknown>)[key] as string | number;
        const bv = (b as unknown as Record<string, unknown>)[key] as string | number;
        return (av > bv ? 1 : av < bv ? -1 : 0) * (order === 'asc' ? 1 : -1);
      });
    }
    const total = all.length;
    const skip = params.skip ?? 0;
    return { items: all.slice(skip, skip + (params.limit ?? 50)), total };
  },
  async get(id) {
    const found = (await fetchPrompts()).find((p) => String(p.id) === id);
    if (!found) throw new Error('Prompt not found');
    return found;
  },
  create: (data) => createPrompt(data as { title: string; content: string; shortcut?: string; is_global?: boolean }),
  update: (id, data) =>
    updatePrompt(
      Number(id),
      data as { title?: string; content?: string; shortcut?: string | null; is_global?: boolean },
    ),
  remove: (id) => deletePrompt(Number(id)),
};

export function PromptsPage() {
  const t = useT();
  const isSuper = useAuthStore((s) => s.currentUser?.role === 'super');

  const schema = useMemo(
    () =>
      defineCrud<UserPrompt>({
        name: t('app.prompts'),
        icon: MessageSquare,
        dataSource: promptsDataSource,
        pageSize: 50,
        emptyMessage: 'No quick prompts yet',
        defaultSort: { key: 'sort_order', order: 'asc' },
        columns: [
          { key: 'title', label: 'Title', sortable: true },
          {
            key: 'shortcut',
            label: 'Shortcut',
            type: 'custom',
            width: '8rem',
            render: (p) =>
              p.shortcut ? (
                <span className="text-[11px] font-mono text-fg-muted bg-surface-muted px-1.5 py-0.5 rounded">
                  /{p.shortcut}
                </span>
              ) : (
                <span className="text-fg-faint">—</span>
              ),
          },
          {
            key: 'is_global',
            label: 'Scope',
            type: 'custom',
            width: '7rem',
            render: (p) =>
              p.is_global ? (
                <span className="inline-flex items-center gap-0.5 text-[10px] bg-surface-muted rounded px-1.5 py-0.5">
                  <Globe size={10} /> Global
                </span>
              ) : (
                <span className="text-xs text-fg-muted">Personal</span>
              ),
          },
          { key: 'content', label: 'Content', type: 'longtext', truncate: 90, responsiveHide: 'md' },
        ],
        filters: [
          { key: 'title', label: 'Search prompts', kind: 'text' },
          { key: 'is_global', label: 'Global only', kind: 'boolean', secondary: true },
        ],
        formFields: [
          { key: 'title', label: 'Title', type: 'text', required: true, placeholder: 'e.g. Translate to English' },
          { key: 'shortcut', label: 'Shortcut', type: 'text', width: 2, comment: 'Optional. Filters when typing /' },
          { key: 'content', label: 'Prompt Content', type: 'textarea', required: true, rows: 5 },
          {
            key: 'is_global',
            label: 'Global prompt (visible to all users)',
            type: 'switch',
            visible: () => isSuper,
            defaultValue: false,
          },
        ],
        access: {
          canAdd: true,
          canEdit: true,
          canDelete: true,
          canEditRow: (p) => isSuper || !p.is_global,
          canDeleteRow: (p) => isSuper || !p.is_global,
        },
      }),
    [t, isSuper],
  );

  return <CrudPage schema={schema} />;
}
