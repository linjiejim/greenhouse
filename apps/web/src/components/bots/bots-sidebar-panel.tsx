/**
 * The Agent threads of the conversations sidebar (spec 20261011-agent-first-class §3.1): the
 * member's main thread — their DM with Sprouty, the built-in main Agent — under "Main thread",
 * then the member's conversations with other people (rooms, P5 — private chats and titled rooms,
 * by activity, ending in "New conversation with people…") under "People", then every other
 * Agent's DM by activity under "Agents". Each row shows that Agent's face and
 * carries at most one signal, by priority: needs you > unread > working. Someone else's public Agent
 * (spec P4) is listed with the member's own, marked "by {owner}". What nobody can answer in any
 * more — an archived Agent's DM, a public Agent no longer offered, a retired group chat (a stacked
 * roster) — stays readable under "Archived". The search box and "new Agent" live in the sidebar's one toolbar
 * (`ConversationsSidebarPanel`); the member's chats follow in the same list.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { isSproutyBot, type BotConversationSummary, type BotView, type SharedBotView } from '@greenhouse/types/bots';
import { Button, Skeleton, StatusDot, Tag } from '../ui';
import { Pin, Plus } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { relativeTime } from '../../lib/utils';
import { useAuthStore } from '../../stores';
import { SidebarSectionLabel } from '../app/sidebar-section-label';
import {
  conversationReplyable,
  ensureSprouty,
  useBotDirectory,
  useBotsLoadState,
  useBotsStore,
  useReplyableBotIds,
  useSharedBots,
} from './bots-store';
import { BotAvatar, BotAvatarStack } from './bot-avatar';
import { conversationTitle, openBotsConversation, useCurrentBotsConversation } from './navigation';
import { PeopleAvatarStack, PersonAvatar } from './person-avatar';
import { personName, roomOthers } from './room';

export function BotsThreadsSection({ query, onNavigate }: { query: string; onNavigate?: () => void }) {
  const t = useT();
  const bots = useBotsStore((state) => state.bots);
  const conversations = useBotsStore((state) => state.conversations);
  const botsState = useBotsLoadState();
  // Rows name their Agents: until the Agent list is in, every row would read
  // "Deleted Agent" for a moment — show skeletons instead (or the failure).
  const loaded = useBotsStore((state) => state.conversationsLoaded) && botsState === 'ready';
  const loadBots = useBotsStore((state) => state.loadBots);
  const loadConversations = useBotsStore((state) => state.loadConversations);
  const current = useCurrentBotsConversation();
  const lookup = useBotDirectory();
  const shared = useSharedBots();
  const activeIds = useReplyableBotIds();
  const me = useAuthStore((state) => state.currentUser?.id ?? null);
  const openDialog = useBotsStore((state) => state.openDialog);

  useEffect(() => {
    void loadBots().catch(() => {});
    void loadConversations().catch(() => {});
  }, [loadBots, loadConversations]);

  // Every member has Sprouty with a DM — their main thread. A member whose Agents predate it,
  // or whose Sprouty row was created by a chat (the identity without a thread), gets the Agent
  // and its DM on the next visit — the bootstrap is idempotent.
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
        chat: t('bots.newChat'),
        archived: (name: string) => t('bots.archivedName', { name }),
        room: { me, untitled: t('bots.room.untitled') },
      }),
    [lookup, me, t],
  );

  // The main thread first; then the conversations with other people; then the Agent threads
  // someone can still answer in, by activity; those nobody can answer any more (an archived Agent's
  // DM, a retired group chat) stay readable under their own label.
  const { pinned, rooms, live, archived } = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = (conversation: BotConversationSummary) => {
      if (!needle) return true;
      const names = conversation.members.map((member) => lookup.get(member.bot_id)?.name ?? '');
      const owner = conversation.owner_bot_id ? lookup.get(conversation.owner_bot_id)?.name : undefined;
      const publisher = conversation.owner_bot_id ? shared.get(conversation.owner_bot_id)?.owner.nickname : undefined;
      const people = (conversation.participants ?? []).map((person) => person.nickname);
      return [
        titleOf(conversation),
        owner ?? '',
        publisher ?? '',
        ...names,
        ...people,
        conversation.last_message?.preview ?? '',
      ].some((text) => text.toLocaleLowerCase().includes(needle));
    };
    let pinnedRow: BotConversationSummary | undefined;
    const withPeople: BotConversationSummary[] = [];
    const open: BotConversationSummary[] = [];
    const closed: BotConversationSummary[] = [];
    for (const conversation of conversations) {
      // Separate chats are listed with the chats (`GET /api/sessions?include=agent_chats`), never
      // as a thread — the threads list does not return them, and one that slips in stays out.
      if (conversation.kind === 'task') continue;
      if (sprouty && conversation.kind === 'direct' && conversation.owner_bot_id === sprouty.id) {
        if (matches(conversation)) pinnedRow = conversation;
        continue;
      }
      if (!matches(conversation)) continue;
      if (conversation.kind === 'room') withPeople.push(conversation);
      else (conversationReplyable(conversation, activeIds) ? open : closed).push(conversation);
    }
    return { pinned: pinnedRow, rooms: withPeople, live: open, archived: closed };
  }, [activeIds, conversations, lookup, query, shared, sprouty, titleOf]);

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
      publishedBy={
        conversation.kind === 'direct' && conversation.owner_bot_id ? shared.get(conversation.owner_bot_id) : undefined
      }
      active={conversation.session_id === current}
      readOnly={readOnly}
      pinned={isPinned}
      onOpen={() => go(conversation.session_id)}
    />
  );

  return (
    <nav className="px-1 pb-1" aria-label={t('bots.sidebar.conversations')} data-testid="bots-sidebar">
      {botsState === 'error' ? (
        <div className="space-y-2 px-2 py-3" role="alert" data-testid="bots-sidebar-error">
          <p className="text-xs text-danger">{t('bots.loadFailed')}</p>
          <Button size="sm" variant="outline" onClick={() => void loadBots().catch(() => {})}>
            {t('bots.retry')}
          </Button>
        </div>
      ) : !loaded ? (
        <div className="space-y-2 px-2 py-2" aria-label={t('bots.sidebar.loading')}>
          {[0, 1].map((index) => (
            <div key={index} className="flex items-center gap-2">
              <Skeleton className="h-7 w-7 rounded-full" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      ) : (
        <>
          {pinned && (
            <>
              <SidebarSectionLabel testId="sidebar-section-main">{t('bots.sidebar.main')}</SidebarSectionLabel>
              {renderRow(pinned, false, true)}
            </>
          )}
          {/* People (P5): always there — it is also where a conversation with people starts. While
              searching, only when something matches. */}
          {(rooms.length > 0 || !query.trim()) && (
            <>
              <SidebarSectionLabel testId="sidebar-section-people">{t('bots.room.section')}</SidebarSectionLabel>
              {rooms.map((conversation) => (
                <RoomRow
                  key={conversation.session_id}
                  conversation={conversation}
                  title={titleOf(conversation)}
                  me={me}
                  lookup={lookup}
                  active={conversation.session_id === current}
                  onOpen={() => go(conversation.session_id)}
                />
              ))}
              {!query.trim() && (
                <button
                  type="button"
                  onClick={() => openDialog({ kind: 'new-room' })}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg-secondary"
                  data-testid="sidebar-new-room"
                >
                  <span className="flex w-[42px] flex-shrink-0 justify-center">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-edge-strong">
                      <Plus size={14} aria-hidden="true" />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t('bots.room.newRoom')}</span>
                </button>
              )}
            </>
          )}
          {live.length > 0 && (
            <>
              <SidebarSectionLabel testId="sidebar-section-agents">{t('bots.sidebar.agents')}</SidebarSectionLabel>
              {live.map((conversation) => renderRow(conversation, false))}
            </>
          )}
          {archived.length > 0 && (
            <>
              <SidebarSectionLabel>{t('bots.sidebar.archived')}</SidebarSectionLabel>
              {archived.map((conversation) => renderRow(conversation, true))}
            </>
          )}
        </>
      )}
    </nav>
  );
}

function ConversationRow({
  conversation,
  title,
  lookup,
  publishedBy,
  active,
  readOnly,
  pinned,
  onOpen,
}: {
  conversation: BotConversationSummary;
  title: string;
  lookup: ReadonlyMap<string, BotView>;
  /** Someone else's public Agent: the row says whose it is. */
  publishedBy?: SharedBotView;
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
        {conversation.kind !== 'group' ? (
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
          {publishedBy && (
            <span
              className="min-w-0 max-w-[45%] flex-shrink truncate text-[10px] text-fg-faint"
              title={t('bots.shared.by', { name: publishedBy.owner.nickname })}
              data-testid="bots-conversation-row-owner"
            >
              {t('bots.shared.by', { name: publishedBy.owner.nickname })}
            </span>
          )}
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
          <AttentionMark attention={attention} pending={conversation.pending_requests} />
        </span>
      </span>
    </button>
  );
}

/** A row's one signal, by priority: needs you > unread > working. */
function AttentionMark({ attention, pending }: { attention: BotConversationSummary['attention']; pending: number }) {
  const t = useT();
  if (attention === 'needs_you') {
    return (
      <Tag tone="warning">{pending > 1 ? `${t('bots.sidebar.needsYou')} ${pending}` : t('bots.sidebar.needsYou')}</Tag>
    );
  }
  if (attention === 'unread') return <StatusDot color="primary" size="md" />;
  if (attention === 'working') {
    return (
      <span title={t('bots.sidebar.working')}>
        <StatusDot color="success" size="md" pulse />
      </span>
    );
  }
  return null;
}

/**
 * A conversation with other people (P5). The leading slot shows the people, not a plant: the other
 * person's initial in a private chat, the first two others overlapped in a bigger room. The preview
 * names who spoke last — "You: …", "Ana: …", or the Agent.
 */
function RoomRow({
  conversation,
  title,
  me,
  lookup,
  active,
  onOpen,
}: {
  conversation: BotConversationSummary;
  title: string;
  me: string | null;
  lookup: ReadonlyMap<string, BotView>;
  active: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const others = roomOthers(conversation, me);
  const last = conversation.last_message;
  const speaker = (() => {
    if (!last) return null;
    if (last.role === 'user') {
      if (!last.author_user_id || last.author_user_id === me) return t('bots.room.you');
      return personName(conversation, last.author_user_id) ?? t('bots.room.formerMember');
    }
    if (last.role === 'assistant' && last.bot_id) {
      const known = lookup.get(last.bot_id)?.name;
      if (known) return known;
      const member = conversation.members.find((candidate) => candidate.bot_id === last.bot_id);
      const owner = member ? personName(conversation, member.owner_user_id) : null;
      return owner ? t('bots.room.agentOf', { name: owner }) : null;
    }
    return null;
  })();
  const preview = last
    ? speaker
      ? t('bots.room.said', { name: speaker, text: last.preview })
      : last.preview
    : t('bots.sidebar.noMessages');
  const attention = active && conversation.attention === 'unread' ? 'idle' : conversation.attention;
  const ring = active ? 'ring-sidebar-active' : 'ring-surface-chrome group-hover:ring-surface-muted';

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? 'page' : undefined}
      className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
        active ? 'sidebar-active-item' : 'hover:bg-surface-muted'
      }`}
      data-testid="bots-conversation-row"
      data-kind="room"
      data-session-id={conversation.session_id}
    >
      <span className="flex w-[42px] flex-shrink-0 justify-center">
        {others.length <= 1 ? (
          <PersonAvatar name={others[0]?.nickname ?? title} size="sm" />
        ) : (
          <PeopleAvatarStack names={others.map((person) => person.nickname)} max={2} size="xs" ringClassName={ring} />
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
          <AttentionMark attention={attention} pending={conversation.pending_requests} />
        </span>
      </span>
    </button>
  );
}
