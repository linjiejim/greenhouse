/**
 * My Profiles — Settings sub-page for managing custom Agent profiles.
 *
 * Migrated onto @greenhouse/crud: the list table, Add/Edit dialog, delete-confirm,
 * toolbar and empty state all come from one `defineCrud` schema. The bespoke
 * ProfileEditorDrawer (avatar picker, grouped tool picker, capabilities editor,
 * prompt fullscreen) is intentionally sacrificed for the uniform CRUD dialog.
 *
 * Available to all internal users. Super users can mark profiles as shared.
 * "Fork from Template" rides slots.banner so a fork can reload + open the edit
 * dialog on the new row.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { defineCrud, CrudPage, type CrudDataSource, type CrudActionContext } from '@greenhouse/crud';
import { Badge } from '../../components/ui';
import { Globe, GitFork, Bot } from '../../lib/icons';
import { SproutyFace } from '../../components/sprouty/index.js';
import { profileToSprouty, isSpecialistProfile } from '../../components/chat/profile-selector';
import * as api from '../../lib/api';
import { useAuthStore, useProfileStore } from '../../stores';

const MAX_PROMPT_CHARS = 8000;

// Row is api.Profile, widened with three form-only knobs flattened from/into
// model_options so they can be flat dialog fields (the edit dialog seeds from
// the in-memory row, so the flattened keys must live on the row).
type ProfileRow = api.Profile & {
  model_thinking?: '' | 'on' | 'off';
  model_temperature?: number | null;
  model_max_tokens?: number | null;
};

/** Flatten model_options onto the row so the dialog's model fields seed correctly. */
function flattenRow(p: api.Profile): ProfileRow {
  return {
    ...p,
    model_thinking: p.model_options?.thinking === undefined ? '' : p.model_options.thinking ? 'on' : 'off',
    model_temperature: p.model_options?.temperature ?? null,
    model_max_tokens: p.model_options?.max_tokens ?? null,
  };
}

/** Reassemble CustomProfileInput from the flat dialog payload. */
function buildInput(data: Record<string, unknown>, includeShared: boolean): api.CustomProfileInput {
  const modelOptions: { thinking?: boolean; temperature?: number; max_tokens?: number } = {};
  const thinking = data.model_thinking;
  if (thinking === 'on' || thinking === 'off') modelOptions.thinking = thinking === 'on';
  const temp = data.model_temperature;
  if (temp !== '' && temp !== null && temp !== undefined && !Number.isNaN(Number(temp))) {
    modelOptions.temperature = Number(temp);
  }
  const maxTok = data.model_max_tokens;
  if (maxTok !== '' && maxTok !== null && maxTok !== undefined && !Number.isNaN(Number(maxTok))) {
    modelOptions.max_tokens = Number(maxTok);
  }

  const followups = Array.isArray(data.suggested_followups)
    ? (data.suggested_followups as unknown[])
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 4)
    : [];

  const trimOrUndef = (v: unknown): string | undefined => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s || undefined;
  };

  const input: api.CustomProfileInput = {
    name: String(data.name ?? '').trim(),
    description: trimOrUndef(data.description),
    base_profile_id: String(data.base_profile_id || 'default'),
    tools: Array.isArray(data.tools) ? (data.tools as string[]) : [],
    system_prompt: String(data.system_prompt ?? '').trim(),
    max_steps: data.max_steps !== '' && data.max_steps != null ? Number(data.max_steps) : undefined,
    model_options: Object.keys(modelOptions).length ? modelOptions : undefined,
    default_language: trimOrUndef(data.default_language),
    greeting: trimOrUndef(data.greeting),
    suggested_followups: followups.length ? followups : undefined,
  };
  // Only super users may toggle sharing; omit the key otherwise so a non-super
  // edit can't wipe an existing is_shared flag.
  if (includeShared) input.is_shared = Boolean(data.is_shared);
  return input;
}

export function MyProfilesPage() {
  const { currentUser } = useAuthStore();
  const { refresh: refreshProfiles } = useProfileStore();
  const isSuper = currentUser?.role === 'super';
  const myId = currentUser?.id;

  // System (non-custom) profiles for the "Fork from Template" banner.
  const [systemProfiles, setSystemProfiles] = useState<api.Profile[]>([]);
  useEffect(() => {
    api
      .fetchProfiles()
      .then((all) => setSystemProfiles(all.filter((p) => !p.is_custom)))
      .catch(() => setSystemProfiles([]));
  }, []);

  const dataSource = useMemo<CrudDataSource<ProfileRow>>(
    () => ({
      async list() {
        const all = await api.fetchCustomProfiles();
        // MUST filter to the current user's own rows: fetchCustomProfiles also
        // returns other users' shared profiles, which are not editable/deletable.
        const items = all.filter((p) => p.user_id === myId).map(flattenRow);
        return { items, total: items.length };
      },
      // No get(): no detail view; the edit dialog seeds from the in-memory row.
      create: async (data) => {
        const r = await api.createCustomProfile(buildInput(data, isSuper));
        await refreshProfiles();
        return r;
      },
      update: async (id, data) => {
        const numId = parseInt(id.replace('custom:', ''), 10);
        const r = await api.updateCustomProfile(numId, buildInput(data, isSuper));
        await refreshProfiles();
        return r;
      },
      remove: async (id) => {
        const numId = parseInt(id.replace('custom:', ''), 10);
        await api.deleteCustomProfile(numId);
        await refreshProfiles();
      },
    }),
    [myId, isSuper, refreshProfiles],
  );

  const schema = useMemo(
    () =>
      defineCrud<ProfileRow>({
        name: 'agent',
        icon: Bot,
        idField: 'id',
        dataSource,
        storageKey: 'my-profiles',
        emptyMessage: 'No custom agents yet — create one or fork a template above.',
        formMode: 'dialog',
        formTitle: (mode) => (mode === 'add' ? 'Create agent' : 'Edit agent'),
        columns: [
          {
            key: 'name',
            label: 'Name',
            type: 'custom',
            render: (row) => (
              <div className="flex items-center gap-2">
                <SproutyFace {...profileToSprouty(row)} state="idle" size="xs" animate={false} />
                <div className="min-w-0">
                  <div className="font-medium text-fg-secondary truncate" title={row.name}>
                    {row.name}
                  </div>
                  {row.description && (
                    <div className="text-xs text-fg-faint truncate max-w-[300px]" title={row.description}>
                      {row.description}
                    </div>
                  )}
                  {row.forked_from && (
                    <div className="text-[10px] text-primary-fg mt-0.5">↳ from {row.forked_from}</div>
                  )}
                </div>
              </div>
            ),
          },
          {
            key: 'base_profile_id',
            label: 'Base',
            type: 'custom',
            responsiveHide: 'md',
            render: (row) => <Badge variant="secondary">{row.base_profile_id || 'default'}</Badge>,
          },
          {
            key: 'tools',
            label: 'Tools',
            type: 'custom',
            align: 'center',
            render: (row) => <span className="text-fg-muted">{row.tools.length}</span>,
          },
          {
            key: 'usage',
            label: 'Calls',
            type: 'custom',
            align: 'center',
            responsiveHide: 'lg',
            render: (row) => <span className="text-fg-faint">{row.usage?.total_calls || '—'}</span>,
          },
          {
            key: 'is_shared',
            label: 'Shared',
            type: 'custom',
            align: 'center',
            responsiveHide: 'md',
            render: (row) => (row.is_shared ? <Globe size={14} className="inline text-primary-fg" /> : null),
          },
        ],
        formFields: [
          { key: 'name', label: 'Name', type: 'text', width: 4, required: true },
          { key: 'description', label: 'Description', type: 'textarea', rows: 2, width: 4 },
          {
            key: 'base_profile_id',
            label: 'Base Profile',
            type: 'select',
            width: 4,
            required: true,
            defaultValue: 'default',
            options: async () =>
              (await api.fetchProfiles()).filter((p) => !p.is_custom).map((p) => ({ value: p.id, label: p.name })),
          },
          {
            key: 'tools',
            label: 'Tools',
            type: 'multi-select',
            width: 4,
            options: async () => (await api.fetchTools()).map((tool) => ({ value: tool.id, label: tool.name })),
          },
          {
            key: 'system_prompt',
            label: 'System Prompt',
            type: 'textarea',
            rows: 10,
            width: 4,
            required: true,
            rules: [
              {
                validate: (v) => (String(v ?? '').length > MAX_PROMPT_CHARS ? `Max ${MAX_PROMPT_CHARS} chars` : null),
              },
            ],
          },
          { key: 'max_steps', label: 'Max Steps', type: 'number', width: 2, min: 1, max: 20, defaultValue: 12 },
          {
            key: 'model_thinking',
            label: 'Thinking',
            type: 'select',
            width: 2,
            options: [
              { value: '', label: 'Inherit' },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ],
          },
          { key: 'model_temperature', label: 'Temperature', type: 'number', width: 2 },
          { key: 'model_max_tokens', label: 'Max tokens', type: 'number', width: 2 },
          { key: 'default_language', label: 'Default language', type: 'text', width: 4 },
          { key: 'greeting', label: 'Greeting', type: 'textarea', rows: 2, width: 4 },
          { key: 'suggested_followups', label: 'Suggested follow-ups', type: 'tags', width: 4 },
          ...(isSuper
            ? [
                {
                  key: 'is_shared' as const,
                  label: 'Share with all internal users',
                  type: 'switch' as const,
                  width: 4 as const,
                },
              ]
            : []),
        ],
        access: { canView: false, canAdd: true, canEdit: true, canDelete: true },
        slots: {
          banner: (ctx) => <ForkBanner systemProfiles={systemProfiles} ctx={ctx} refreshProfiles={refreshProfiles} />,
        },
      }),
    [dataSource, isSuper, systemProfiles, refreshProfiles],
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted max-w-2xl">
        Custom agents with your own system prompts and tool configurations.
      </p>
      <CrudPage schema={schema} />
    </div>
  );
}

/** "Fork from Template" grid — forks a system profile, reloads, opens edit dialog. */
function ForkBanner({
  systemProfiles,
  ctx,
  refreshProfiles,
}: {
  systemProfiles: api.Profile[];
  ctx: CrudActionContext;
  refreshProfiles: () => Promise<void>;
}) {
  const templates = systemProfiles.filter((p) => isSpecialistProfile(p) || p.id === 'team');
  if (templates.length === 0) return null;

  const handleFork = async (sourceId: string) => {
    const forked = await api.forkProfile(sourceId);
    await refreshProfiles();
    ctx.reload();
    ctx.openEdit(flattenRow(forked) as unknown as Record<string, unknown>);
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-fg-muted mb-2 uppercase tracking-wider">Fork from Template</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {templates.map((p) => (
          <button
            key={p.id}
            onClick={() => handleFork(p.id)}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-edge bg-surface-raised hover:border-primary-edge hover:bg-primary-subtle/30 transition-colors text-left group"
          >
            <SproutyFace {...profileToSprouty(p)} state="idle" size="xs" animate={false} />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-fg-secondary truncate">{p.name}</div>
              <div className="text-[10px] text-fg-faint">{p.tools.length} tools</div>
            </div>
            <GitFork size={13} className="text-fg-faint group-hover:text-primary-fg flex-shrink-0 transition-colors" />
          </button>
        ))}
      </div>
    </div>
  );
}
