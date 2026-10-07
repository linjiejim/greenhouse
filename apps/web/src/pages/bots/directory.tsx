/**
 * Bots directory — `#/bots/directory` (the retired `#/agents` lands here).
 *
 * The one place a member manages their Bots as identities: their own (edit,
 * open a fresh Chat session, message, submit for review), the Bots other
 * members published (chat with the published version, or clone a personal
 * copy), and — for super — the governance queue and the usage panel. It does
 * not need the `bots` feature flag: a Bot is the agent identity, the flag only
 * gates the persistent threads and the computer (spec 20261007 D5).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { isSproutyBot, type BotLifecycleStatus, type BotView } from '@greenhouse/types/bots';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  FilterPills,
  Spinner,
  Tabs,
  Tag,
  toast,
  type TagTone,
} from '../../components/ui';
import { Bot, Copy, Globe, MessageCircle, MessageSquare, Pencil, Plus } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { canUseFeature } from '../../lib/features';
import { useAuthStore } from '../../stores';
import { assetScopeItems, DEFAULT_ASSET_SCOPE, type AssetScope } from '../../lib/asset-scopes';
import { ModulePage } from '../../components/app/module-page';
import { CostValuePanel } from '../../components/agents/cost-value-panel';
import * as botsApi from '../../lib/api/bots';
import { BotAvatar, BotProfileDrawer, NewBotDialog, openBotsConversation, useBotsStore } from '../../components/bots';

const LIFECYCLE_TONE: Record<BotLifecycleStatus, TagTone> = {
  draft: 'neutral',
  review: 'warning',
  pilot: 'info',
  verified: 'success',
  rejected: 'danger',
  suspended: 'danger',
  deprecated: 'warning',
  archived: 'neutral',
};

/** The lifecycle moves the viewer may make on a Bot (owner vs super), mirroring the API's rule. */
export function lifecycleActions(status: BotLifecycleStatus, isSuper: boolean, isOwner: boolean) {
  if (isSuper && !isOwner) {
    if (status === 'review') return ['pilot', 'verified', 'rejected'] as const;
    if (status === 'pilot') return ['verified', 'suspended', 'deprecated'] as const;
    if (status === 'verified') return ['suspended', 'deprecated'] as const;
    if (status === 'suspended') return ['verified', 'deprecated'] as const;
    return [] as const;
  }
  if (!isOwner) return [] as const;
  if (status === 'draft' || status === 'rejected') return ['review'] as const;
  if (status === 'review') return ['draft'] as const;
  return [] as const;
}

/** A fresh Chat session with this Bot (by-session mode): the Chat page reads `profile`. */
export function openChatWith(botId: string): void {
  window.location.hash = `#/chat?profile=${encodeURIComponent(`bot:${botId}`)}`;
}

export function BotsDirectory() {
  const t = useT();
  const currentUser = useAuthStore((state) => state.currentUser);
  const isSuper = currentUser?.role === 'super';
  const threadsEnabled = canUseFeature(currentUser, 'bots');
  const bots = useBotsStore((state) => state.bots);
  const botsLoaded = useBotsStore((state) => state.botsLoaded);
  const loadBots = useBotsStore((state) => state.loadBots);
  const openProfile = useBotsStore((state) => state.openProfile);
  const openDialog = useBotsStore((state) => state.openDialog);
  const dialog = useBotsStore((state) => state.dialog);
  const upsertBot = useBotsStore((state) => state.upsertBot);
  const loadConversations = useBotsStore((state) => state.loadConversations);

  const [tab, setTab] = useState<'bots' | 'usage'>('bots');
  const [scope, setScope] = useState<AssetScope>(DEFAULT_ASSET_SCOPE);
  const [shared, setShared] = useState<botsApi.SharedBotView[] | null>(null);
  const [queue, setQueue] = useState<botsApi.SharedBotView[] | null>(null);
  const [lifecycleTarget, setLifecycleTarget] = useState<{ bot: BotView; status: BotLifecycleStatus } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [sharedResult, queueResult] = await Promise.all([
      botsApi.listSharedBots().catch(() => ({ bots: [] as botsApi.SharedBotView[] })),
      isSuper ? botsApi.fetchAdminBotReview().catch(() => ({ bots: [] as botsApi.SharedBotView[] })) : null,
    ]);
    setShared(sharedResult.bots);
    if (queueResult) setQueue(queueResult.bots);
  }, [isSuper]);

  useEffect(() => {
    void loadBots().catch(() => {});
    void refresh();
  }, [loadBots, refresh]);

  // The profile drawer is page-local state in the shared store: never let a
  // drawer left open on another page reappear here (or linger after leaving).
  useEffect(() => {
    openProfile(null);
    return () => openProfile(null);
  }, [openProfile]);

  const mine = useMemo(() => bots.filter((bot) => !isSproutyBot(bot)), [bots]);
  const sprouty = useMemo(() => bots.find((bot) => isSproutyBot(bot)) ?? null, [bots]);

  // `forked_from` is the source handle (`bot:<id>@<version>`); show the source's
  // name and owner when we still know it, the handle otherwise.
  const forkedFromLabel = useCallback(
    (handle: string) => {
      const match = /^bot:(bot_[0-9a-f]{16})(?:@(\d+))?$/.exec(handle);
      if (!match) return handle;
      const source = shared?.find((bot) => bot.id === match[1]) ?? bots.find((bot) => bot.id === match[1]);
      if (!source) return handle;
      const version = match[2] ? ` v${match[2]}` : '';
      const owner = 'owner_nickname' in source && source.owner_nickname ? ` · ${source.owner_nickname}` : '';
      return `${source.name}${version}${owner}`;
    },
    [bots, shared],
  );

  const runLifecycle = async () => {
    if (!lifecycleTarget) return;
    const { bot, status } = lifecycleTarget;
    setLifecycleTarget(null);
    setBusy(bot.id);
    try {
      const { bot: updated } = await botsApi.transitionBotLifecycle(bot.id, { status });
      if (updated.user_id === currentUser?.id) upsertBot(updated);
      toast(t('bots.directory.lifecycleUpdated'), 'success');
      await Promise.all([loadBots(), refresh()]);
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : t('bots.directory.lifecycleFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const clone = async (bot: BotView) => {
    setBusy(bot.id);
    try {
      const { bot: created } = await botsApi.cloneBot(bot.id);
      upsertBot(created);
      toast(t('bots.directory.cloned', { name: created.name }), 'success');
      setScope('mine');
      await loadBots();
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : t('bots.form.failed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const message = async (bot: BotView) => {
    if (bot.dm_session_id) {
      openBotsConversation(bot.dm_session_id);
      return;
    }
    try {
      const { conversation } = await botsApi.createConversation({ bot_ids: [bot.id] });
      void loadConversations().catch(() => {});
      openBotsConversation(conversation.session_id);
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : t('bots.loadFailed'), 'error');
    }
  };

  const lifecycleButtons = (bot: BotView, isOwner: boolean) =>
    lifecycleActions(bot.lifecycle_status, isSuper, isOwner).map((status) => (
      <Button
        key={status}
        size="sm"
        variant="ghost"
        disabled={busy === bot.id}
        onClick={() => setLifecycleTarget({ bot, status })}
        title={t(`bots.directory.lifecycleAction.${status}`)}
      >
        {t(`bots.directory.lifecycleAction.${status}`)}
      </Button>
    ));

  const chatButton = (bot: BotView) => (
    <Button size="sm" variant="ghost" onClick={() => openChatWith(bot.id)} title={t('bots.directory.chat')}>
      <MessageSquare size={14} className="mr-1" />
      {t('bots.directory.chat')}
    </Button>
  );

  const loading = !botsLoaded || shared === null || (isSuper && queue === null);
  const rows: BotView[] = scope === 'mine' ? mine : scope === 'shared' ? (shared ?? []) : (queue ?? []);

  return (
    <ModulePage
      moduleId="workspace.bots-directory"
      layout="list"
      actions={
        tab === 'bots' && scope === 'mine' ? (
          <Button size="sm" onClick={() => openDialog({ kind: 'new-bot' })} data-testid="bots-directory-new">
            <Plus size={14} className="mr-1" />
            {t('bots.sidebar.newBot')}
          </Button>
        ) : undefined
      }
      tabs={
        isSuper ? (
          <Tabs
            tabs={[
              { key: 'bots', label: t('bots.directory.tabs.bots') },
              { key: 'usage', label: t('bots.directory.tabs.usage') },
            ]}
            active={tab}
            onChange={(key) => setTab(key as 'bots' | 'usage')}
            ariaLabel={t('bots.directory.tabs.label')}
          />
        ) : undefined
      }
      toolbar={
        tab === 'bots' ? (
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
      {isSuper && tab === 'usage' ? (
        <CostValuePanel />
      ) : loading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4" data-testid="bots-directory">
          {scope === 'mine' && sprouty && (
            <div className="flex items-center gap-3 rounded-lg border border-edge bg-surface-raised px-4 py-3">
              <BotAvatar bot={sprouty} size="md" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg">{sprouty.name}</div>
                <div className="truncate text-xs text-fg-muted">
                  {t('bots.directory.sproutyHint', { name: sprouty.name })}
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                {chatButton(sprouty)}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openProfile(sprouty.id)}
                  title={t('bots.profile.edit')}
                >
                  <Pencil size={14} />
                </Button>
              </div>
            </div>
          )}
          {rows.length === 0 ? (
            <EmptyState
              icon={Bot}
              title={t(`bots.directory.empty.${scope}.title`)}
              description={t(`bots.directory.empty.${scope}.description`)}
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-edge bg-surface-raised">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-surface-sunken text-fg-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">{t('common.name')}</th>
                    <th className="hidden px-4 py-2 text-left font-medium md:table-cell">
                      {t('bots.directory.model')}
                    </th>
                    <th className="px-4 py-2 text-left font-medium">{t('bots.directory.lifecycle')}</th>
                    <th className="hidden px-4 py-2 text-center font-medium md:table-cell">
                      {t('bots.directory.tools')}
                    </th>
                    <th className="px-4 py-2 text-right font-medium">{t('bots.directory.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {rows.map((bot) => {
                    const isOwner = bot.user_id === currentUser?.id;
                    const version = isOwner ? bot.current_version : (bot.published_version ?? bot.current_version);
                    return (
                      <tr
                        key={bot.id}
                        className="transition-colors hover:bg-surface-sunken"
                        data-testid="bots-directory-row"
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <BotAvatar bot={bot} size="xs" />
                            <div className="min-w-0">
                              <div className="truncate font-medium text-fg-secondary" title={bot.name}>
                                {bot.name}
                                {bot.role && (
                                  <span className="ml-1.5 text-xs font-normal text-fg-faint">{bot.role}</span>
                                )}
                              </div>
                              {!isOwner && bot.owner_nickname && (
                                <div className="text-[10px] text-fg-muted">{bot.owner_nickname}</div>
                              )}
                              {bot.description && (
                                <div className="max-w-[300px] truncate text-xs text-fg-faint" title={bot.description}>
                                  {bot.description}
                                </div>
                              )}
                              {bot.forked_from && (
                                <div className="mt-0.5 text-[10px] text-primary-fg">
                                  ↳ {t('bots.directory.forkedFrom', { name: forkedFromLabel(bot.forked_from) })}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="hidden px-4 py-2.5 md:table-cell">
                          <Badge variant="secondary">{bot.model_id ?? t('bots.form.modelDefault')}</Badge>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <Tag tone={LIFECYCLE_TONE[bot.lifecycle_status]}>
                              {t(`bots.directory.lifecycleStatus.${bot.lifecycle_status}`)}
                            </Tag>
                            <span className="text-[10px] text-fg-faint">v{version}</span>
                            {bot.is_shared && <Globe size={12} className="text-primary-fg" />}
                          </div>
                        </td>
                        <td className="hidden px-4 py-2.5 text-center text-fg-muted md:table-cell">
                          {bot.tools === null ? t('bots.directory.toolsInherited') : bot.tools.length}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5">
                          <div className="flex flex-wrap items-center justify-end gap-1">
                            {lifecycleButtons(bot, isOwner)}
                            {chatButton(bot)}
                            {isOwner ? (
                              <>
                                {threadsEnabled && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => void message(bot)}
                                    title={t('bots.profile.message')}
                                  >
                                    <MessageCircle size={14} />
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => openProfile(bot.id)}
                                  title={t('bots.profile.edit')}
                                >
                                  <Pencil size={14} />
                                </Button>
                              </>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy === bot.id}
                                onClick={() => void clone(bot)}
                                title={t('bots.directory.clone')}
                              >
                                <Copy size={14} className="mr-1" />
                                {t('bots.directory.clone')}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <BotProfileDrawer onOpenDm={(bot) => void message(bot)} />
      <NewBotDialog
        open={dialog?.kind === 'new-bot'}
        onClose={() => openDialog(null)}
        onCreated={({ dmSessionId }) => {
          openDialog(null);
          void loadBots();
          if (dmSessionId && threadsEnabled) openBotsConversation(dmSessionId);
        }}
      />
      <ConfirmDialog
        open={!!lifecycleTarget}
        onClose={() => setLifecycleTarget(null)}
        onConfirm={() => void runLifecycle()}
        title={t('bots.directory.lifecycleConfirmTitle')}
        description={t('bots.directory.lifecycleConfirmDescription', {
          name: lifecycleTarget?.bot.name ?? '',
          status: lifecycleTarget ? t(`bots.directory.lifecycleStatus.${lifecycleTarget.status}`) : '',
        })}
        confirmLabel={
          lifecycleTarget ? t(`bots.directory.lifecycleAction.${lifecycleTarget.status}`) : t('common.confirm')
        }
      />
    </ModulePage>
  );
}
