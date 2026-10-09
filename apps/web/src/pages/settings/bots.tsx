/**
 * Settings → My Bots — the Bots a member created, as identities: edit (the
 * profile drawer), open a fresh Chat session, message (where Bots threads are
 * enabled) and see the archived ones. Bots are private; there is nothing to
 * share, review or clone. The page does not need the `bots` feature flag: a
 * Bot is the agent identity, the flag only gates the persistent threads and
 * the computer (spec 20261007 D5).
 */

import { useEffect, useMemo } from 'react';
import { isSproutyBot, type BotView } from '@greenhouse/types/bots';
import { Badge, Button, EmptyState, Spinner, toast } from '../../components/ui';
import { Bot, MessageCircle, MessageSquare, Pencil, Plus } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { canUseFeature } from '../../lib/features';
import { formatDay } from '../../lib/utils';
import { useAuthStore } from '../../stores';
import { ModulePage } from '../../components/app/module-page';
import * as botsApi from '../../lib/api/bots';
import { BotAvatar, BotsDialogs, openBotsConversation, openChatWith, useBotsStore } from '../../components/bots';

export function BotsPanel() {
  const t = useT();
  const currentUser = useAuthStore((state) => state.currentUser);
  const threadsEnabled = canUseFeature(currentUser, 'bots');
  const bots = useBotsStore((state) => state.bots);
  const archived = useBotsStore((state) => state.archivedBots);
  const botsLoaded = useBotsStore((state) => state.botsLoaded);
  const loadBots = useBotsStore((state) => state.loadBots);
  const loadConversations = useBotsStore((state) => state.loadConversations);
  const openProfile = useBotsStore((state) => state.openProfile);
  const openDialog = useBotsStore((state) => state.openDialog);

  useEffect(() => {
    void loadBots().catch(() => {});
  }, [loadBots]);

  const mine = useMemo(() => bots.filter((bot) => !isSproutyBot(bot)), [bots]);
  const sprouty = useMemo(() => bots.find((bot) => isSproutyBot(bot)) ?? null, [bots]);

  const message = async (bot: BotView) => {
    if (bot.dm_session_id) {
      openBotsConversation(bot.dm_session_id);
      return;
    }
    try {
      const { conversation } = await botsApi.createConversation(bot.id);
      void loadConversations().catch(() => {});
      openBotsConversation(conversation.session_id);
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : t('bots.loadFailed'), 'error');
    }
  };

  const actions = (bot: BotView) => (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <Button size="sm" variant="ghost" onClick={() => openChatWith(bot.id)} title={t('bots.manage.chat')}>
        <MessageSquare size={14} className="mr-1" />
        {t('bots.manage.chat')}
      </Button>
      {threadsEnabled && (
        <Button size="sm" variant="ghost" onClick={() => void message(bot)} title={t('bots.profile.message')}>
          <MessageCircle size={14} />
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => openProfile(bot.id)} title={t('bots.profile.edit')}>
        <Pencil size={14} />
      </Button>
    </div>
  );

  return (
    <ModulePage
      moduleId="settings.bots"
      layout="list"
      actions={
        <Button size="sm" onClick={() => openDialog({ kind: 'new-bot' })} data-testid="bots-manage-new">
          <Plus size={14} className="mr-1" />
          {t('bots.sidebar.newBot')}
        </Button>
      }
    >
      {!botsLoaded ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4" data-testid="bots-manage">
          {sprouty && (
            <div className="flex items-center gap-3 rounded-lg border border-edge bg-surface-raised px-4 py-3">
              <BotAvatar bot={sprouty} size="md" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg">{sprouty.name}</div>
                <div className="truncate text-xs text-fg-muted">
                  {t('bots.manage.sproutyHint', { name: sprouty.name })}
                </div>
              </div>
              {actions(sprouty)}
            </div>
          )}

          {mine.length === 0 ? (
            <EmptyState
              icon={Bot}
              title={t('bots.manage.empty.title')}
              description={t('bots.manage.empty.description')}
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-edge bg-surface-raised">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-surface-sunken text-fg-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">{t('common.name')}</th>
                    <th className="hidden px-4 py-2 text-left font-medium md:table-cell">{t('bots.manage.model')}</th>
                    <th className="px-4 py-2 text-left font-medium">{t('bots.manage.version')}</th>
                    <th className="hidden px-4 py-2 text-center font-medium md:table-cell">{t('bots.manage.tools')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('bots.manage.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {mine.map((bot) => (
                    <tr
                      key={bot.id}
                      className="transition-colors hover:bg-surface-sunken"
                      data-testid="bots-manage-row"
                    >
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <BotAvatar bot={bot} size="xs" />
                          <div className="min-w-0">
                            <div className="truncate font-medium text-fg-secondary" title={bot.name}>
                              {bot.name}
                              {bot.role && <span className="ml-1.5 text-xs font-normal text-fg-faint">{bot.role}</span>}
                            </div>
                            {bot.description && (
                              <div className="max-w-[300px] truncate text-xs text-fg-faint" title={bot.description}>
                                {bot.description}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="hidden px-4 py-2.5 md:table-cell">
                        <Badge variant="secondary">{bot.model_id ?? t('bots.form.modelDefault')}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-fg-muted">v{bot.current_version}</td>
                      <td className="hidden px-4 py-2.5 text-center text-fg-muted md:table-cell">
                        {bot.tools === null ? t('bots.manage.toolsInherited') : bot.tools.length}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">{actions(bot)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {archived.length > 0 && (
            <section data-testid="bots-manage-archived">
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-faint">
                {t('bots.manage.archivedTitle', { count: archived.length })}
              </h3>
              <ul className="divide-y divide-edge rounded-lg border border-edge bg-surface-raised">
                {archived.map((bot) => (
                  <li key={bot.id} className="flex items-center gap-2 px-4 py-2 text-sm text-fg-muted">
                    <BotAvatar bot={bot} size="xs" />
                    <span className="truncate">{bot.name}</span>
                    {bot.role && <span className="truncate text-xs text-fg-faint">{bot.role}</span>}
                    <span className="ml-auto flex-shrink-0 text-[11px] text-fg-faint">
                      {t('bots.manage.archivedOn', { date: formatDay(bot.updated_at) })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      <BotsDialogs threadsEnabled={threadsEnabled} />
    </ModulePage>
  );
}
