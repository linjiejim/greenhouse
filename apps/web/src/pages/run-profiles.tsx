/**
 * Run profiles (执行配置) — the "Run profiles" tab of Automations
 * (`#/automations?tab=profiles`): a model + instructions + tools + look that an
 * automation (or a chat) runs as. Reached from the profile selector's manage
 * entry; the old `#/agents` page redirects here. Before 1.5 these were "My
 * Agents"; the data is the same custom profiles.
 *
 * Three groups behind the toolbar's scope switch: your own, the ones shared
 * with the team (plus the built-in presets you can copy), and — for a super —
 * members' private ones. A run profile is private to its owner unless it is
 * available to the team (`is_shared`); only a super switches that, from any row
 * they can see, and owners get a one-line hint to ask an admin.
 *
 * One tab row, the page's: a super's usage report is a toolbar button that
 * swaps the list for the report, not a second tab bar.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, Badge, Tag, Spinner, ConfirmDialog, EmptyState, FilterPills, Toggle, toast } from '../components/ui';
import { ArrowLeft, BarChart3, Bot, Plus, Pencil, Trash2, Globe, GitFork } from '../lib/icons';
import { SproutyAvatar } from '../components/sprouty/index.js';
import { profileToSprouty } from '../components/chat/profile-selector';
import * as api from '../lib/api';
import { useAuthStore, useProfileStore } from '../stores';
import { ProfileEditorDrawer } from '../components/chat/profile-editor';
import { PRESET_AGENT_IDS } from '../lib/agent-constants';
import { useLocalized, useT } from '../lib/i18n';
import { CostValuePanel } from '../components/agents/cost-value-panel';
import { assetScopeItems, DEFAULT_ASSET_SCOPE, type AssetScope } from '../lib/asset-scopes';
import { ModulePage } from '../components/app/module-page';

export function RunProfilesPanel({ sectionTabs }: { sectionTabs?: React.ReactNode }) {
  const t = useT();
  const localized = useLocalized();
  const { currentUser } = useAuthStore();
  const { refresh: refreshProfiles, availableTools, fetchTools: loadTools } = useProfileStore();
  const isSuper = currentUser?.role === 'super';

  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  const [systemProfiles, setSystemProfiles] = useState<api.Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'profiles' | 'usage'>('profiles');
  const [scope, setScope] = useState<AssetScope>(DEFAULT_ASSET_SCOPE);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<api.Profile | null>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<api.Profile | null>(null);
  const [forkTarget, setForkTarget] = useState<api.Profile | null>(null);
  const [sharingIds, setSharingIds] = useState<Set<string>>(() => new Set());

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

  /** Super only: switch whether an agent is available to the whole team. */
  const handleShareToggle = async (profile: api.Profile, next: boolean) => {
    if (sharingIds.has(profile.id)) return;
    setSharingIds((ids) => new Set(ids).add(profile.id));
    try {
      await api.setCustomProfileSharing(Number.parseInt(profile.id.replace('custom:', ''), 10), next);
      toast(t('agents.sharingUpdated'), 'success');
      await loadData();
      await refreshProfiles();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('agents.sharingFailed'), 'error');
    } finally {
      setSharingIds((ids) => {
        const rest = new Set(ids);
        rest.delete(profile.id);
        return rest;
      });
    }
  };

  const shareToggle = (p: api.Profile) => (
    <Toggle
      size="sm"
      checked={p.is_shared === true}
      disabled={sharingIds.has(p.id)}
      label={t('agents.shareToggle')}
      onChange={(next) => void handleShareToggle(p, next)}
    />
  );

  const myProfiles = profiles.filter((p) => p.user_id === currentUser?.id);
  // Super receives every member's agents (that is where team availability is
  // switched); everyone else receives their own plus the team-shared ones.
  const sharedProfiles = profiles.filter((p) => p.user_id !== currentUser?.id && p.is_shared);
  const teamProfiles = isSuper ? profiles.filter((p) => p.user_id !== currentUser?.id && !p.is_shared) : [];
  // Every selectable preset can be forked — the hidden system ones cannot.
  const templateProfiles = systemProfiles.filter((p) => PRESET_AGENT_IDS.includes(p.id as never));
  const scopedProfiles = scope === 'mine' ? myProfiles : scope === 'shared' ? sharedProfiles : teamProfiles;
  const hasScopeContent = scopedProfiles.length > 0 || (scope === 'shared' && templateProfiles.length > 0);

  const showUsage = isSuper && view === 'usage';

  return (
    <ModulePage moduleId="workspace.automations" layout="list" tabs={sectionTabs} contentClassName="space-y-4">
      {/* The toolbar opens the content, as in the sibling Automations tab, so
          switching tabs moves nothing. */}
      {showUsage ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setView('profiles')}>
            <ArrowLeft size={14} />
            {t('agents.backToProfiles')}
          </Button>
        </div>
      ) : (
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
            {t('agents.count', { count: scopedProfiles.length })}
          </span>
          {isSuper && (
            <Button variant="outline" size="sm" onClick={() => setView('usage')}>
              <BarChart3 size={14} />
              {t('agents.usageDetails')}
            </Button>
          )}
          {scope === 'mine' && (
            <Button onClick={openCreate} size="sm">
              <Plus size={14} />
              {t('agents.create')}
            </Button>
          )}
        </div>
      )}
      {showUsage ? (
        <CostValuePanel />
      ) : loading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
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
                        {localized(p.description_i18n, p.description ?? '') || t('agents.defaultPurpose')}
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

          {/* Your run profiles */}
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
                        <th className="text-left px-4 py-2 font-medium">{t('agents.version')}</th>
                        <th className="text-center px-4 py-2 font-medium">{t('agents.tools')}</th>
                        <th className="text-center px-4 py-2 font-medium hidden lg:table-cell">{t('agents.calls')}</th>
                        {/* Visible on phones: it is the only place to share or unshare a run profile. */}
                        <th className="text-center px-4 py-2 font-medium">{t('agents.shared')}</th>
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
                            <Tag tone="neutral">v{p.current_version ?? 1}</Tag>
                          </td>
                          <td className="px-4 py-2.5 text-center text-fg-muted">{p.tools.length}</td>
                          <td className="px-4 py-2.5 text-center text-fg-faint hidden lg:table-cell">
                            {p.usage?.total_calls || '—'}
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            {isSuper
                              ? shareToggle(p)
                              : p.is_shared && (
                                  <Globe
                                    size={14}
                                    className="inline text-primary-fg"
                                    role="img"
                                    aria-label={t('agents.shareToggle')}
                                  />
                                )}
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <div className="flex items-center justify-center gap-1">
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
              {scope === 'mine' && myProfiles.length > 0 && !isSuper && (
                <p className="text-xs text-fg-muted">{t('agents.shareHint')}</p>
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
                              <Tag tone="neutral">v{p.current_version ?? 1}</Tag>
                            </td>
                            <td className="px-4 py-2.5 text-center text-fg-muted">
                              {t('agents.toolsCount', { count: p.tools.length })}
                            </td>
                            {isSuper && (
                              <td className="px-4 py-2.5">
                                <div className="flex items-center justify-end gap-2 text-xs text-fg-muted">
                                  <span className="hidden sm:inline">{t('agents.shareToggle')}</span>
                                  {shareToggle(p)}
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

      {/* Run profile editor */}
      <ProfileEditorDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        profile={editingProfile}
        availableTools={availableTools}
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
