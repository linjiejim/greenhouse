/**
 * Bots contextual sidebar: the Bot avatar strip (one tap → that Bot's DM) and
 * ONE conversation list sorted by activity — DMs show the Bot's face, groups
 * a stacked roster, and each row carries at most one signal, by priority:
 * needs you > unread > working. There is no session list and no "new chat":
 * a Bot's DM is permanent, groups are made explicitly.
 */

import { useEffect, useMemo, useState } from 'react';
import type { BotConversationSummary, BotView } from '@greenhouse/types/bots';
import { Button, IconButton, Skeleton, StatusDot, Tag, toast } from '../ui';
import { Plus, Users } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { relativeTime } from '../../lib/utils';
import * as botsApi from '../../lib/api/bots';
import { conversationReplyable, useBotDirectory, useBotsLoadState, useBotsStore } from './bots-store';
import { BotAvatar, BotAvatarStack } from './bot-avatar';
import { conversationTitle, openBotsConversation, useCurrentBotsConversation } from './navigation';

export function BotsSidebarPanel({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const bots = useBotsStore((state) => state.bots);
  const conversations = useBotsStore((state) => state.conversations);
  const botsState = useBotsLoadState();
  // Rows name their Bots: until the Bot list is in, every row would read
  // "Deleted Bot" for a moment — show skeletons instead (or the failure).
  const loaded = useBotsStore((state) => state.conversationsLoaded) && botsState === 'ready';
  const loadBots = useBotsStore((state) => state.loadBots);
  const loadConversations = useBotsStore((state) => state.loadConversations);
  const openDialog = useBotsStore((state) => state.openDialog);
  const current = useCurrentBotsConversation();
  const lookup = useBotDirectory();
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    void loadBots().catch(() => {});
    void loadConversations().catch(() => {});
  }, [loadBots, loadConversations]);

  // Conversations nobody can answer any more (their Bots were archived) stay
  // readable, but sink below the live ones under their own label.
  const [live, archived] = useMemo(() => {
    const activeIds = new Set(bots.map((bot) => bot.id));
    const open: BotConversationSummary[] = [];
    const closed: BotConversationSummary[] = [];
    for (const conversation of conversations) {
      (conversationReplyable(conversation, activeIds) ? open : closed).push(conversation);
    }
    return [open, closed];
  }, [bots, conversations]);

  const attentionByBot = useMemo(() => {
    const map = new Map<string, BotConversationSummary['attention']>();
    for (const conversation of conversations) {
      if (conversation.kind === 'direct' && conversation.owner_bot_id) {
        map.set(conversation.owner_bot_id, conversation.attention);
      }
    }
    return map;
  }, [conversations]);

  const go = (sessionId: string) => {
    openBotsConversation(sessionId);
    onNavigate?.();
  };

  const openDm = async (bot: BotView) => {
    if (bot.dm_session_id) {
      go(bot.dm_session_id);
      return;
    }
    setOpening(bot.id);
    try {
      const { conversation } = await botsApi.createConversation({ bot_ids: [bot.id] });
      go(conversation.session_id);
      void loadConversations().catch(() => {});
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : t('bots.loadFailed'), 'error');
    } finally {
      setOpening(null);
    }
  };

  const titleCopy = {
    unknownBot: t('bots.deletedBot'),
    group: t('bots.sidebar.group'),
    archived: (name: string) => t('bots.archivedName', { name }),
  };
  const renderRow = (conversation: BotConversationSummary, readOnly: boolean) => (
    <ConversationRow
      key={conversation.session_id}
      conversation={conversation}
      title={conversationTitle(conversation, lookup, titleCopy)}
      lookup={lookup}
      active={conversation.session_id === current}
      readOnly={readOnly}
      onOpen={() => go(conversation.session_id)}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="bots-sidebar">
      <div className="flex flex-shrink-0 items-center gap-1 px-3 pb-1 pt-2">
        <span className="flex-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          {t('bots.sidebar.yourBots')}
        </span>
        <IconButton size="compact" label={t('bots.sidebar.newBot')} onClick={() => openDialog({ kind: 'new-bot' })}>
          <Plus size={14} />
        </IconButton>
        <IconButton size="compact" label={t('bots.sidebar.newGroup')} onClick={() => openDialog({ kind: 'new-group' })}>
          <Users size={14} />
        </IconButton>
      </div>

      <div
        className="flex flex-shrink-0 gap-1 overflow-x-auto px-2 pb-2 scrollbar-hide"
        role="group"
        aria-label={t('bots.sidebar.yourBots')}
      >
        {bots.map((bot) => {
          const attention = attentionByBot.get(bot.id);
          return (
            <button
              key={bot.id}
              type="button"
              onClick={() => void openDm(bot)}
              disabled={opening === bot.id}
              title={t('bots.sidebar.openDm', { name: bot.name })}
              className="group relative flex w-14 flex-shrink-0 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 transition-colors hover:bg-surface-muted"
            >
              <BotAvatar bot={bot} size="sm" />
              <span className="w-full truncate text-center text-[10px] text-fg-muted">{bot.name}</span>
              {attention === 'needs_you' && (
                <StatusDot
                  color="warning"
                  size="md"
                  className="absolute right-2 top-1.5 ring-2 ring-surface-chrome group-hover:ring-surface-muted"
                />
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => openDialog({ kind: 'new-bot' })}
          className="flex w-14 flex-shrink-0 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-fg-muted transition-colors hover:bg-surface-muted"
          title={t('bots.sidebar.newBot')}
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-edge-strong">
            <Plus size={14} />
          </span>
          <span className="w-full truncate text-center text-[10px]">{t('bots.sidebar.newBot')}</span>
        </button>
      </div>

      <div className="mx-3 border-t border-edge" />
      <span className="flex-shrink-0 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
        {t('bots.sidebar.conversations')}
      </span>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label={t('bots.sidebar.conversations')}>
        {botsState === 'error' ? (
          <div className="space-y-2 px-2 py-3" role="alert" data-testid="bots-sidebar-error">
            <p className="text-xs text-danger">{t('bots.loadFailed')}</p>
            <Button size="sm" variant="outline" onClick={() => void loadBots().catch(() => {})}>
              {t('bots.retry')}
            </Button>
          </div>
        ) : !loaded ? (
          <div className="space-y-2 px-1 py-1" aria-label={t('bots.sidebar.loading')}>
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex items-center gap-2">
                <Skeleton className="h-7 w-7 rounded-full" />
                <Skeleton className="h-3 flex-1" />
              </div>
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <p className="px-2 py-3 text-xs text-fg-faint">{t('bots.sidebar.empty')}</p>
        ) : (
          <>
            {live.length === 0 && <p className="px-2 py-3 text-xs text-fg-faint">{t('bots.sidebar.empty')}</p>}
            {live.map((conversation) => renderRow(conversation, false))}
            {archived.length > 0 && (
              <>
                <span className="block px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
                  {t('bots.sidebar.archived')}
                </span>
                {archived.map((conversation) => renderRow(conversation, true))}
              </>
            )}
          </>
        )}
      </nav>
    </div>
  );
}

function ConversationRow({
  conversation,
  title,
  lookup,
  active,
  readOnly,
  onOpen,
}: {
  conversation: BotConversationSummary;
  title: string;
  lookup: ReadonlyMap<string, BotView>;
  active: boolean;
  /** Nobody here can reply any more — dimmed, history only. */
  readOnly: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const members = conversation.members.flatMap((member) => {
    const bot = lookup.get(member.bot_id);
    return bot ? [bot] : [];
  });
  const owner = conversation.owner_bot_id ? lookup.get(conversation.owner_bot_id) : undefined;
  const last = conversation.last_message;
  const preview = last
    ? last.role === 'user'
      ? t('bots.sidebar.youSaid', { text: last.preview })
      : last.bot_id && conversation.kind === 'group'
        ? `${lookup.get(last.bot_id)?.name ?? t('bots.deletedBot')}: ${last.preview}`
        : last.preview
    : t('bots.sidebar.noMessages');
  // Active conversation: the member is looking at it, so "unread" is noise.
  const attention = active && conversation.attention === 'unread' ? 'idle' : conversation.attention;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? 'page' : undefined}
      className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
        active ? 'sidebar-active-item' : 'hover:bg-surface-muted'
      } ${readOnly && !active ? 'opacity-70' : ''}`}
      data-testid="bots-conversation-row"
      data-session-id={conversation.session_id}
    >
      {/* One leading slot for both kinds, sized to two overlapping 24px chips (24 + 24 − 6px) so titles
          align: a group shows its first two Bots and no +N chip (the header carries the roster). */}
      <span className="flex w-[42px] flex-shrink-0 justify-center">
        {conversation.kind === 'direct' ? (
          // Static; a DM nobody can answer any more (its Bot was archived) sleeps.
          <BotAvatar bot={owner} size="sm" state={readOnly ? 'sleep' : 'idle'} animate={false} />
        ) : (
          <BotAvatarStack
            bots={members.slice(0, 2)}
            max={2}
            size="xs"
            // The chip ring must match the row it sits on in every state, or it shows as a halo:
            // the chrome at rest, the hover fill under the pointer, the (opaque) active fill.
            ringClassName={active ? 'ring-sidebar-active' : 'ring-surface-chrome group-hover:ring-surface-muted'}
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span
            className={`min-w-0 flex-1 truncate text-xs ${attention === 'unread' ? 'font-semibold text-fg' : 'font-medium text-fg-secondary'}`}
            title={title}
          >
            {title}
          </span>
          <span className="flex-shrink-0 text-[10px] text-fg-faint">{relativeTime(conversation.last_activity_at)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint" title={preview}>
            {preview}
          </span>
          {attention === 'needs_you' ? (
            <Tag tone="warning">
              {conversation.pending_requests > 1
                ? `${t('bots.sidebar.needsYou')} ${conversation.pending_requests}`
                : t('bots.sidebar.needsYou')}
            </Tag>
          ) : attention === 'unread' ? (
            <StatusDot color="primary" size="md" />
          ) : attention === 'working' ? (
            <span title={t('bots.sidebar.working')}>
              <StatusDot color="success" size="md" pulse />
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}
