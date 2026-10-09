/**
 * Bots contextual sidebar: ONE conversation list. Sprouty — every member's built-in main Bot —
 * is pinned first; everything else follows by activity. Every live conversation is a Bot's DM
 * (other Bots join it as guests) and shows that Bot's face; each row carries at most one signal,
 * by priority: needs you > unread > working. What nobody can answer in any more — an archived
 * Bot's DM, a retired group chat (a stacked roster) — stays readable under "Archived". The
 * toolbar searches the list (titles, Bot names, last message) and creates a Bot. There is no
 * session list and no "new chat": a Bot's DM is permanent.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { isSproutyBot, type BotConversationSummary, type BotView } from '@greenhouse/types/bots';
import { Button, Skeleton, StatusDot, Tag } from '../ui';
import { Pin, Plus } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { relativeTime } from '../../lib/utils';
import { SidebarToolbar } from '../app/sidebar-toolbar';
import { conversationReplyable, ensureSprouty, useBotDirectory, useBotsLoadState, useBotsStore } from './bots-store';
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
  const [query, setQuery] = useState('');

  useEffect(() => {
    void loadBots().catch(() => {});
    void loadConversations().catch(() => {});
  }, [loadBots, loadConversations]);

  // Every member has Sprouty with a DM pinned here. A member whose Bots predate it,
  // or whose Sprouty row was created by Chat (the identity without a thread), gets
  // the Bot and its DM on the next visit — the bootstrap is idempotent.
  const sprouty = bots.find((bot) => isSproutyBot(bot));
  const sproutyDm = sprouty?.dm_session_id ?? null;
  useEffect(() => {
    if (botsState === 'ready' && (!sprouty || !sproutyDm)) void ensureSprouty().catch(() => {});
  }, [botsState, sprouty, sproutyDm]);

  const titleOf = useCallback(
    (conversation: BotConversationSummary) =>
      conversationTitle(conversation, lookup, {
        unknownBot: t('bots.deletedBot'),
        group: t('bots.sidebar.group'),
        archived: (name: string) => t('bots.archivedName', { name }),
      }),
    [lookup, t],
  );

  // Sprouty's DM first; then the conversations someone can still answer in, by activity; those
  // nobody can answer any more (an archived Bot's DM, a retired group chat) stay readable under
  // their own label.
  const { pinned, live, archived } = useMemo(() => {
    const activeIds = new Set(bots.map((bot) => bot.id));
    const needle = query.trim().toLocaleLowerCase();
    const matches = (conversation: BotConversationSummary) => {
      if (!needle) return true;
      const names = conversation.members.map((member) => lookup.get(member.bot_id)?.name ?? '');
      const owner = conversation.owner_bot_id ? lookup.get(conversation.owner_bot_id)?.name : undefined;
      return [titleOf(conversation), owner ?? '', ...names, conversation.last_message?.preview ?? ''].some((text) =>
        text.toLocaleLowerCase().includes(needle),
      );
    };
    let pinnedRow: BotConversationSummary | undefined;
    const open: BotConversationSummary[] = [];
    const closed: BotConversationSummary[] = [];
    for (const conversation of conversations) {
      if (sprouty && conversation.kind === 'direct' && conversation.owner_bot_id === sprouty.id) {
        if (matches(conversation)) pinnedRow = conversation;
        continue;
      }
      if (!matches(conversation)) continue;
      (conversationReplyable(conversation, activeIds) ? open : closed).push(conversation);
    }
    return { pinned: pinnedRow, live: open, archived: closed };
  }, [bots, conversations, lookup, query, sprouty, titleOf]);

  const go = (sessionId: string) => {
    openBotsConversation(sessionId);
    onNavigate?.();
  };

  const renderRow = (conversation: BotConversationSummary, readOnly: boolean, isPinned = false) => (
    <ConversationRow
      key={conversation.session_id}
      conversation={conversation}
      title={titleOf(conversation)}
      lookup={lookup}
      active={conversation.session_id === current}
      readOnly={readOnly}
      pinned={isPinned}
      onOpen={() => go(conversation.session_id)}
    />
  );

  const searching = query.trim() !== '';
  const nothing = !pinned && live.length === 0 && archived.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="bots-sidebar">
      <div className="flex-shrink-0 px-3 py-1.5">
        <SidebarToolbar
          value={query}
          onChange={setQuery}
          placeholder={t('bots.sidebar.search')}
          actions={[{ label: t('bots.sidebar.create'), icon: Plus, onClick: () => openDialog({ kind: 'new-bot' }) }]}
        />
      </div>
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
        ) : nothing ? (
          <p className="px-2 py-3 text-xs text-fg-faint" data-testid="bots-sidebar-empty">
            {searching ? t('bots.sidebar.noMatches') : t('bots.sidebar.empty')}
          </p>
        ) : (
          <>
            {pinned && renderRow(pinned, false, true)}
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
  pinned,
  onOpen,
}: {
  conversation: BotConversationSummary;
  title: string;
  lookup: ReadonlyMap<string, BotView>;
  active: boolean;
  /** Nobody here can reply any more — dimmed, history only. */
  readOnly: boolean;
  /** Sprouty's DM: always first. */
  pinned: boolean;
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
      data-pinned={pinned ? 'true' : undefined}
    >
      {/* One leading slot for both kinds, sized to two overlapping 24px chips (24 + 24 − 6px) so titles
          align: a retired group shows its first two Bots and no +N chip (the header carries the roster). */}
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
          {pinned && (
            <span className="flex-shrink-0 text-fg-faint" title={t('bots.sidebar.pinned')}>
              <Pin size={10} aria-label={t('bots.sidebar.pinned')} />
            </span>
          )}
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
