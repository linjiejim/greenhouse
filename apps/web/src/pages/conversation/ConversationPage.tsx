/**
 * A conversation (PRD §7.1): the main thread, an Agent's thread, a chat or a room. One header,
 * the message column and the composer; the side panel opens over it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  BellOff,
  CheckCheck,
  Download,
  Info,
  Link2,
  LogOut,
  MonitorPlay,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import { ComputerScreen } from '../../computer/ComputerScreen';
import { ConfirmDialog, Empty, ErrorBox, IconButton, Overlay, Skeleton, type MenuEntry } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Conversation, Message, NeedsYou } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { Composer, type Candidate, type ComposerSend } from '../../conversation/Composer';
import { MessageView, type Author } from '../../conversation/MessageView';
import { RequestCard } from '../../conversation/RequestCard';
import { Thread } from '../../conversation/Thread';
import {
  downloadConversation,
  useConversation,
  useConversationMembers,
  useConversations,
  useDeleteConversation,
  useEditMessage,
  useMarkRead,
  useMemberActions,
  useMessages,
  useRate,
  useRegenerate,
  useSendMessage,
  useStop,
  useUpdateConversation,
} from '../../data/conversations';
import { usePeople } from '../../data/people';
import { useRequests } from '../../data/requests';
import { readStream } from '../../data/streams';
import { useI18n } from '../../lib/i18n';
import { useVisible } from '../../lib/media';
import { href, navigate } from '../../lib/router';
import { AgentAvatar } from '../../shell/AgentAvatar';
import { Page, PageHeader } from '../../shell/Page';
import { InfoDrawer } from './InfoDrawer';
import { NewChat } from './NewChat';

const GROUP_GAP_MS = 5 * 60_000;

function lastIndexWhere<T>(list: readonly T[], test: (item: T) => boolean): number {
  for (let index = list.length - 1; index >= 0; index -= 1) if (test(list[index]!)) return index;
  return -1;
}

const authorKey = (message: Message) =>
  message.role === 'event'
    ? 'event'
    : message.agent_id
      ? `agent:${message.agent_id}`
      : `member:${message.author_member_id}`;

export function ConversationPage({ id, agent }: { id: string; agent?: string }) {
  if (id === 'new') return <NewChat agentId={agent} />;
  return <ExistingConversation id={id} />;
}

function ExistingConversation({ id }: { id: string }) {
  const { t } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const conversations = useConversations();
  const listed = id === 'main' ? conversations.items.find((item) => item.kind === 'main') : undefined;
  const conversationId = id === 'main' ? listed?.id : id;
  const detail = useConversation(conversationId);
  const messages = useMessages(conversationId);
  const requests = useRequests(conversationId, 'all', !!conversationId);
  const people = usePeople();
  const send = useSendMessage(conversationId ?? '');
  const stop = useStop(conversationId ?? '');
  const markRead = useMarkRead();
  const update = useUpdateConversation();
  const remove = useDeleteConversation();
  const rate = useRate(conversationId ?? '');
  const edit = useEditMessage(conversationId ?? '');
  const regenerate = useRegenerate(conversationId ?? '');
  const memberActions = useMemberActions(conversationId ?? '');
  const [leaving, setLeaving] = useState(false);
  const [quote, setQuote] = useState<{ message_id: string; text: string } | null>(null);
  const [seed, setSeed] = useState<{ text: string }>();
  const [info, setInfo] = useState(false);
  const [screen, setScreen] = useState<null | { control: boolean }>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // The list row carries the live flags (working, unread); the detail adds members and digest.
  const row = conversations.items.find((item) => item.id === conversationId);
  const conversation: Conversation | undefined = row ?? detail.data;
  const answering = conversation?.agent_id ? people.agentById.get(conversation.agent_id) : undefined;
  const timeZone = me.timezone;

  // Reading marks the conversation read, once per new message.
  const lastSeq = conversation?.last_seq ?? 0;
  const readSeq = conversation?.last_read_seq ?? 0;
  const visible = useVisible();
  const marking = useRef(0);
  const { mutate: markReadNow } = markRead;
  useEffect(() => {
    if (!conversationId || !visible || lastSeq <= readSeq || marking.current >= lastSeq) return;
    const timer = setTimeout(() => {
      marking.current = lastSeq;
      markReadNow({ id: conversationId, seq: lastSeq });
    }, 400);
    return () => clearTimeout(timer);
  }, [conversationId, visible, lastSeq, readSeq, markReadNow]);

  const requestsByRun = useMemo(() => {
    const map = new Map<string, NeedsYou[]>();
    for (const request of requests.items) {
      if (!request.run_id) continue;
      map.set(request.run_id, [...(map.get(request.run_id) ?? []), request]);
    }
    return map;
  }, [requests.items]);

  const shownRuns = new Set(messages.messages.map((message) => message.run_id).filter(Boolean));
  const looseRequests = requests.items.filter(
    (request) => request.status === 'pending' && (!request.run_id || !shownRuns.has(request.run_id)),
  );

  const authorOf = useCallback(
    (message: Message): Author => {
      if (message.agent_id) {
        const agent = people.agentById.get(message.agent_id);
        return {
          name: agent?.name ?? 'Agent',
          agent: agent ?? { id: message.agent_id, avatar: {}, template_key: null },
        };
      }
      if (message.author_member_id === me.id) return { name: me.name, member: { avatar_url: me.avatar_url } };
      const member = message.author_member_id ? people.memberById.get(message.author_member_id) : undefined;
      return { name: member?.name ?? '—', member: member ?? { avatar_url: null } };
    },
    [people.agentById, people.memberById, me],
  );

  // In a room, @ names the people here and my own Agents that are here (only those answer me).
  const room = conversation?.kind === 'room';
  const roomPeople = useConversationMembers(conversationId, room);
  const candidates: Candidate[] = useMemo(() => {
    if (!room || !roomPeople.data) return [];
    return [
      ...roomPeople.data.agents
        .filter((agent) => agent.owner_id === me.id)
        .map((agent) => ({
          handle: `agent:${agent.id}`,
          name: agent.name,
          hint: agent.role,
          leading: <AgentAvatar agent={{ id: agent.id, avatar: agent.avatar, template_key: null }} size={20} />,
        })),
      ...roomPeople.data.members
        .filter((member) => member.id !== me.id)
        .map((member) => ({ handle: member.id, name: member.name, hint: member.email })),
    ];
  }, [room, roomPeople.data, me.id]);

  if (id === 'main' && conversations.isPending) return <PageSkeleton />;
  if (!conversationId || detail.isError) {
    const missing = detail.error instanceof ApiClientError && detail.error.status === 404;
    return (
      <Page header={<PageHeader title={missing ? t('common.notFound') : t('common.error')} />} width="reading">
        {missing ? (
          <Empty title={t('chat.notFound')} />
        ) : (
          <ErrorBox onRetry={() => void detail.refetch()}>{t('common.error')}</ErrorBox>
        )}
      </Page>
    );
  }
  if (!conversation) return <PageSkeleton />;

  const kind = conversation.kind;
  const title =
    kind === 'main' || kind === 'direct'
      ? (answering?.name ?? conversation.title)
      : conversation.title || t('chat.untitled');
  const status = conversation.working
    ? t('status.running')
    : kind === 'main'
      ? t('chat.mainThread')
      : kind === 'room'
        ? t('chat.people', { count: detail.data?.members.length ?? 0 })
        : (answering?.role ?? '');

  const sendMessage = async (input: ComposerSend) => {
    const result = await send.mutateAsync(input).catch((error: unknown) => {
      notify(error instanceof ApiClientError ? error.message : t('common.error'));
      throw error;
    });
    if (result.queued) notify(t('message.queued'));
  };

  const exportIt = () =>
    void downloadConversation(conversation.id).catch((error: unknown) =>
      notify(error instanceof ApiClientError ? error.message : t('common.error')),
    );

  const copyLink = () => {
    void navigator.clipboard?.writeText(
      `${location.origin}${location.pathname}${href({ page: 'conversation', id: conversation.id })}`,
    );
    notify(t('row.linkCopied'));
  };

  const menu: MenuEntry[] =
    kind === 'chat'
      ? [
          {
            label: conversation.pinned ? t('row.unpin') : t('row.pin'),
            icon: conversation.pinned ? <PinOff size={icon.md} /> : <Pin size={icon.md} />,
            onClick: () => update.mutate({ id: conversation.id, input: { pinned: !conversation.pinned } }),
          },
          { label: t('row.rename'), icon: <Pencil size={icon.md} />, onClick: () => setRenaming(true) },
          { label: t('row.copyLink'), icon: <Link2 size={icon.md} />, onClick: copyLink },
          { label: t('row.export'), icon: <Download size={icon.md} />, onClick: exportIt },
          {
            label: t('row.archive'),
            icon: <Archive size={icon.md} />,
            onClick: () => update.mutate({ id: conversation.id, input: { archived: true } }),
          },
          '-',
          { label: t('row.delete'), icon: <Trash2 size={icon.md} />, danger: true, onClick: () => setDeleting(true) },
        ]
      : [
          {
            label: t('row.mute'),
            icon: <BellOff size={icon.md} />,
            checked: conversation.muted,
            onClick: () => update.mutate({ id: conversation.id, input: { muted: !conversation.muted } }),
          },
          {
            label: t('row.markRead'),
            icon: <CheckCheck size={icon.md} />,
            disabled: conversation.unread === 0,
            onClick: () => markRead.mutate({ id: conversation.id, seq: conversation.last_seq }),
          },
          { label: t('row.export'), icon: <Download size={icon.md} />, onClick: exportIt },
          ...(kind === 'room'
            ? ([
                { label: t('row.rename'), icon: <Pencil size={icon.md} />, onClick: () => setRenaming(true) },
                { label: t('row.copyLink'), icon: <Link2 size={icon.md} />, onClick: copyLink },
                '-',
                {
                  label: t('chat.leave'),
                  icon: <LogOut size={icon.md} />,
                  danger: true,
                  onClick: () => setLeaving(true),
                },
              ] as MenuEntry[])
            : []),
        ];

  const list = messages.messages;
  const last = list[list.length - 1];
  // Edit and regenerate touch only my latest exchange (the server checks it too).
  const lastOwn = lastIndexWhere(list, (message) => message.role === 'user' && message.author_member_id === me.id);
  const editableId =
    lastOwn >= 0 && list.slice(lastOwn + 1).every((message) => message.role !== 'user') ? list[lastOwn]!.id : null;
  const lastSpoken = list[lastIndexWhere(list, (message) => message.role !== 'event')];
  const regenerableId =
    lastSpoken?.role === 'assistant' && lastSpoken.status !== 'streaming' && lastOwn >= 0 && editableId
      ? lastSpoken.id
      : null;
  const busyReason = conversation.working ? t('message.busy') : undefined;
  const failed = (error: unknown) => notify(error instanceof ApiClientError ? error.message : t('common.error'));
  const tail = last ? `${last.id}:${last.status}:${last.content.length}:${readStream(last.id)?.text.length ?? 0}` : '';

  return (
    <Page
      className="app-conversation"
      scroll={false}
      header={
        <PageHeader
          leading={answering && <AgentAvatar agent={answering} size={28} />}
          title={
            renaming ? (
              <input
                className="app-title-input"
                autoFocus
                defaultValue={conversation.title}
                aria-label={t('row.rename')}
                maxLength={120}
                onBlur={(event) => {
                  setRenaming(false);
                  const next = event.target.value.trim();
                  if (next && next !== conversation.title)
                    update.mutate({ id: conversation.id, input: { title: next } });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') setRenaming(false);
                }}
              />
            ) : (
              <span className="app-title-stack">
                <span className="app-title-name">{title}</span>
                {status && <span className="app-title-status">{status}</span>}
              </span>
            )
          }
          actions={
            <>
              {answering && me.modules.computer && me.capabilities.sandbox && (
                <IconButton
                  label={t('agents.computer')}
                  aria-pressed={!!screen}
                  onClick={() => setScreen({ control: false })}
                >
                  <MonitorPlay size={icon.md} />
                </IconButton>
              )}
              <IconButton label={t('chat.info')} aria-pressed={info} onClick={() => setInfo(true)}>
                <Info size={icon.md} />
              </IconButton>
            </>
          }
          menu={menu}
        />
      }
    >
      <div className="app-conversation-body">
        <Thread
          tail={tail}
          hasOlder={!!messages.hasNextPage}
          loadingOlder={messages.isFetchingNextPage}
          onLoadOlder={() => void messages.fetchNextPage()}
          header={
            detail.data?.digest ? (
              <button type="button" className="app-summary-notice" onClick={() => setInfo(true)}>
                {t('message.summaryNotice')} · {t('message.viewSummary')}
              </button>
            ) : undefined
          }
        >
          {messages.isPending && <Skeleton lines={6} />}
          {messages.isError && <ErrorBox onRetry={() => void messages.refetch()}>{t('common.error')}</ErrorBox>}
          {list.map((message, index) => {
            const previous = list[index - 1];
            const showAuthor =
              !previous ||
              authorKey(previous) !== authorKey(message) ||
              new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() > GROUP_GAP_MS;
            const mine = message.author_member_id === me.id && message.role === 'user';
            return (
              <MessageView
                key={message.id}
                message={message}
                author={authorOf(message)}
                showAuthor={showAuthor}
                mine={mine}
                requests={
                  message.run_id && message.role === 'assistant' ? (requestsByRun.get(message.run_id) ?? []) : []
                }
                timeZone={timeZone}
                rating={message.my_rating}
                onRate={
                  message.role === 'assistant'
                    ? (rating) => rate.mutate({ messageId: message.id, rating }, { onError: failed })
                    : undefined
                }
                onQuote={(text) => setQuote({ message_id: message.id, text: text.slice(0, 2000) })}
                onNewChat={() => navigate('#/c/new')}
                onEdit={
                  message.id === editableId
                    ? (content) => edit.mutateAsync({ messageId: message.id, content }).catch(failed)
                    : undefined
                }
                onRegenerate={
                  message.id === regenerableId ? () => regenerate.mutate(message.id, { onError: failed }) : undefined
                }
                busyReason={busyReason}
                blockContext={
                  message.role === 'assistant'
                    ? {
                        onAction: conversation.read_only
                          ? undefined
                          : (value) => void sendMessage({ content: value, attachments: [], mentions: [] }),
                        onPrompt: (text) => setSeed({ text }),
                        followUp: list
                          .slice(index + 1)
                          .find((next) => next.role === 'user' && next.author_member_id === me.id)?.content,
                      }
                    : undefined
                }
                readBy={
                  room && mine
                    ? roomPeople.data?.members
                        .filter((member) => member.id !== me.id && member.last_read_seq >= message.seq)
                        .map((member) => member.name)
                    : undefined
                }
              />
            );
          })}
          {looseRequests.map((request) => (
            <RequestCard key={request.id} request={request} />
          ))}
        </Thread>
        {conversation.read_only ? (
          <div className="app-readonly" role="status">
            {t('composer.readOnly')}
          </div>
        ) : (
          <Composer
            key={conversation.id}
            conversationId={conversation.id}
            placeholder={
              kind === 'room'
                ? t('composer.placeholderRoom', { name: title })
                : t('composer.placeholder', { name: answering?.name ?? title })
            }
            working={conversation.working}
            candidates={candidates}
            mentionable={room}
            quote={quote}
            seed={seed}
            onClearQuote={() => setQuote(null)}
            onSend={sendMessage}
            onStop={() => stop.mutate()}
          />
        )}
      </div>
      {info && <InfoDrawer conversation={conversation} detail={detail.data} onClose={() => setInfo(false)} />}
      {screen && answering && (
        <Overlay title={t('chat.computerOf', { name: answering.name })} wide onClose={() => setScreen(null)}>
          <ComputerScreen
            agentId={answering.id}
            control={screen.control}
            onControlChange={(control) => setScreen({ control })}
          />
        </Overlay>
      )}
      {leaving && (
        <ConfirmDialog
          danger
          title={t('chat.leaveTitle', { name: title })}
          confirmLabel={t('chat.leave')}
          onCancel={() => setLeaving(false)}
          onConfirm={() => {
            setLeaving(false);
            memberActions.remove.mutate(me.id, {
              onSuccess: () => navigate('#/c/main', { replace: true }),
              onError: failed,
            });
          }}
        >
          {t('chat.leaveBody')}
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title={t('chat.deleteTitle', { name: conversation.title || t('chat.untitled') })}
          confirmLabel={t('row.delete')}
          onCancel={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            remove.mutate(conversation.id, { onSuccess: () => navigate('#/c/main', { replace: true }) });
          }}
        >
          {t('chat.deleteBody')}
        </ConfirmDialog>
      )}
    </Page>
  );
}

function PageSkeleton() {
  return (
    <Page header={<PageHeader title="" />} width="reading">
      <Skeleton lines={6} />
    </Page>
  );
}
