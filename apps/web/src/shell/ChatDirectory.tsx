/**
 * The chat directory (PRD §6.1, layout.md): the Agent area first with no heading (the main
 * Agent larger), then rooms, then chats (pinned, today, earlier). Rows never preview messages.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  BellOff,
  CheckCheck,
  Download,
  Hash,
  Link2,
  LogOut,
  MessageSquare,
  MonitorPlay,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  User,
  type LucideIcon,
} from 'lucide-react';
import { ConfirmDialog, IconButton, type MenuEntry } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Agent, Conversation } from '@greenhouse/contract';
import { useSession } from '../app/session';
import { useNotify } from '../app/notify';
import { useAgents, useArchiveAgent, useRestoreAgent } from '../data/agents';
import {
  downloadConversation,
  useConversations,
  useCreateConversation,
  useDeleteConversation,
  useMarkRead,
  useUpdateConversation,
} from '../data/conversations';
import { api } from '../lib/api';
import { ApiClientError } from '@greenhouse/contract/client';
import { useI18n } from '../lib/i18n';
import { href, navigate, type Route } from '../lib/router';
import { AgentAvatar } from './AgentAvatar';
import { DirectoryRow, DirectorySection, type Signal } from './DirectoryRow';
import { useOpenOverlay } from './overlays';

const glyph = (Icon: LucideIcon) => <Icon size={icon.md} strokeWidth={icon.stroke} />;

const matches = (query: string, ...values: string[]) =>
  !query || values.some((value) => value.toLowerCase().includes(query.toLowerCase()));

const dayKey = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  );

function signalOf(conversation: Conversation | undefined): Signal {
  if (!conversation) return {};
  return {
    needs: conversation.pending_requests,
    muted: conversation.muted,
    running: conversation.working,
    unread: conversation.unread > 0,
  };
}

/** The plant's face (AGNT-04): it moves only while its Agent answers, and waits while it needs you. */
function moodOf(conversation: Conversation | undefined): 'thinking' | 'waiting' | undefined {
  if (conversation?.working) return 'thinking';
  if (conversation?.pending_requests) return 'waiting';
  return undefined;
}

/** 已归档 (CONV-25): archived chats and rooms on demand; each can come back. */
function ArchivedChats({ query, isCurrent }: { query: string; isCurrent: (conversation: Conversation) => boolean }) {
  const { t } = useI18n();
  const update = useUpdateConversation();
  const [open, setOpen] = useState(false);
  const archived = useQuery({
    queryKey: ['conversations', 'archived'],
    queryFn: () => api.conversations.list({ archived: true, limit: 100 }),
    enabled: open,
  });
  const items = (archived.data?.items ?? []).filter((item) => matches(query, item.title || t('chat.untitled')));
  return (
    <div className="app-directory-bottom">
      <DirectoryRow
        leading={glyph(Archive)}
        title={t('directory.archived')}
        expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open &&
        items.map((item) => (
          <DirectoryRow
            key={item.id}
            leading={glyph(item.kind === 'room' ? Hash : MessageSquare)}
            title={item.title || t('chat.untitled')}
            href={href({ page: 'conversation', id: item.id })}
            active={isCurrent(item)}
            indent={1}
            menu={[
              {
                label: t('row.unarchive'),
                icon: glyph(ArchiveRestore),
                onClick: () =>
                  update.mutate(
                    { id: item.id, input: { archived: false } },
                    { onSuccess: () => void archived.refetch() },
                  ),
              },
            ]}
            menuLabel={t('row.actionsFor', { name: item.title || t('chat.untitled') })}
          />
        ))}
      {open && archived.isSuccess && !items.length && (
        <p className="app-muted app-directory-note">{t('directory.noneArchived')}</p>
      )}
    </div>
  );
}

export function ChatDirectory({ route, query }: { route: Route; query: string }) {
  const { t } = useI18n();
  const { me } = useSession();
  const notify = useNotify();
  const openOverlay = useOpenOverlay();
  const agents = useAgents('mine');
  const conversations = useConversations();
  const create = useCreateConversation();
  const update = useUpdateConversation();
  const remove = useDeleteConversation();
  const markRead = useMarkRead();
  const archiveAgent = useArchiveAgent();
  const restoreAgent = useRestoreAgent();
  const [earlier, setEarlier] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [leaving, setLeaving] = useState<Conversation | null>(null);

  const current = route.page === 'conversation' ? route.id : null;
  const timeZone = me?.timezone ?? 'Asia/Shanghai';
  const computers = !!me?.modules.computer && !!me?.capabilities.sandbox;

  const { main, others, directs, rooms, pinned, today, older } = useMemo(() => {
    const list = conversations.items.filter((item) => !item.archived);
    const directs = new Map<string, Conversation>();
    for (const item of list)
      if ((item.kind === 'direct' || item.kind === 'main') && item.agent_id) directs.set(item.agent_id, item);
    const chats = list.filter((item) => item.kind === 'chat');
    const todayKey = dayKey(new Date().toISOString(), timeZone);
    return {
      main: agents.items.find((agent) => agent.is_main),
      others: agents.items.filter((agent) => !agent.is_main),
      directs,
      rooms: list.filter((item) => item.kind === 'room'),
      pinned: chats.filter((item) => item.pinned),
      today: chats.filter((item) => !item.pinned && dayKey(item.last_activity_at, timeZone) === todayKey),
      older: chats.filter((item) => !item.pinned && dayKey(item.last_activity_at, timeZone) !== todayKey),
    };
  }, [conversations.items, agents.items, timeZone]);

  const mainConversation = conversations.items.find((item) => item.kind === 'main');
  const isCurrent = (conversation: Conversation | undefined) =>
    !!conversation && (current === conversation.id || (conversation.kind === 'main' && current === 'main'));

  const exportIt = (id: string) =>
    void downloadConversation(id).catch((error: unknown) =>
      notify(error instanceof ApiClientError ? error.message : t('common.error')),
    );

  const leave = (room: Conversation) =>
    void api.conversations
      .removeMember(room.id, me!.id)
      .then(() => {
        void conversations.refetch();
        if (isCurrent(room)) navigate('#/c/main', { replace: true });
      })
      .catch((error: unknown) => notify(error instanceof ApiClientError ? error.message : t('common.error')));

  const copyLink = (id: string) => {
    void navigator.clipboard?.writeText(`${location.origin}${location.pathname}${href({ page: 'conversation', id })}`);
    notify(t('row.linkCopied'));
  };

  const openAgent = (agent: Agent) => {
    if (agent.is_main) return navigate('#/c/main');
    const direct = directs.get(agent.id);
    if (direct) return navigate({ page: 'conversation', id: direct.id });
    create.mutate(
      { kind: 'direct', agent_id: agent.id },
      { onSuccess: (conversation) => navigate({ page: 'conversation', id: conversation.id }) },
    );
  };

  const conversationToggles = (conversation: Conversation | undefined): MenuEntry[] =>
    conversation
      ? [
          {
            label: t('row.mute'),
            icon: glyph(BellOff),
            checked: conversation.muted,
            onClick: () => update.mutate({ id: conversation.id, input: { muted: !conversation.muted } }),
          },
          {
            label: t('row.markRead'),
            icon: glyph(CheckCheck),
            disabled: conversation.unread === 0,
            onClick: () => markRead.mutate({ id: conversation.id, seq: conversation.last_seq }),
          },
        ]
      : [];

  const agentMenu = (agent: Agent): MenuEntry[] => {
    const conversation = agent.is_main ? mainConversation : directs.get(agent.id);
    return [
      {
        label: t('chat.newChat'),
        icon: glyph(Plus),
        onClick: () => navigate(agent.is_main ? '#/c/new' : { page: 'conversation', id: 'new', agent: agent.id }),
      },
      {
        label: t('agents.profile'),
        icon: glyph(User),
        onClick: () => navigate({ page: 'agent', id: agent.is_main ? 'main' : agent.id, tab: 'profile' }),
      },
      ...(computers
        ? [
            {
              label: t('agents.computer'),
              icon: glyph(MonitorPlay),
              onClick: () => navigate({ page: 'agent', id: agent.is_main ? 'main' : agent.id, tab: 'computer' }),
            },
          ]
        : []),
      ...(conversation ? (['-', ...conversationToggles(conversation)] as MenuEntry[]) : []),
      ...(agent.is_main
        ? []
        : ([
            '-',
            {
              label: t('row.archive'),
              icon: glyph(Archive),
              onClick: () =>
                archiveAgent.mutate(agent.id, {
                  onSuccess: () =>
                    notify(t('chat.archived', { name: agent.name }), {
                      label: t('row.undo'),
                      onClick: () => restoreAgent.mutate(agent.id),
                    }),
                }),
            },
          ] as MenuEntry[])),
    ];
  };

  const roomMenu = (room: Conversation): MenuEntry[] => [
    { label: t('row.copyLink'), icon: glyph(Link2), onClick: () => copyLink(room.id) },
    ...conversationToggles(room),
    { label: t('row.rename'), icon: glyph(Pencil), onClick: () => setRenaming(room.id) },
    { label: t('row.export'), icon: glyph(Download), onClick: () => exportIt(room.id) },
    '-',
    { label: t('chat.leave'), icon: glyph(LogOut), danger: true, onClick: () => setLeaving(room) },
  ];

  const chatMenu = (chat: Conversation): MenuEntry[] => [
    {
      label: chat.pinned ? t('row.unpin') : t('row.pin'),
      icon: glyph(chat.pinned ? PinOff : Pin),
      onClick: () => update.mutate({ id: chat.id, input: { pinned: !chat.pinned } }),
    },
    { label: t('row.rename'), icon: glyph(Pencil), onClick: () => setRenaming(chat.id) },
    { label: t('row.copyLink'), icon: glyph(Link2), onClick: () => copyLink(chat.id) },
    { label: t('row.export'), icon: glyph(Download), onClick: () => exportIt(chat.id) },
    {
      label: t('row.archive'),
      icon: glyph(Archive),
      onClick: () =>
        update.mutate(
          { id: chat.id, input: { archived: true } },
          {
            onSuccess: () =>
              notify(t('chat.archived', { name: chat.title || t('chat.untitled') }), {
                label: t('row.undo'),
                onClick: () => update.mutate({ id: chat.id, input: { archived: false } }),
              }),
          },
        ),
    },
    '-',
    { label: t('row.delete'), icon: glyph(Trash2), danger: true, onClick: () => setDeleting(chat) },
  ];

  const rename = (conversation: Conversation) => (name: string | null) => {
    setRenaming(null);
    if (name) update.mutate({ id: conversation.id, input: { title: name } });
  };

  const conversationRow = (conversation: Conversation, Icon: LucideIcon, menu: MenuEntry[], indent = 0) => (
    <DirectoryRow
      key={conversation.id}
      leading={glyph(Icon)}
      title={conversation.title || t('chat.untitled')}
      href={href({ page: 'conversation', id: conversation.id })}
      active={isCurrent(conversation)}
      signal={signalOf(conversation)}
      indent={indent}
      menu={menu}
      menuLabel={t('row.actionsFor', { name: conversation.title || t('chat.untitled') })}
      renaming={renaming === conversation.id}
      onRename={rename(conversation)}
    />
  );

  const visibleOthers = others.filter((agent) => matches(query, agent.name, agent.role));
  const visible = (items: Conversation[]) => items.filter((item) => matches(query, item.title || t('chat.untitled')));
  const olderVisible = visible(older);

  return (
    <>
      <div className="app-agent-rows">
        {main && matches(query, main.name, t('chat.mainThread')) && (
          <DirectoryRow
            variant="main"
            leading={<AgentAvatar agent={main} size={36} state={moodOf(mainConversation)} />}
            title={main.name}
            href="#/c/main"
            active={current === 'main' || isCurrent(mainConversation)}
            signal={signalOf(mainConversation)}
            menu={() => agentMenu(main)}
            menuLabel={t('row.actionsFor', { name: main.name })}
          />
        )}
        {visibleOthers.map((agent) => {
          const direct = directs.get(agent.id);
          return (
            <DirectoryRow
              key={agent.id}
              leading={<AgentAvatar agent={agent} size={20} state={moodOf(direct)} />}
              title={agent.name}
              href={direct ? href({ page: 'conversation', id: direct.id }) : undefined}
              active={isCurrent(direct)}
              signal={signalOf(direct)}
              menu={() => agentMenu(agent)}
              menuLabel={t('row.actionsFor', { name: agent.name })}
              onClick={direct ? undefined : () => openAgent(agent)}
            />
          );
        })}
      </div>

      <DirectorySection
        title={t('chat.rooms')}
        actions={
          <IconButton label={t('chat.newRoom')} size="sm" onClick={() => openOverlay({ type: 'new-room' })}>
            <Plus size={icon.sm} strokeWidth={icon.stroke} />
          </IconButton>
        }
      >
        {visible(rooms).map((room) => conversationRow(room, Hash, roomMenu(room)))}
      </DirectorySection>

      <DirectorySection title={t('chat.chats')}>
        {visible(pinned).map((chat) => conversationRow(chat, Pin, chatMenu(chat)))}
        {visible(today).map((chat) => conversationRow(chat, MessageSquare, chatMenu(chat)))}
        {olderVisible.length > 0 && (
          <>
            <DirectoryRow
              title={t('chat.earlier')}
              expanded={earlier || !!query}
              onClick={() => setEarlier(!earlier)}
            />
            {(earlier || query) && olderVisible.map((chat) => conversationRow(chat, MessageSquare, chatMenu(chat), 1))}
            {(earlier || query) && conversations.hasNextPage && (
              <DirectoryRow
                title={t('chat.showEarlier')}
                indent={1}
                onClick={() => void conversations.fetchNextPage()}
              />
            )}
          </>
        )}
      </DirectorySection>

      <ArchivedChats query={query} isCurrent={isCurrent} />

      {leaving && (
        <ConfirmDialog
          danger
          title={t('chat.leaveTitle', { name: leaving.title || t('chat.untitled') })}
          confirmLabel={t('chat.leave')}
          onCancel={() => setLeaving(null)}
          onConfirm={() => {
            leave(leaving);
            setLeaving(null);
          }}
        >
          {t('chat.leaveBody')}
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title={t('chat.deleteTitle', { name: deleting.title || t('chat.untitled') })}
          confirmLabel={t('row.delete')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            remove.mutate(target.id, {
              onSuccess: () => {
                if (isCurrent(target)) navigate('#/c/main', { replace: true });
              },
            });
          }}
        >
          {t('chat.deleteBody')}
        </ConfirmDialog>
      )}
    </>
  );
}
