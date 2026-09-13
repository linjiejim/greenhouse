/**
 * Quick Prompts management — Settings sub-page.
 *
 * Rebuilt on @greenhouse/crud: one defineCrud schema drives the list, the add/edit
 * dialog, and delete-confirm. The data source adapts the existing hc-typed
 * prompts client (fetchPrompts/create/update/delete). Mine and Shared are
 * available to every internal user; Team is a super-only administration view.
 */

import React, { useMemo, useState } from 'react';
import { defineCrud, CrudPage, type CrudDataSource } from './crud';
import { Badge, Button, Checkbox, EmptyState, FilterPills, Input } from '../../components/ui';
import { Plus, Globe, MessageSquare } from '../../lib/icons';
import { fetchPrompts, createPrompt, updatePrompt, deletePrompt } from '../../lib/api/prompts';
import { useT } from '../../lib/i18n';
import { useAuthStore } from '../../stores';
import type { PromptScope, UserPrompt } from '@greenhouse/types/api';
import { parseExpectedTools, parseTaskVariables, placeholdersIn } from '@greenhouse/types/tasks';
import { assetScopeItems, DEFAULT_ASSET_SCOPE, type AssetScope } from '../../lib/asset-scopes';
import { ModulePage } from '../../components/app/module-page';

/** Trim + shape the form payload exactly like the legacy dialog did
 *  (empty shortcut → undefined; is_global only present when the field was visible). */
function shapePayload(data: Record<string, unknown>) {
  return {
    title: String(data.title ?? '').trim(),
    content: String(data.content ?? '').trim(),
    shortcut: String(data.shortcut ?? '').trim() || undefined,
    description: String(data.description ?? '').trim() || undefined,
    ...('is_global' in data ? { is_global: !!data.is_global } : {}),
  };
}

export function PromptsPage() {
  const t = useT();
  const currentUser = useAuthStore((state) => state.currentUser);
  const isSuper = currentUser?.role === 'super';
  const [scope, setScope] = useState<AssetScope>(DEFAULT_ASSET_SCOPE);

  const dataSource = useMemo<CrudDataSource<UserPrompt>>(
    () => ({
      async list(params) {
        const all = await fetchPrompts(scope as PromptScope);
        const skip = params.skip ?? 0;
        return { items: all.slice(skip, skip + (params.limit ?? 50)), total: all.length };
      },
      create: (data) => createPrompt(shapePayload(data)),
      update: async (id, data) => {
        const payload = shapePayload(data);
        const row = (await fetchPrompts(scope as PromptScope)).find((prompt) => prompt.id === Number(id));
        const variables = parseTaskVariables(row?.variables).filter((variable) =>
          placeholdersIn(payload.content).includes(variable.key),
        );
        return updatePrompt(Number(id), { ...payload, variables });
      },
      remove: (id) => deletePrompt(Number(id)),
    }),
    [scope],
  );

  const schema = useMemo(
    () =>
      defineCrud<UserPrompt>({
        name: 'Task',
        dataSource,
        pageSize: 50,
        storageKey: `settings-prompts:${scope}`,
        formSize: 'xl',
        formTitle: (mode) => (mode === 'add' ? t('settings.newPrompt') : t('settings.editPrompt')),
        columns: [
          {
            key: 'title',
            label: t('settings.promptTitle'),
            type: 'custom',
            render: (p) => <span className="font-medium text-fg">{p.title}</span>,
          },
          ...(scope === 'mine'
            ? []
            : [
                {
                  key: 'owner_nickname',
                  label: t('assetScopes.owner'),
                  type: 'custom' as const,
                  width: '8rem',
                  render: (prompt: UserPrompt) => (
                    <span className="text-xs text-fg-muted">{prompt.owner_nickname ?? prompt.user_id}</span>
                  ),
                },
              ]),
          {
            key: 'shortcut',
            label: t('settings.promptShortcut'),
            type: 'custom',
            width: '6rem',
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
            label: t('settings.promptScope'),
            type: 'custom',
            width: '5rem',
            render: (p) =>
              p.is_global ? (
                <Badge variant="default" className="text-[10px]">
                  <Globe size={10} className="mr-0.5" /> {t('settings.promptGlobal')}
                </Badge>
              ) : (
                <span className="text-xs text-fg-muted">{t('settings.promptPersonal')}</span>
              ),
          },
          {
            key: 'expected_tools',
            label: t('tasks.usesTools'),
            type: 'custom',
            width: '11rem',
            // The capability range at a glance. Captured tasks carry a real
            // tool list; hand-written ones stay blank, which is honest — they
            // were never observed running.
            render: (p) => {
              const vars = parseTaskVariables(p.variables);
              const tools = parseExpectedTools(p.expected_tools);
              if (vars.length === 0 && tools.length === 0) return <span className="text-fg-faint">—</span>;
              return (
                <span className="flex flex-wrap gap-1">
                  {vars.map((v) => (
                    <span
                      key={v.key}
                      title={v.label}
                      className="rounded bg-surface-muted px-1 py-0.5 font-mono text-[10px] text-fg-muted"
                    >{`{{${v.key}}}`}</span>
                  ))}
                  {tools.map((tool) => (
                    <span key={tool} className="rounded bg-surface-muted px-1 py-0.5 text-[10px] text-fg-muted">
                      {tool}
                    </span>
                  ))}
                </span>
              );
            },
          },
          { key: 'content', label: t('settings.promptContent'), type: 'longtext', truncate: 90 },
        ],
        formFields: [
          {
            key: 'title',
            label: t('settings.promptTitle'),
            type: 'text',
            required: true,
            placeholder: t('settings.egTranslateToEnglish'),
          },
          { key: 'description', label: t('tasks.fieldDescription'), type: 'text' },
          {
            key: 'shortcut',
            label: t('settings.promptShortcut'),
            type: 'custom',
            comment: t('settings.promptShortcutHint'),
            render: ({ value, onChange }) => (
              <div className="flex items-center gap-1">
                <span className="text-fg-muted text-sm">/</span>
                <Input
                  value={(value as string) ?? ''}
                  onChange={(e) => onChange(e.target.value.replace(/\s/g, ''))}
                  placeholder={t('settings.promptShortcutPlaceholder')}
                  className="flex-1"
                />
              </div>
            ),
          },
          {
            key: 'content',
            label: t('settings.promptContent'),
            type: 'textarea',
            required: true,
            rows: 12,
            placeholder: t('settings.promptContentPlaceholder'),
          },
          {
            key: 'is_global',
            label: '',
            type: 'custom',
            visible: () => isSuper,
            defaultValue: false,
            render: ({ value, onChange }) => (
              <Checkbox
                checked={!!value}
                onChange={(e) => onChange(e.target.checked)}
                label={
                  <span className="inline-flex items-center gap-2">
                    <Globe size={14} className="text-fg-muted" />
                    {t('settings.globalPromptHint')}
                  </span>
                }
              />
            ),
          },
        ],
        access: {
          canAdd: scope === 'mine',
          canEdit: scope === 'mine' || isSuper,
          canDelete: scope === 'mine' || isSuper,
          canEditRow: (prompt) => prompt.user_id === currentUser?.id || isSuper,
          canDeleteRow: (prompt) => prompt.user_id === currentUser?.id || isSuper,
        },
        deleteConfirm: (p) => ({ title: t('settings.deletePromptTitle', { name: p.title }) }),
        slots: {
          toolbar: (ctx) => (
            <div className="flex flex-wrap items-center gap-2">
              <FilterPills
                items={assetScopeItems(isSuper, {
                  mine: t('history.scopeMine'),
                  shared: t('history.scopeShared'),
                  team: t('history.scopeTeam'),
                })}
                activeKey={scope}
                onChange={(key) => setScope((key ?? 'mine') as AssetScope)}
                variant="segment"
                fill
                className="w-full sm:w-auto sm:min-w-80"
              />
              <div className="flex-1" />
              <span className="text-xs text-fg-muted whitespace-nowrap">
                {t('settings.promptCount', { count: ctx.total })}
              </span>
              {scope === 'mine' && (
                <Button size="sm" onClick={ctx.openCreate}>
                  <Plus size={14} className="mr-1" /> {t('settings.newPrompt')}
                </Button>
              )}
            </div>
          ),
          empty: (
            <EmptyState
              icon={MessageSquare}
              title={t(`assetScopes.tasksEmpty.${scope}.title`)}
              description={t(`assetScopes.tasksEmpty.${scope}.description`)}
            />
          ),
        },
      }),
    [t, isSuper, currentUser?.id, dataSource, scope],
  );

  return (
    <ModulePage moduleId="workspace.tasks" layout="list">
      <CrudPage key={scope} schema={schema} />
    </ModulePage>
  );
}
