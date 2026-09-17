/**
 * Agents — the one place agents are managed (v3).
 *
 * Three groups: the built-in presets (read-only, forkable), the user's own
 * agents, and agents shared by the team. An agent is its model + prompt +
 * tools + look, so all four are edited here and nowhere else; Chat only picks.
 *
 * Reached from the profile selector's manage entry, or `#/agents` directly.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Button,
  Badge,
  Tag,
  Spinner,
  ConfirmDialog,
  EmptyState,
  FilterPills,
  Tabs,
  toast,
  type TagTone,
} from '../components/ui';
import { Bot, Plus, Pencil, Trash2, Globe, GitFork } from '../lib/icons';
import { SproutyAvatar } from '../components/sprouty/index.js';
import { profileToSprouty } from '../components/chat/profile-avatar';
import * as api from '../lib/api';
import { useAuthStore, useProfileStore } from '../stores';
import { ProfileEditorDrawer } from '../components/chat/profile-editor';
import { PRESET_AGENT_IDS } from '../lib/agent-constants';
import { useLocalized, useT, type TranslationKey } from '../lib/i18n';
import { CostValuePanel } from '../components/agents/cost-value-panel';
import { assetScopeItems, DEFAULT_ASSET_SCOPE, type AssetScope } from '../lib/asset-scopes';
import { ModulePage } from '../components/app/module-page';

const BUILT_IN_PURPOSES: Record<string, TranslationKey> = {
  'sprouty-quick': 'agents.quickPurpose',
  'sprouty-deep': 'agents.deepPurpose',
  'sprouty-k3': 'agents.k3Purpose',
  'sprouty-workflows': 'agents.workflowPurpose',
};

const LIFECYCLE_TONE: Record<NonNullable<api.Profile['lifecycle_status']>, TagTone> = {
  draft: 'neutral',
  review: 'warning',
  pilot: 'info',
  verified: 'success',
  rejected: 'danger',
  suspended: 'danger',
  deprecated: 'warning',
  archived: 'neutral',
};

function lifecycleActions(profile: api.Profile, isSuper: boolean, isOwner = true) {
  const status = profile.lifecycle_status ?? 'draft';
  if (isSuper) {
    if (status === 'review') return ['pilot', 'verified', 'rejected'] as const;
    if (status === 'pilot') return ['verified', 'suspended', 'deprecated'] as const;
    if (status === 'verified') return ['suspended', 'deprecated'] as const;
    if (status === 'suspended') return ['verified', 'deprecated'] as const;
  }
  if (!isOwner) return [] as const;
  if (status === 'draft' || status === 'rejected') return ['review'] as const;
  if (status === 'review') return ['draft'] as const;
  return [] as const;
}

export function AgentsPage() {
  const t = useT();
  const localized = useLocalized();
  const { currentUser } = useAuthStore();
  const { refresh: refreshProfiles, availableTools, fetchTools: loadTools } = useProfileStore();
  const isSuper = currentUser?.role === 'super';

  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  const [systemProfiles, setSystemProfiles] = useState<api.Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'agents' | 'usage'>('agents');
  const [scope, setScope] = useState<AssetScope>(DEFAULT_ASSET_SCOPE);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<api.Profile | null>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<api.Profile | null>(null);
  const [forkTarget, setForkTarget] = useState<api.Profile | null>(null);
  const [lifecycleTarget, setLifecycleTarget] = useState<{
    profile: api.Profile;
    status: api.ProfileLifecycleStatus;
  } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [profileList, allProfiles] = await Promise.all([
        api.fetchCustomProfiles().catch(() => []),
        api.fetchProfiles().catch(() => []),
      ]);
      setProfiles(profileList || []);
      setSystemProfiles((allProfiles || []).filter((p) => !p.is_custom));
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    loadTools();
  }, [loadData, loadTools]);

  const openCreate = () => {
    setEditingProfile(null);
    setDrawerOpen(true);
  };

  const openEdit = (profile: api.Profile) => {
    setEditingProfile(profile);
    setDrawerOpen(true);
  };

  const handleSave = async (input: api.CustomProfileInput, editId?: number) => {
    if (editId !== undefined) {
      await api.updateCustomProfile(editId, input);
      toast(t('agents.updated'), 'success');
    } else {
      await api.createCustomProfile(input);
      toast(t('agents.created'), 'success');
    }
    loadData();
    refreshProfiles();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const numId = parseInt(deleteTarget.id.replace('custom:', ''), 10);
      await api.deleteCustomProfile(numId);
      toast(t('agents.deleted'), 'success');
      setDeleteTarget(null);
      loadData();
      refreshProfiles();
    } catch (err: any) {
      toast(err.message || t('agents.deleteFailed'), 'error');
    }
  };

  const handleFork = async () => {
    if (!forkTarget) return;
    const sourceId = forkTarget.id;
    setForkTarget(null);
    try {
      const forked = await api.forkProfile(sourceId);
      setEditingProfile(forked);
      setDrawerOpen(true);
      loadData();
      refreshProfiles();
    } catch (err: any) {
      toast(err.message || t('agents.forkFailed'), 'error');
    }
  };

  const handleLifecycle = async () => {
    if (!lifecycleTarget) return;
    const { profile, status } = lifecycleTarget;
    try {
      await api.transitionCustomProfileLifecycle(Number.parseInt(profile.id.replace('custom:', ''), 10), {
        status,
        ...(status === 'pilot' || status === 'verified' ? { publish_version: profile.current_version ?? 1 } : {}),
      });
      toast(t('agents.lifecycleUpdated'), 'success');
      setLifecycleTarget(null);
      await loadData();
      await refreshProfiles();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('agents.lifecycleFailed'), 'error');
    }
  };

  if (loading) {
    return (
      <ModulePage moduleId="workspace.agents" layout="list">
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      </ModulePage>
    );
  }

  const myProfiles = profiles.filter((p) => p.user_id === currentUser?.id);
  // Super receives all non-archived assets so review submissions remain
  // visible before sharing. Team users only receive reviewed shared assets.
  const sharedProfiles = profiles.filter((p) => p.user_id !== currentUser?.id && p.is_shared);
  const teamProfiles = isSuper ? profiles.filter((p) => p.user_id !== currentUser?.id && !p.is_shared) : [];
  // Every selectable preset can be forked — the hidden system ones cannot.
  const templateProfiles = systemProfiles.filter((p) => PRESET_AGENT_IDS.includes(p.id as never));
  const scopedProfiles = scope === 'mine' ? myProfiles : scope === 'shared' ? sharedProfiles : teamProfiles;
  const hasScopeContent = scopedProfiles.length > 0 || (scope === 'shared' && templateProfiles.length > 0);

  return (
    <ModulePage
      moduleId="workspace.agents"
      layout="list"
      actions={
        activeTab === 'agents' && scope === 'mine' ? (
          <Button onClick={openCreate} size="sm">
            <Plus size={14} className="mr-1" />
            {t('agents.create')}
          </Button>
        ) : undefined
      }
      tabs={
        isSuper ? (
          <Tabs
            tabs={[
              { key: 'agents', label: t('agents.tabs.agents') },
              { key: 'usage', label: t('agents.tabs.usage') },
            ]}
            active={activeTab}
            onChange={(key) => setActiveTab(key as 'agents' | 'usage')}
            ariaLabel={t('agents.tabs.label')}
          />
        ) : undefined
      }
      toolbar={
        activeTab === 'agents' ? (
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
        ) : undefined
      }
    >
      {isSuper && activeTab === 'usage' ? (
        <CostValuePanel />
      ) : (
        <>
          {/* Fork from System Profile */}
          {scope === 'shared' && templateProfiles.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-fg-muted mb-2 uppercase tracking-wider">
                {t('agents.builtInPresets')}
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {templateProfiles.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setForkTarget(p)}
                    className="group flex min-h-20 items-start gap-3 rounded-lg border border-edge bg-surface-raised px-3 py-3 text-left transition-colors hover:border-primary-edge hover:bg-primary-subtle/30"
                  >
                    <SproutyAvatar {...profileToSprouty(p)} state="idle" size="sm" animate={false} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-fg-secondary">
                        {localized(p.name_i18n, p.name)}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-fg-muted">
                        {BUILT_IN_PURPOSES[p.id]
                          ? t(BUILT_IN_PURPOSES[p.id])
                          : localized(p.description_i18n, p.description ?? '') || t('agents.defaultPurpose')}
                      </div>
                      <div className="mt-1 text-[10px] text-fg-faint">
                        {p.model_id ?? 'flash'} · {t('agents.toolsCount', { count: p.tools.length })}
                      </div>
                    </div>
                    <GitFork
                      size={13}
                      className="text-fg-faint group-hover:text-primary-fg flex-shrink-0 transition-colors"
                    />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* My Agents */}
          {!hasScopeContent ? (
            <EmptyState
              icon={Bot}
              title={t(`assetScopes.agentsEmpty.${scope}.title`)}
              description={t(`assetScopes.agentsEmpty.${scope}.description`)}
            />
          ) : (
            <>
              {scope === 'mine' && myProfiles.length > 0 && (
                <div className="bg-surface-raised border border-edge rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-sunken text-fg-muted">
                      <tr>
                        <th className="text-left px-4 py-2 font-medium">{t('common.name')}</th>
                        <th className="text-left px-4 py-2 font-medium hidden md:table-cell">{t('agents.model')}</th>
                        <th className="text-left px-4 py-2 font-medium">{t('agents.lifecycle')}</th>
                        <th className="text-center px-4 py-2 font-medium">{t('agents.tools')}</th>
                        <th className="text-center px-4 py-2 font-medium hidden lg:table-cell">{t('agents.calls')}</th>
                        <th className="text-center px-4 py-2 font-medium hidden md:table-cell">{t('agents.shared')}</th>
                        <th className="text-center px-4 py-2 font-medium w-20">{t('agents.actions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-edge">
                      {myProfiles.map((p) => (
                        <tr key={p.id} className="hover:bg-surface-sunken transition-colors">
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <SproutyAvatar
                                variant="custom"
                                color={p.avatar?.color}
                                accessories={p.avatar?.accessories}
                                leafStyle={p.avatar?.leafStyle}
                                eyeStyle={p.avatar?.eyeStyle}
                                state="idle"
                                size="xs"
                                animate={false}
                              />
                              <div className="min-w-0">
                                <div className="font-medium text-fg-secondary truncate" title={p.name}>
                                  {p.name}
                                </div>
                                {p.description && (
                                  <div className="text-xs text-fg-faint truncate max-w-[300px]" title={p.description}>
                                    {p.description}
                                  </div>
                                )}
                                {p.forked_from && (
                                  <div className="text-[10px] text-primary-fg mt-0.5">
                                    ↳ {t('agents.forkedFrom', { name: p.forked_from })}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-2.5 hidden md:table-cell">
                            <Badge variant="secondary">{p.model_id ?? 'flash'}</Badge>
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1.5">
                              <Tag tone={LIFECYCLE_TONE[p.lifecycle_status ?? 'draft']}>
                                {t(`agents.lifecycleStatus.${p.lifecycle_status ?? 'draft'}`)}
                              </Tag>
                              <span className="text-[10px] text-fg-faint">v{p.current_version ?? 1}</span>
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-center text-fg-muted">{p.tools.length}</td>
                          <td className="px-4 py-2.5 text-center text-fg-faint hidden lg:table-cell">
                            {p.usage?.total_calls || '—'}
                          </td>
                          <td className="px-4 py-2.5 text-center hidden md:table-cell">
                            {p.is_shared && <Globe size={14} className="inline text-primary-fg" />}
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <div className="flex items-center justify-center gap-1">
                              {lifecycleActions(p, isSuper).map((status) => (
                                <Button
                                  key={status}
                                  size="sm"
                                  variant="ghost"
                                  className="shrink-0 whitespace-nowrap"
                                  onClick={() => setLifecycleTarget({ profile: p, status })}
                                  title={t(`agents.lifecycleAction.${status}`)}
                                >
                                  {t(`agents.lifecycleAction.${status}`)}
                                </Button>
                              ))}
                              <button
                                onClick={() => openEdit(p)}
                                className="p-1 text-fg-muted hover:text-primary-fg rounded transition-colors"
                                title={t('common.edit')}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                onClick={() => setDeleteTarget(p)}
                                className="p-1 text-fg-muted hover:text-danger rounded transition-colors"
                                title={t('common.delete')}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Shared by others */}
              {scope !== 'mine' && scopedProfiles.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-fg-muted mb-2 uppercase tracking-wider">
                    {t(scope === 'team' ? 'agents.teamAgents' : 'agents.sharedAgents')}
                  </h3>
                  <div className="bg-surface-raised border border-edge rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <tbody className="divide-y divide-edge">
                        {scopedProfiles.map((p) => (
                          <tr key={p.id} className="hover:bg-surface-sunken transition-colors">
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                {scope === 'shared' ? (
                                  <Globe size={14} className="text-primary-fg flex-shrink-0" />
                                ) : (
                                  <Bot size={14} className="text-fg-muted flex-shrink-0" />
                                )}
                                <div className="min-w-0">
                                  <div className="font-medium text-fg-secondary truncate" title={p.name}>
                                    {p.name}
                                  </div>
                                  {p.owner_nickname && (
                                    <div className="text-[10px] text-fg-muted">{p.owner_nickname}</div>
                                  )}
                                  {p.description && (
                                    <div className="text-xs text-fg-faint truncate max-w-[300px]" title={p.description}>
                                      {p.description}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-2.5 hidden md:table-cell">
                              <Badge variant="secondary">{p.model_id ?? 'flash'}</Badge>
                            </td>
                            <td className="px-4 py-2.5">
                              <Tag tone={LIFECYCLE_TONE[p.lifecycle_status ?? 'draft']}>
                                {t(`agents.lifecycleStatus.${p.lifecycle_status ?? 'draft'}`)} · v
                                {p.published_version ?? p.current_version ?? 1}
                              </Tag>
                            </td>
                            <td className="px-4 py-2.5 text-center text-fg-muted">
                              {t('agents.toolsCount', { count: p.tools.length })}
                            </td>
                            {isSuper && (
                              <td className="px-4 py-2.5">
                                <div className="flex flex-wrap items-center justify-end gap-1">
                                  {lifecycleActions(p, true, false).map((status) => (
                                    <Button
                                      key={status}
                                      size="sm"
                                      variant="ghost"
                                      className="shrink-0 whitespace-nowrap"
                                      onClick={() => setLifecycleTarget({ profile: p, status })}
                                    >
                                      {t(`agents.lifecycleAction.${status}`)}
                                    </Button>
                                  ))}
                                </div>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Agent Editor */}
      <ProfileEditorDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        profile={editingProfile}
        availableTools={availableTools}
        isSuper={isSuper}
        onSave={handleSave}
      />

      {/* Fork Confirmation */}
      <ConfirmDialog
        open={!!forkTarget}
        onClose={() => setForkTarget(null)}
        onConfirm={handleFork}
        title={t('agents.forkTitle')}
        description={t('agents.forkDescription', {
          name: forkTarget ? localized(forkTarget.name_i18n, forkTarget.name) : '',
        })}
        confirmLabel={t('agents.forkAndEdit')}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!lifecycleTarget}
        onClose={() => setLifecycleTarget(null)}
        onConfirm={handleLifecycle}
        title={t('agents.lifecycleConfirmTitle')}
        description={t('agents.lifecycleConfirmDescription', {
          name: lifecycleTarget?.profile.name ?? '',
          status: lifecycleTarget ? t(`agents.lifecycleStatus.${lifecycleTarget.status}`) : '',
        })}
        confirmLabel={lifecycleTarget ? t(`agents.lifecycleAction.${lifecycleTarget.status}`) : t('common.confirm')}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={t('agents.deleteTitle')}
        description={t('agents.deleteDescription', { name: deleteTarget?.name ?? '' })}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </ModulePage>
  );
}
