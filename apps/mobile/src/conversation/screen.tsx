import { stopReading } from '../voice/read-aloud';
import { WriteReceipt } from './write-receipt';
import { MailCard } from '../mail/card';
/**
 * A conversation (PRD §7.1): the main thread, an Agent thread, a chat or a room — one screen on
 * the home route (`?c=`), inside the drawer.
 *
 *  - Chrome (./header.tsx): ☰, the title view (the Agent or the room's people, a status line),
 *    🖥, 🔔 with the one badge, ⋯.
 *  - Transcript: messages oldest first (../store/threads.ts), each row memoised on its message
 *    (../chat/message.tsx) — a reply being written re-renders only itself through its stream.
 *    The 「需要你」 cards of a run sit under its reply; cards of no shown run come last. A long
 *    conversation that has been summarised says so at the top. Older pages load near the top,
 *    keeping the reading position (maintainVisibleContentPosition only while a page lands).
 *  - Composer (../chat/composer.tsx + ./use-composer.ts): text, files, a quote, `@` in a room,
 *    `/` skills with their fields. While an Agent answers an empty composer stops it; anything
 *    typed is queued ("Queued"). Editing my last message takes it into the composer.
 *  - Scrolling (../chat/use-turn-anchor.ts): opening lands on the end; every send is anchored —
 *    the keyboard goes down, my message slides under the bar and the reply unfolds below it; the
 *    view never chases the stream ("Jump to latest" when the end is out of view).
 *  - Reading marks it read (once per new message, while it is on screen in the foreground) and
 *    clears its banners.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Keyboard,
  Platform,
  Share,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useIsFocused, useNavigation, useRouter } from 'expo-router';
import { DrawerActions } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeOut, useSharedValue } from 'react-native-reanimated';
import { KeyboardChatScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
import * as Clipboard from 'expo-clipboard';
import {
  deleteConversation,
  editMessage,
  exportConversation,
  markRead,
  rateMessage,
  regenerateMessage,
  removeMember,
  sendMessage,
  stopConversation,
  updateConversation,
} from '../api/conversations';
import { badgeOf } from '../data/directory';
import { editableId, placeRequests, regenerableId, startsGroup } from '../data/thread';
import { readStream } from '../data/streams';
import { Composer, ReadOnlyBar } from '../chat/composer';
import { useComposerBridge } from '../chat/composer-bridge';
import { MAX_FILES } from '../chat/composer-files';
import { AgentReply, EventLine, MemberMessage, type MessageAction } from '../chat/message';
import { excerpt, plainText } from '../chat/text';
import { useTurnAnchor } from '../chat/use-turn-anchor';
import { putHandoff } from '../lib/handoff';
import { t as tNow, useT } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import { clearConversationBanners } from '../push/banners';
import { RequestCard } from '../requests/request-card';
import type { Conversation, Me, MessageItem, NeedsYou, Skill } from '../shared/contract';
import { shareTextFile } from '../lib/share-file';
import { openMainThread, openNewChat } from '../shell/nav';
import { useAuth } from '../store/auth';
import { useSkillsFor } from '../store/skills';
import { useThreads } from '../store/threads';
import { useWorkspace } from '../store/workspace';
import { makeStyles, space, typo, useTheme } from '../theme';
import { NativeButton } from '../ui/button';
import { alertError, confirmAction, promptText } from '../ui/dialogs';
import { EmptyState, LoadingState } from '../ui/empty';
import { useHeaderInset } from '../ui/header-inset';
import { toast } from '../ui/toast';
import { EditingBar, PickerStrip, SkillFields, type CandidateFace } from './composer-accessory';
import { ConversationHeader, type HeaderModel, type MenuAction } from './header';
import type { MentionCandidate } from './picker';
import { useComposer } from './use-composer';
import { useLookup } from './use-lookup';

/** Older pages load by themselves within this distance of the top. */
const OLDER_THRESHOLD = 400;
const MVCP = { minIndexForVisible: 1 } as const;
const NO_SKILLS: Skill[] = [];
const NO_CANDIDATES: MentionCandidate[] = [];

interface ConversationScreenProps {
  conversationId: string;
  title: string;
  /** A card to scroll to and highlight (a push, a deep link). */
  request: string;
  compose: boolean;
  onRequestSeen: () => void;
}

export function ConversationScreen(props: ConversationScreenProps) {
  const me = useAuth((s) => s.user);
  return me ? <MemberConversationScreen key={me.id} {...props} me={me} /> : null;
}

function MemberConversationScreen({
  conversationId: id,
  title: placeholderTitle,
  request: linkedRequest,
  compose,
  onRequestSeen,
  me,
}: ConversationScreenProps & { me: Me }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderInset();
  const focused = useIsFocused();
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') stopReading();
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!focused) stopReading();
    return stopReading;
  }, [focused, id]);
  /* ---------- data ---------- */
  const listed = useWorkspace((s) => s.conversations?.find((item) => item.id === id));
  const agents = useWorkspace((s) => s.agents);
  const publicAgents = useWorkspace((s) => s.publicAgents);
  const summary = useWorkspace((s) => s.summary);
  const thread = useThreads((s) => s.threads[id]);
  const detail = thread?.detail ?? null;
  // The list row carries the live flags (working, unread); the detail adds members and the digest.
  const conversation: Conversation | null = listed ?? detail;
  const kind = conversation?.kind ?? 'chat';
  const room = kind === 'room';
  const messages = thread?.messages ?? EMPTY_MESSAGES;
  const lookup = useLookup({ me, agents, publicAgents, members: thread?.members });
  const answering = lookup.agent(conversation?.agent_id);

  useEffect(() => {
    void useThreads.getState().open(id);
  }, [id]);
  useEffect(() => {
    if (room) void useThreads.getState().refreshMembers(id);
  }, [id, room]);

  /* ---------- reading marks it read ---------- */
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => sub.remove();
  }, []);
  const lastSeq = conversation?.last_seq ?? 0;
  const readSeq = conversation?.last_read_seq ?? 0;
  const marking = useRef(0);
  useEffect(() => {
    if (!focused || !active || lastSeq <= readSeq || marking.current >= lastSeq) return;
    const timer = setTimeout(() => {
      marking.current = lastSeq;
      useWorkspace.getState().patchConversation(id, { last_read_seq: lastSeq, unread: 0 });
      void markRead(id, lastSeq).then(() => void useWorkspace.getState().refreshSummary());
    }, 400);
    return () => clearTimeout(timer);
  }, [id, focused, active, lastSeq, readSeq]);
  useEffect(() => {
    if (focused && active) void clearConversationBanners(id);
  }, [id, focused, active]);

  /* ---------- the composer ---------- */
  const skills = useSkillsFor(answering?.is_main ? 'main' : (conversation?.agent_id ?? 'main'), !room) ?? NO_SKILLS;
  const candidates = useMemo<MentionCandidate[]>(() => {
    if (!room || !thread?.members) return NO_CANDIDATES;
    return [
      ...thread.members.agents
        .filter((agent) => agent.owner_id === me.id)
        .map((agent) => ({ handle: `agent:${agent.id}`, name: agent.name, hint: agent.role })),
      ...thread.members.members.map((person) => ({ handle: person.id, name: person.name, hint: person.email })),
    ];
  }, [room, thread?.members, me.id]);
  const faces = useCallback(
    (handle: string): CandidateFace | undefined => {
      if (handle.startsWith('agent:')) {
        const agent = lookup.agent(handle.slice(6));
        return agent ? { agent } : undefined;
      }
      const person = lookup.person(handle);
      return person ? { person } : undefined;
    },
    [lookup],
  );
  const composer = useComposer({ conversationId: id, candidates, mentionMode: room ? 'mention' : 'off', skills });
  const [editing, setEditing] = useState<MessageItem | null>(null);
  const [sending, setSending] = useState(false);
  const readOnly = !!conversation?.read_only;
  const working = !!conversation?.working;

  // Sheets hand text back through the bridge: a source's 「就此追问」, an html page's sendPrompt.
  const bridgedQuote = useComposerBridge((s) => s.quote);
  const bridgedDrafts = useComposerBridge((s) => s.drafts.length);
  const { setQuote, setValue, focus } = composer;
  useEffect(() => {
    if (bridgedQuote === null || !focused) return;
    const text = useComposerBridge.getState().takeQuote();
    if (readOnly || text === null) return;
    setQuote({ message_id: '', text });
    focus();
  }, [bridgedQuote, focused, readOnly, setQuote, focus]);
  useEffect(() => {
    if (!bridgedDrafts || !focused) return;
    const texts = useComposerBridge.getState().takeDrafts();
    if (readOnly) return;
    setValue((current) => [current.trim() ? current : '', ...texts].filter(Boolean).join('\n'));
    focus();
  }, [bridgedDrafts, focused, readOnly, setValue, focus]);
  useEffect(() => {
    if (compose && !readOnly) focus();
  }, [compose, readOnly, focus]);

  /* ---------- layout ---------- */
  const [composerH, setComposerH] = useState(60);
  const composerBottom = Math.max(insets.bottom, space.md) + (Platform.OS === 'android' ? space.sm : 0);
  const extraPad = useSharedValue(60 + composerBottom + space.md);
  const onComposerHeight = useCallback(
    (h: number) => {
      setComposerH(h);
      extraPad.value = h + composerBottom + space.md;
    },
    [extraPad, composerBottom],
  );
  const stickyOffset = useMemo(() => ({ closed: 0, opened: insets.bottom - space.sm }), [insets.bottom]);
  const topPad = headerHeight + space.sm;

  /* ---------- scrolling ---------- */
  const anchor = useTurnAnchor({ topPad, bottomInset: () => composerH + composerBottom + space.md });
  const {
    scrollRef,
    blankSpace,
    endVisible,
    onEndVisible,
    onViewport,
    onContentSize: anchorContentSize,
    onScroll: anchorScroll,
    onDragStart,
    onAnchorRowLayout,
    anchorNext,
    holdForTurn,
    cancelTurn,
    jumpToLatest,
    shift,
  } = anchor;
  const anchorId = useRef<string | null>(null);
  const rowY = useRef(new Map<string, number>());
  /** Every row's box: a sent message's row may lay out (its realtime copy) before the send answers. */
  const rowBox = useRef(new Map<string, { y: number; height: number }>());
  const onRowLayout = useCallback(
    (rowId: string, e: LayoutChangeEvent) => {
      const { y, height } = e.nativeEvent.layout;
      rowY.current.set(rowId, y);
      rowBox.current.set(rowId, { y, height });
      if (rowId === anchorId.current) onAnchorRowLayout(rowId, e);
    },
    [onAnchorRowLayout],
  );
  /** Anchor the next turn to this message's row (now, when it is already laid out). */
  const anchorTurn = useCallback(
    (rowId: string) => {
      anchorId.current = rowId;
      anchorNext(rowId, rowBox.current.get(rowId));
    },
    [anchorNext],
  );

  // Older pages: hold the reading position while one lands.
  const [mvcp, setMvcp] = useState(false);
  const prepend = useRef<{ height: number; first: string | null } | null>(null);
  const contentH = useRef(0);
  const firstId = messages[0]?.id ?? null;
  const dragged = useRef(false);
  const loadOlder = useCallback(() => {
    const entry = useThreads.getState().threads[id];
    if (!entry?.older || entry.loadingOlder || prepend.current) return;
    prepend.current = { height: contentH.current, first: entry.messages[0]?.id ?? null };
    setMvcp(true);
    void useThreads.getState().loadOlder(id);
  }, [id]);
  useEffect(() => {
    const p = prepend.current;
    if (!p || thread?.loadingOlder) return;
    if (firstId === p.first) {
      // Nothing older came back: release the hold.
      prepend.current = null;
      setMvcp(false);
    }
  }, [thread?.loadingOlder, firstId]);
  const onContentSize = useCallback(
    (w: number, h: number) => {
      const p = prepend.current;
      if (p && firstId !== p.first) {
        prepend.current = null;
        shift(h - p.height);
        requestAnimationFrame(() => setMvcp(false));
      }
      contentH.current = h;
      anchorContentSize(w, h);
    },
    [anchorContentSize, shift, firstId],
  );
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      anchorScroll(e);
      if (dragged.current && e.nativeEvent.contentOffset.y < OLDER_THRESHOLD) loadOlder();
    },
    [anchorScroll, loadOlder],
  );
  const onScrollBegin = useCallback(() => {
    dragged.current = true;
    onDragStart();
  }, [onDragStart]);

  // A linked card: scroll to it once it is laid out, and highlight it for a moment.
  const [highlighted, setHighlighted] = useState<string | null>(null);
  useEffect(() => {
    if (!linkedRequest || thread?.status !== 'ready') return;
    const timer = setTimeout(() => {
      const y = rowY.current.get(`request:${linkedRequest}`) ?? rowY.current.get(`run-of:${linkedRequest}`);
      if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, y - topPad), animated: true });
      setHighlighted(linkedRequest);
      onRequestSeen();
    }, 400);
    return () => clearTimeout(timer);
  }, [linkedRequest, thread?.status, scrollRef, topPad, onRequestSeen]);
  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(() => setHighlighted(null), 1600);
    return () => clearTimeout(timer);
  }, [highlighted]);

  /* ---------- sending ---------- */
  const take = composer.take;
  const restore = composer.restore;
  const build = composer.build;
  const send = useCallback(async () => {
    if (sending) return;
    const built = build();
    if (!built) return;
    if ('tooManyFiles' in built) {
      alertError(t('composer.maxFiles', { n: MAX_FILES }));
      return;
    }
    if ('missing' in built) {
      alertError(t('composer.required', { name: built.missing }));
      return;
    }
    const draft = take();
    setSending(true);
    holdForTurn();
    Keyboard.dismiss();
    if (editing) {
      const edited = await editMessage(id, editing.id, built.input.content);
      setSending(false);
      if (!edited.ok) {
        cancelTurn();
        restore(draft);
        alertError(t('conversation.editFailed'), edited.message || undefined);
        return;
      }
      setEditing(null);
      useThreads.getState().dropMessages(id, edited.data.deleted_message_ids);
      useThreads.getState().addMessages(id, [edited.data.message]);
      anchorTurn(edited.data.message.id);
      return;
    }
    const result = await sendMessage(id, built.input);
    setSending(false);
    if (!result.ok) {
      cancelTurn();
      restore(draft);
      alertError(t('conversation.sendFailed'), result.message || undefined);
      return;
    }
    useThreads.getState().addMessages(id, [result.data.message]);
    anchorTurn(result.data.message.id);
    if (result.data.queued) toast(t('conversation.queued'), 'clock');
  }, [sending, build, take, restore, holdForTurn, cancelTurn, anchorTurn, editing, id, t]);

  /** A follow-up from a block in a reply (a ```confirm pick, an answer). */
  const reply = useCallback(
    async (text: string) => {
      holdForTurn();
      Keyboard.dismiss();
      const result = await sendMessage(id, { content: text });
      if (!result.ok) {
        cancelTurn();
        alertError(t('conversation.sendFailed'), result.message || undefined);
        return false;
      }
      useThreads.getState().addMessages(id, [result.data.message]);
      anchorTurn(result.data.message.id);
      return true;
    },
    [id, holdForTurn, cancelTurn, anchorTurn, t],
  );

  const stop = useCallback(() => {
    void stopConversation(id).then((result) => {
      if (!result.ok) alertError(t('conversation.stopFailed'), result.message || undefined);
    });
  }, [id, t]);

  /* ---------- message actions ---------- */
  const latest = useRef({ messages, working, conversation });
  latest.current = { messages, working, conversation };
  const onAction = useCallback(
    async (message: MessageItem, action: MessageAction) => {
      const text = message.role === 'assistant' ? (readStream(message.id)?.text ?? message.content) : message.content;
      switch (action) {
        case 'copy':
          await Clipboard.setStringAsync(text).catch(() => {});
          toast(tNow('common.copied'), 'copy');
          return;
        case 'share':
          void Share.share({ message: text });
          return;
        case 'quote':
          setQuote({ message_id: message.id, text: excerpt(plainText(text), 2000) });
          focus();
          return;
        case 'edit':
          if (latest.current.working) {
            alertError(tNow('conversation.stopFirst'));
            return;
          }
          setEditing(message);
          setValue(message.content);
          focus();
          return;
        case 'regenerate': {
          if (latest.current.working) {
            alertError(tNow('conversation.stopFirst'));
            return;
          }
          const result = await regenerateMessage(id, message.id);
          if (!result.ok) alertError(tNow('conversation.regenerateFailed'), result.message || undefined);
          else useThreads.getState().dropMessages(id, result.data.deleted_message_ids);
          return;
        }
        case 'rateUp':
        case 'rateDown': {
          const rating = action === 'rateUp' ? 1 : -1;
          const next = message.my_rating === rating ? 0 : rating;
          useThreads.getState().patchMessage(id, message.id, { my_rating: next === 0 ? null : next });
          const result = await rateMessage(id, message.id, { rating: next });
          if (!result.ok) {
            useThreads.getState().patchMessage(id, message.id, { my_rating: message.my_rating });
            alertError(tNow('conversation.rateFailed'));
          } else if (next !== 0) toast(tNow('conversation.thanks'), next === 1 ? 'thumbUp' : 'thumbDown');
          return;
        }
        case 'newChat':
          openNewChat(router, {
            agent: latest.current.conversation?.agent_id ?? undefined,
            compose: true,
          });
          return;
      }
    },
    [id, router, setQuote, setValue, focus],
  );
  const onOpenSteps = useCallback(
    (message: MessageItem) => router.push({ pathname: '/peek/steps', params: { c: id, m: message.id } }),
    [router, id],
  );
  const onOpenSources = useCallback(
    (message: MessageItem) =>
      router.push({
        pathname: '/peek/sources',
        params: { k: putHandoff('sources', { citations: message.citations, readOnly }) },
      }),
    [router, readOnly],
  );

  /* ---------- the header ---------- */
  const people = useMemo(
    () => [
      ...(thread?.members?.members ?? []).map((person) => ({ name: person.name, avatarUrl: person.avatar_url })),
      ...(thread?.members?.agents ?? []).map((agent) => ({
        name: agent.name,
        avatarUrl: null,
        agent: { id: agent.id, avatar: agent.avatar, template_key: null },
      })),
    ],
    [thread?.members],
  );
  const computers = me.modules.computer && me.capabilities.sandbox;
  const headerModel = useMemo<HeaderModel>(() => {
    const name =
      kind === 'main' || kind === 'direct'
        ? (answering?.name ?? conversation?.title ?? placeholderTitle)
        : conversation?.title ||
          (room ? people.map((p) => p.name).join('、') : '') ||
          placeholderTitle ||
          t('conversation.untitled');
    const status = working
      ? t('conversation.statusWorking')
      : kind === 'main'
        ? t('conversation.mainThread')
        : room
          ? t('conversation.peopleCount', { n: (thread?.members?.members.length ?? detail?.members.length ?? 0) || 1 })
          : (answering?.role ?? '');
    return {
      title: name,
      status,
      agent: room ? null : (answering ?? null),
      avatarReply: messages.findLast((message) => message.role === 'assistant'),
      avatarWorking: working,
      avatarWaiting: (conversation?.pending_requests ?? 0) > 0,
      people,
      kind,
      pinned: !!conversation?.pinned,
      muted: !!conversation?.muted,
      unread: (conversation?.unread ?? 0) > 0,
      computer: computers && !room && !!answering,
      badge: badgeOf(summary),
    };
  }, [
    kind,
    answering,
    conversation,
    placeholderTitle,
    room,
    people,
    t,
    working,
    thread?.members,
    messages,
    detail,
    computers,
    summary,
  ]);

  const openAgentProfile = useCallback(() => {
    const agentId = latest.current.conversation?.agent_id;
    if (agentId) router.push({ pathname: '/agents/[id]', params: { id: agentId } });
  }, [router]);
  const onTitle = useCallback(() => {
    if (room) router.push({ pathname: '/room-people', params: { c: id } });
    else openAgentProfile();
  }, [room, router, id, openAgentProfile]);
  const onMenu = useCallback(
    async (action: MenuAction) => {
      const current = latest.current.conversation;
      if (!current) return;
      const patch = async (input: Parameters<typeof updateConversation>[1], failed: Parameters<typeof tNow>[0]) => {
        useWorkspace.getState().patchConversation(id, input as Partial<Conversation>);
        const result = await updateConversation(id, input);
        if (!result.ok) {
          void useWorkspace.getState().refreshConversations();
          alertError(tNow(failed), result.message || undefined);
          return false;
        }
        return true;
      };
      switch (action) {
        case 'newChat':
          openNewChat(router, { agent: current.agent_id ?? undefined, compose: true });
          return;
        case 'profile':
          openAgentProfile();
          return;
        case 'notes':
          router.push({ pathname: '/notes', params: { c: id } });
          return;
        case 'people':
          router.push({ pathname: '/room-people', params: { c: id } });
          return;
        case 'addPeople':
          router.push({ pathname: '/new-room', params: { room: id } });
          return;
        case 'pin':
        case 'unpin':
          await patch({ pinned: action === 'pin' }, 'row.saveFailed');
          return;
        case 'mute':
        case 'unmute':
          await patch({ muted: action === 'mute' }, 'row.saveFailed');
          return;
        case 'markRead':
          useWorkspace.getState().patchConversation(id, { last_read_seq: current.last_seq, unread: 0 });
          void markRead(id, current.last_seq).then(() => void useWorkspace.getState().refreshSummary());
          return;
        case 'rename': {
          const next = await promptText({
            title: tNow('row.renameTitle'),
            defaultValue: current.title,
            confirmLabel: tNow('common.save'),
          });
          if (next && next !== current.title) await patch({ title: next }, 'row.saveFailed');
          return;
        }
        case 'share': {
          const result = await exportConversation(id);
          if (!result.ok) {
            alertError(tNow('row.exportFailed'));
            return;
          }
          if (!(await shareTextFile(result.data.filename, result.data.markdown, 'text/markdown'))) {
            alertError(tNow('row.exportFailed'));
          }
          return;
        }
        case 'archive':
          if (await patch({ archived: true }, 'row.saveFailed')) {
            toast(tNow('row.archived'), 'archive');
            openMainThread(router);
          }
          return;
        case 'delete': {
          const ok = await confirmAction({
            title: tNow('row.deleteTitle', { name: current.title || tNow('conversation.untitled') }),
            message: tNow('row.deleteHint'),
            confirmLabel: tNow('row.delete'),
            destructive: true,
          });
          if (!ok) return;
          const result = await deleteConversation(id);
          if (!result.ok) {
            alertError(tNow('row.deleteFailed'), result.message || undefined);
            return;
          }
          useWorkspace.getState().dropConversation(id);
          toast(tNow('row.deleted'), 'trash');
          openMainThread(router);
          return;
        }
        case 'leave': {
          const ok = await confirmAction({
            title: tNow('conversation.leaveTitle', { name: current.title || tNow('conversation.untitled') }),
            message: tNow('conversation.leaveHint'),
            confirmLabel: tNow('conversation.leave'),
            destructive: true,
          });
          if (!ok) return;
          const result = await removeMember(id, me.id);
          if (!result.ok) {
            alertError(tNow('conversation.leaveFailed'), result.message || undefined);
            return;
          }
          useWorkspace.getState().dropConversation(id);
          openMainThread(router);
          return;
        }
      }
    },
    [id, router, openAgentProfile, me.id],
  );
  const onDrawer = useCallback(() => navigation.dispatch(DrawerActions.openDrawer()), [navigation]);
  const onComputer = useCallback(() => {
    const agentId = latest.current.conversation?.agent_id;
    if (agentId) router.push({ pathname: '/computer', params: { agent: agentId } });
  }, [router]);
  const onNotifications = useCallback(() => router.push('/notifications'), [router]);

  /* ---------- rows ---------- */
  const requests = thread?.requests ?? EMPTY_REQUESTS;
  const placed = useMemo(() => placeRequests(requests, messages), [requests, messages]);
  const canEdit = editableId(messages, me.id);
  const canRegenerate = regenerableId(messages, me.id);
  // what I wrote next after each reply (a rich block marks the choice I made), in one backward pass
  const followUps = useMemo(() => {
    const out = new Map<string, string>();
    let next: string | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === 'user' && message.author_member_id === me.id) next = message.content;
      else if (message.role === 'assistant' && next !== undefined) out.set(message.id, next);
    }
    return out;
  }, [messages, me.id]);

  const rows = messages.map((message, index) => {
    const previous = messages[index - 1];
    const showAuthor = startsGroup(message, previous);
    if (message.role === 'event')
      return message.event?.type === 'write_receipt' ? (
        <WriteReceipt key={message.id} message={message} />
      ) : message.event?.type === 'mail' ? (
        <MailCard key={message.id} message={message} />
      ) : (
        <EventLine key={message.id} text={message.content} />
      );
    if (message.role === 'user') {
      const mine = message.author_member_id === me.id;
      const author = lookup.person(message.author_member_id) ?? { name: t('conversation.someone'), avatarUrl: null };
      const next = messages[index + 1];
      const endOfRun = !next || next.role !== 'user' || next.author_member_id !== message.author_member_id;
      const readBy =
        room && mine
          ? (thread?.members?.members ?? [])
              .filter((person) => person.id !== me.id && person.last_read_seq >= message.seq)
              .map((person) => person.name)
          : undefined;
      return (
        <View key={message.id} onLayout={(e) => onRowLayout(message.id, e)}>
          <MemberMessage
            message={message}
            mine={mine}
            author={author}
            showAuthor={showAuthor}
            time={mine && !endOfRun && !message.edited_at ? '' : relativeTimeNow(message.created_at)}
            readBy={readBy}
            editable={!readOnly && message.id === canEdit}
            skillName={message.skill ? skills.find((skill) => skill.id === message.skill!.skill_id)?.name : undefined}
            onAction={onAction}
          />
        </View>
      );
    }
    const agent = lookup.agent(message.agent_id);
    const cards = message.run_id ? placed.byRun.get(message.run_id) : undefined;
    const followUp = followUps.get(message.id);
    return (
      <View
        key={message.id}
        onLayout={(e) => {
          onRowLayout(message.id, e);
          for (const card of cards ?? []) rowY.current.set(`run-of:${card.id}`, e.nativeEvent.layout.y);
        }}
      >
        <AgentReply
          message={message}
          author={{ name: agent?.name ?? t('conversation.anAgent'), agent: agent ?? null }}
          showAuthor={room && showAuthor}
          time={showAuthor ? relativeTimeNow(message.created_at) : ''}
          canRegenerate={message.id === canRegenerate}
          readOnly={readOnly}
          followUp={followUp}
          waiting={cards?.some((request) => request.status === 'pending')}
          cards={
            cards?.length ? (
              <View style={styles.cards}>
                {cards.map((request) => (
                  <RequestCard key={request.id} request={request} highlighted={highlighted === request.id} />
                ))}
              </View>
            ) : undefined
          }
          onAction={onAction}
          onReply={reply}
          onOpenSteps={onOpenSteps}
          onOpenSources={onOpenSources}
        />
      </View>
    );
  });

  const loading = !thread || (thread.status === 'loading' && !messages.length);
  const failed = thread?.status === 'error' && !messages.length;
  const digest = detail?.digest;

  /* ---------- the composer's accessory ---------- */
  const accessory = editing ? (
    <EditingBar
      onCancel={() => {
        setEditing(null);
        composer.take();
      }}
    />
  ) : composer.picker.length ? (
    <PickerStrip entries={composer.picker} faces={faces} onPick={composer.pick} />
  ) : composer.skill?.variables.length ? (
    <SkillFields
      skill={composer.skill}
      values={composer.fields}
      onChange={composer.setField}
      onSubmit={() => void send()}
    />
  ) : null;
  const menuExtra = useMemo(
    () =>
      room || skills.length
        ? {
            items: [
              ...(room ? [{ id: 'mention', title: tNow('composer.mention'), icon: 'at' as const }] : []),
              ...(skills.length ? [{ id: 'skills', title: tNow('composer.skills'), icon: 'wand' as const }] : []),
            ],
            onSelect: (choice: string) => (choice === 'mention' ? composer.startMention() : composer.startSkill()),
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the starters are stable callbacks of the composer
    [room, skills.length, composer.startMention, composer.startSkill],
  );

  const placeholder = room
    ? t('composer.placeholderRoom')
    : t('composer.placeholder', { name: answering?.name ?? t('conversation.anAgent') });

  return (
    <View style={styles.root}>
      <ConversationHeader
        model={headerModel}
        onDrawer={onDrawer}
        onTitle={onTitle}
        onComputer={onComputer}
        onNotifications={onNotifications}
        onMenu={(action) => void onMenu(action)}
      />

      <KeyboardChatScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingTop: topPad }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        keyboardLiftBehavior="persistent"
        offset={insets.bottom}
        extraContentPadding={extraPad}
        blankSpace={blankSpace}
        maintainVisibleContentPosition={mvcp ? MVCP : undefined}
        onLayout={onViewport}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onScrollBeginDrag={onScrollBegin}
        onEndVisible={onEndVisible}
        onContentSizeChange={onContentSize}
      >
        {thread?.older ? (
          <View style={styles.older}>
            {thread.loadingOlder ? (
              <LoadingState style={styles.olderSpinner} />
            ) : (
              <NativeButton label={t('conversation.loadOlder')} size="small" variant="glass" onPress={loadOlder} />
            )}
          </View>
        ) : null}
        {digest ? (
          <Text style={styles.digest} accessibilityRole="text">
            {t('conversation.summarised')}
          </Text>
        ) : null}
        {rows}
        {placed.loose.map((request) => (
          <View
            key={request.id}
            style={styles.looseCard}
            onLayout={(e) => rowY.current.set(`request:${request.id}`, e.nativeEvent.layout.y)}
          >
            <RequestCard request={request} inset highlighted={highlighted === request.id} />
          </View>
        ))}
      </KeyboardChatScrollView>

      {loading ? (
        <LoadingState style={[styles.center, { top: headerHeight, bottom: composerH + composerBottom }]} />
      ) : null}
      {failed ? (
        <View style={[styles.center, { top: headerHeight, bottom: composerH + composerBottom }]}>
          <EmptyState
            icon="alert"
            title={t('conversation.loadFailed')}
            onRetry={() => void useThreads.getState().open(id)}
            style={styles.stretch}
          />
        </View>
      ) : null}

      {/* floating control layer: jump-to-latest + composer, riding the keyboard */}
      <KeyboardStickyView offset={stickyOffset} style={styles.sticky}>
        {!endVisible && messages.length && !loading ? (
          <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(140)} style={styles.jumpWrap}>
            <NativeButton
              label={working ? t('conversation.newContent') : t('conversation.jumpToLatest')}
              icon="arrowDown"
              variant="glass"
              size="small"
              onPress={jumpToLatest}
            />
          </Animated.View>
        ) : null}
        <View
          style={[{ paddingBottom: composerBottom }, Platform.OS === 'android' && { backgroundColor: c.background }]}
        >
          {readOnly ? (
            <ReadOnlyBar
              onHeight={onComposerHeight}
              message={t('conversation.readOnly')}
              action={{ label: t('conversation.newChat'), onPress: () => openNewChat(router) }}
            />
          ) : (
            <Composer
              ref={composer.inputRef}
              value={composer.value}
              onChangeText={composer.setValue}
              onSend={() => void send()}
              working={working && !editing}
              onStop={stop}
              sending={sending}
              onAttach={(from) => void composer.attach(from)}
              quote={composer.quote?.text ?? null}
              onClearQuote={() => composer.setQuote(null)}
              files={composer.files}
              onRemoveFile={composer.removeFile}
              onRetryFiles={composer.retryFiles}
              skill={
                composer.skill
                  ? `/${composer.skill.name}${composer.skill.display_name ? ` · ${composer.skill.display_name}` : ''}`
                  : null
              }
              onClearSkill={composer.clearSkill}
              placeholder={placeholder}
              autoFocus={compose}
              onHeight={onComposerHeight}
              accessory={accessory}
              onSelectionChange={composer.onSelectionChange}
              menuExtra={editing ? undefined : menuExtra}
              attachNote={editing ? t('composer.noFilesWhileEditing') : undefined}
            />
          )}
        </View>
      </KeyboardStickyView>
    </View>
  );
}

const EMPTY_MESSAGES: MessageItem[] = [];
const EMPTY_REQUESTS: NeedsYou[] = [];

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  scroll: { flex: 1 },
  older: { alignItems: 'center', paddingVertical: space.md },
  olderSpinner: { flexGrow: 0 },
  digest: {
    ...typo.footnote,
    color: c.tertiaryLabel,
    textAlign: 'center',
    paddingHorizontal: space.xxl,
    paddingBottom: space.md,
  },
  cards: { gap: space.sm, alignSelf: 'stretch' },
  looseCard: { paddingBottom: space.md },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  stretch: { alignSelf: 'stretch' },
  sticky: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  jumpWrap: { position: 'absolute', bottom: '100%', alignSelf: 'center', paddingBottom: space.xs },
}));
