/**
 * One conversation with the assistant (`/chat?session=`), the one object that is a full pushed
 * page — the keyboard stays up and the transcript is long. Without `session` it is a new
 * conversation: it is made the first time something is sent or a file is attached. Home hands
 * its first message over (`k`, src/lib/handoff.ts) and it is sent as the page opens; `draft` fills
 * the composer (ask the assistant about a document or file).
 *
 * The behaviour lives in src/data/conversation.ts (latest messages first, older ones as you
 * scroll up, my message and the streaming reply until the saved transcript holds them, following
 * a reply still being written, my words back when a send is refused). The latest page and the
 * title are kept on the phone (src/store/chat-copies.ts): the conversation opens at once and reads
 * offline. A message sent while the station cannot be reached waits in the outbox
 * (src/store/outbox.ts) and goes from here once it can. Everything belongs to the station and
 * account that opened the conversation.
 *
 * Chrome: the title carries Sprouty's living face, which glides below the title while a reply is
 * written (src/chat/header-avatar.tsx); on the right a new-conversation button and the ⋯ menu
 * (Pin / Unpin, Rename, Delete). The list rides the keyboard (KeyboardChatScrollView adds the
 * keyboard to the scroll view's bottom inset, so the end is reachable with it up) and follows
 * the end only while the member is there; scrolled up during a reply, a ↓ button jumps back.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FlatList, Text, View, type ScrollView, type TextInput } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chatRun, createSession, getMessages, getSessionInfo, stopRun } from '../src/api/assistant';
import { HeaderTitle, TalkingAvatar, TalkingBand, TalkingRoom, useTalking } from '../src/chat/header-avatar';
import { useStepsSheet } from '../src/chat/steps-sheet';
import type { ApiResult } from '../src/api/client';
import { Composer } from '../src/chat/composer';
import { sentParts } from '../src/chat/composer-files';
import { AssistantReply, UserMessage } from '../src/chat/messages';
import {
  attachmentsFence,
  messageImages,
  pipelineSteps,
  splitAttachments,
  type AttachedFile,
  type ToolStep,
} from '../src/chat/parts';
import { sendDirect } from '../src/chat/direct-send';
import { followRun, regenerateReply, sendMessage } from '../src/chat/send';
import { useComposerBridge } from '../src/chat/composer-bridge';
import { useComposerFiles } from '../src/chat/use-composer-files';
import { visibleMessages } from '../src/data/chat-stream';
import {
  CLOSED_CONVERSATION,
  Conversation,
  headOf,
  tailOf,
  type ConversationState,
  type SentImage,
} from '../src/data/conversation';
import { atEnd, shouldFollowEnd } from '../src/data/follow-end';
import { captureIdentity } from '../src/data/identity';
import { newTurnId } from '../src/data/outbox';
import type { MessagePage } from '../src/data/transcript';
import { getHandoff } from '../src/lib/handoff';
import { useT } from '../src/lib/i18n';
import type { ChatMessage } from '../src/shared/greenhouse-types';
import { readChatCopy, saveChatCopy } from '../src/store/chat-copies';
import { claimConversation, deliverQueued, queueTurn, unqueueTurn, useOutbox } from '../src/store/outbox';
import { HIT, makeStyles, motion, space, typo, useTheme } from '../src/theme';
import { alertError, confirmAction, promptText } from '../src/ui/dialogs';
import { EmptyState } from '../src/ui/empty';
import { usePlantWorkState } from '../src/ui/plant-avatar/use-plant-work';
import { Spinner } from '../src/ui/core';
import { GlassIconButton } from '../src/ui/glass';
import { notifySuccess, notifyWarning } from '../src/ui/haptics';
import { toast } from '../src/ui/toast';
import { toolbarIcon } from '../src/ui/toolbar-icon';
import { useHeaderInset } from '../src/ui/header-inset';
import { OpenOrigin } from '../src/shell/open-object';
import { useSessions } from '../src/store/sessions';
import { forgetChatCopy } from '../src/store/chat-copies';

/** What home hands over for the first message of a conversation it made. */
export interface FirstTurn {
  text: string;
  images: SentImage[];
  attachments: AttachedFile[];
}

type Item =
  | { key: string; kind: 'message'; message: ChatMessage; index: number }
  | { key: string; kind: 'pending'; text: string; images: readonly SentImage[] }
  | { key: string; kind: 'reply' }
  | { key: string; kind: 'queued'; id: string; text: string; images: SentImage[]; failed: boolean };

/** The list's native scroll view (its own scrollToEnd counts padding and the keyboard inset). */
const scrollRef = (list: FlatList<Item> | null) => list?.getNativeScrollRef() as ScrollView | null | undefined;

const noSubscription = () => () => {};
const KEEP_PLACE = { minIndexForVisible: 0 };
const closed = (): ConversationState<ChatMessage> => CLOSED_CONVERSATION;

export default function Chat() {
  const params = useLocalSearchParams<{ session?: string; k?: string; draft?: string }>();
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const insets = useSafeAreaInsets();
  const [sessionId, setSessionId] = useState<string | null>(
    params.session && /^[A-Za-z0-9_-]{1,128}$/.test(params.session) ? params.session : null,
  );
  const [draft, setDraft] = useState(params.draft ?? '');
  const [composerHeight, setComposerHeight] = useState(64);
  const [offline, setOffline] = useState(false);
  const input = useRef<TextInput>(null);
  const list = useRef<FlatList<Item>>(null);
  const viewport = useRef(0);
  // the keyboard covers the bottom of the list (the composer rides above it): the list's end
  // must sit above it too, so its height joins the bottom padding (it already covers the safe area)
  const keyboard = useKeyboardState((k) => (k.isVisible ? k.height : 0));
  const keyboardRoom = Math.max(0, keyboard - insets.bottom);
  const headerInset = useHeaderInset();
  const pinned = useRef(true);
  /** The member's finger (or its momentum) is moving the list. */
  const dragging = useRef(false);
  /** Scrolled away from the end (shows the ↓ button). */
  const [away, setAway] = useState(false);
  const [rootOrigin, setRootOrigin] = useState({ x: 0, y: 0 });
  const root = useRef<View>(null);
  const shape = useRef({ head: '', tail: '' });
  const firstTurn = useRef<FirstTurn | null>(getHandoff<FirstTurn>(params.k, 'first-turn') ?? null);

  // a new conversation is made once, the first time it is needed (send, attach)
  const making = useRef<Promise<string | null> | null>(null);
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    making.current ??= (async () => {
      const current = captureIdentity();
      const made = await createSession();
      if (!current()) return null;
      if (!made.ok) {
        making.current = null;
        if (made.status !== 0) alertError(t('assistant.sendFailed'), made.message || undefined);
        return null;
      }
      setSessionId(made.data.id);
      router.setParams({ session: made.data.id, draft: undefined });
      return made.data.id;
    })();
    return making.current;
  }, [sessionId, router, t]);

  const conversation = useMemo(() => {
    if (!sessionId) return null;
    return new Conversation<ChatMessage>({
      title: async () => {
        const result = await getSessionInfo(sessionId);
        if (result.ok) return { ok: true, data: { title: result.data.session.title } };
        if (result.status === 0) {
          const copy = await readChatCopy(sessionId);
          if (copy) return { ok: true, data: { title: copy.title } };
        }
        return result;
      },
      latestPage: async (): Promise<ApiResult<MessagePage<ChatMessage>>> => {
        const result = await getMessages(sessionId);
        if (result.ok) {
          setOffline(false);
          void saveChatCopy(sessionId, { title: conversationTitle.current, page: result.data });
          return result;
        }
        if (result.status === 0) {
          const copy = await readChatCopy(sessionId);
          if (copy) {
            setOffline(true);
            return { ok: true, data: copy.page };
          }
        }
        return result;
      },
      olderPage: (before) => getMessages(sessionId, before),
      send: (text, onEvent, signal, images, clientTurnId) =>
        sendMessage(sessionId, text.slice(0, 20_000), onEvent, signal, images, clientTurnId),
      runActive: async () => {
        const result = await chatRun(sessionId);
        return result.ok ? { ok: true, data: { active: result.data.active } } : result;
      },
      follow: (onEvent, signal) => followRun(sessionId, onEvent, signal),
      regenerate: (messageId, onEvent, signal) => regenerateReply(sessionId, messageId, onEvent, signal),
      stillCurrent: captureIdentity(),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  }, [sessionId]);
  const state = useSyncExternalStore(conversation?.subscribe ?? noSubscription, conversation?.getState ?? closed);
  const conversationTitle = useRef<string | null>(null);
  conversationTitle.current = state.title;

  // this screen sends this conversation's queued messages itself, so their replies stream here
  useEffect(() => (sessionId ? claimConversation(sessionId) : undefined), [sessionId]);
  const outbox = useOutbox((s) => s.items);
  const queued = useMemo(() => outbox.filter((item) => item.sessionId === sessionId), [outbox, sessionId]);

  const send = useCallback(
    async (text: string, images: readonly SentImage[]): Promise<boolean> => {
      if (!conversation) return false;
      pinned.current = true;
      return sendDirect(
        {
          send: (turnId) => conversation.send(text, images, turnId),
          stillCurrent: captureIdentity(),
          sessionId,
          text,
          images,
          turnId: newTurnId(),
        },
        {
          queue: (turn) => queueTurn(turn),
          setOffline: () => setOffline(true),
          // my words come back to the box whatever refused them (or when the outbox is full)
          restoreDraft: (words) => setDraft((now) => now || words),
          alert: (why, message) =>
            alertError(
              why === 'full'
                ? t('conversation.outboxFull')
                : why === 'busy'
                  ? t('assistant.busy')
                  : t('assistant.sendFailed'),
              message,
            ),
        },
      );
    },
    [conversation, sessionId, t],
  );

  /** A queued message goes through the outbox (one sender at a time; it leaves once accepted). */
  const sendQueued = useCallback(
    async (id: string, manual = false) => {
      if (!conversation) return;
      pinned.current = true;
      const delivery = await deliverQueued(
        id,
        async (turn) => {
          const result = await conversation.send(turn.text, turn.images, turn.id);
          return result.sent
            ? { ok: true }
            : { ok: false, status: result.status, code: result.code, message: result.message };
        },
        { manual },
      );
      if (delivery === 'unknown') setOffline(true);
      if (delivery === 'rejected') {
        const error = useOutbox.getState().items.find((item) => item.id === id)?.error;
        alertError(t('assistant.sendFailed'), error || undefined);
      }
    },
    [conversation, t],
  );

  useEffect(() => {
    if (!conversation) return;
    let alive = true;
    void conversation.open().then(() => {
      // home's first message goes once the conversation is open
      const turn = firstTurn.current;
      if (!alive || !turn) return;
      firstTurn.current = null;
      const content = [turn.text.trim(), attachmentsFence(turn.attachments)].filter(Boolean).join('\n\n');
      void send(content, turn.images);
    });
    return () => {
      alive = false;
      conversation.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once per conversation
  }, [conversation]);

  // back in view (not the first focus): catch up with a reply written meanwhile, send what waits
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!focusedOnce.current) {
        focusedOnce.current = true;
        return;
      }
      void conversation?.refocus();
    }, [conversation]),
  );
  // what waits goes once the station answers again (a page read that reached it clears `offline`);
  // one the station refused waits for the member, one it was busy for waits out its retry
  const [retryTick, setRetryTick] = useState(0);
  const head = queued[0];
  useEffect(() => {
    if (!head || head.status === 'failed' || !conversation || state.busy || !state.transcript || offline) return;
    const wait = (head.retryAt ?? 0) - Date.now();
    if (wait > 0) {
      const timer = setTimeout(() => setRetryTick((n) => n + 1), wait);
      return () => clearTimeout(timer);
    }
    void sendQueued(head.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retried when the queue, the conversation or the station settles
  }, [head?.id, head?.status, head?.retryAt, conversation, state.busy, !!state.transcript, offline, retryTick]);
  // while something waits offline, ask the station again now and then
  useEffect(() => {
    if (!offline || !queued.length || !conversation) return;
    const timer = setInterval(() => void conversation.refocus(), 15_000);
    return () => clearInterval(timer);
  }, [offline, queued.length, conversation]);

  // an html preview's sendPrompt fills the composer (never sends)
  const drafts = useComposerBridge((s) => s.drafts);
  useEffect(() => {
    if (!drafts.length) return;
    const added = useComposerBridge.getState().takeDrafts().join('\n');
    setDraft((now) => (now.trim() ? `${now.trimEnd()}\n${added}` : added));
    input.current?.focus();
  }, [drafts]);

  const files = useComposerFiles(ensureSession);

  const submit = async () => {
    const text = draft;
    const parts = sentParts(files.files);
    if (!text.trim() && !parts.images.length && !parts.attachments.length) return;
    if (state.busy) {
      alertError(t('assistant.busy'));
      return;
    }
    const id = await ensureSession();
    if (!id) {
      // never reached the station: the message waits for it
      if (!parts.attachments.length) {
        if (!queueTurn({ sessionId: null, text, images: parts.images })) {
          alertError(t('conversation.outboxFull'));
          return;
        }
        setDraft('');
        files.clear();
      }
      return;
    }
    const content = [text.trim(), attachmentsFence(parts.attachments)].filter(Boolean).join('\n\n');
    setDraft('');
    files.clear();
    if (!conversation) {
      // the conversation was just made: it sends once it opens
      firstTurn.current = { text, images: parts.images, attachments: parts.attachments };
      return;
    }
    await send(content, parts.images);
  };

  const messages = useMemo(() => visibleMessages(state.transcript?.messages ?? []), [state.transcript]);
  const lastUser = useMemo(() => {
    let last = -1;
    messages.forEach((message, index) => {
      if (message.role === 'user') last = index;
    });
    return last;
  }, [messages]);

  const items: Item[] = [
    ...messages.map((message, index): Item => ({ key: `m-${message.seq}`, kind: 'message', message, index })),
    ...(state.pending !== null
      ? [{ key: 'pending', kind: 'pending', text: state.pending, images: state.pendingImages } as Item]
      : []),
    ...(state.reply ? [{ key: 'reply', kind: 'reply' } as Item] : []),
    ...queued.map(
      (turn): Item => ({
        key: `q-${turn.id}`,
        kind: 'queued',
        id: turn.id,
        text: turn.text,
        images: turn.images,
        failed: turn.status === 'failed',
      }),
    ),
  ];

  // Sprouty's face follows the turn (header title, and below it while a reply is written)
  const live = state.reply;
  const lastReply = [...messages].reverse().find((m) => m.role === 'assistant');
  const waitingForMe =
    !!lastReply &&
    !state.busy &&
    !state.pending &&
    pipelineSteps(lastReply.pipeline).some((s) => (s.output as { type?: string } | null)?.type === 'ask_user') &&
    messages.at(-1)?.role === 'assistant';
  const face = usePlantWorkState({
    working: state.busy,
    streaming: state.busy && !!live?.text,
    hasText: !!live?.text,
    toolRunning: !!live?.tool,
    waiting: waitingForMe,
    failed: !!live?.error || state.streamFailed,
  });
  const talking = state.busy && !!state.reply;
  const { out, visible: avatarOut, room } = useTalking(talking);

  // the steps sheet keeps up with the live reply while it is open
  useEffect(() => {
    if (live) useStepsSheet.getState().follow('live', live.steps, live.tool);
  }, [live]);
  const openSteps = useCallback(
    (messageId: string, steps: ToolStep[], running: string | null = null) => {
      useStepsSheet.getState().show(messageId, steps, running);
      router.push('/sheet/steps');
    },
    [router],
  );

  const env = useCallback(
    (followUp?: string) => ({
      reply: async (text: string) => {
        if (state.busy) return false;
        return send(text, []);
      },
      followUp,
    }),
    [send, state.busy],
  );

  // long-press actions: quote into the composer, regenerate the latest reply
  const quote = useCallback((text: string) => {
    const quoted = text
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    setDraft((now) => `${quoted}\n\n${now}`);
    input.current?.focus();
  }, []);
  const regenerate = useCallback(
    async (messageId: string) => {
      if (!conversation || state.busy) return;
      pinned.current = true;
      const result = await conversation.regenerate(messageId);
      if (!result.sent && result.notice !== 'offline')
        alertError(t('conversation.regenerateFailed'), result.message || undefined);
    },
    [conversation, state.busy, t],
  );
  const userActions = useMemo(() => ({ onQuote: quote }), [quote]);

  // the ⋯ menu: pin, rename, delete (the conversation list's own store, so home follows)
  const session = useSessions((s) => s.items.find((item) => item.id === sessionId));
  const [renamed, setRenamed] = useState<string | null>(null);
  const title = renamed ?? state.title;
  const rename = async () => {
    if (!sessionId) return;
    const next = await promptText({ title: t('home.rename'), defaultValue: title ?? '' });
    if (!next) return;
    setRenamed(next.slice(0, 200));
    await useSessions.getState().rename(sessionId, next.slice(0, 200));
  };
  const remove = async () => {
    if (!sessionId) return;
    notifyWarning();
    const ok = await confirmAction({
      title: t('conversation.deleteTitle'),
      message: t('conversation.deleteHint'),
      confirmLabel: t('conversation.delete'),
      destructive: true,
    });
    if (!ok) return;
    if (state.busy) await stopRun(sessionId);
    if (await useSessions.getState().remove(sessionId)) {
      void forgetChatCopy(sessionId);
      notifySuccess();
      toast(t('conversation.deleted'), 'trash');
      router.back();
    }
  };

  // follow a reply as it streams: content-size events are sparse while text grows inside a row,
  // so every change at the end (a delta, a tool, my message) scrolls once laid out
  const tail = `${tailOf(state)}|${queued.length}`;
  useEffect(() => {
    if (!pinned.current || !state.busy) return;
    const frame = requestAnimationFrame(() => scrollRef(list.current)?.scrollToEnd({ animated: false }));
    return () => cancelAnimationFrame(frame);
  }, [tail, state.busy]);

  useEffect(() => {
    if (pinned.current && keyboardRoom) scrollRef(list.current)?.scrollToEnd({ animated: true });
  }, [keyboardRoom]);

  const jumpToEnd = () => {
    pinned.current = true;
    setAway(false);
    scrollRef(list.current)?.scrollToEnd({ animated: true });
  };

  const headerTitle = title || t(sessionId ? 'assistant.untitled' : 'assistant.newChat');
  const header = (
    <>
      <Stack.Screen
        options={{ title: headerTitle, headerTitle: () => <HeaderTitle title={headerTitle} state={face} away={avatarOut} /> }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('compose')}
          accessibilityLabel={t('conversation.newChat')}
          onPress={() => router.replace('/chat')}
        />
        {sessionId ? (
          <Stack.Toolbar.Menu icon={toolbarIcon('more')} accessibilityLabel={t('conversation.menu')}>
            <Stack.Toolbar.MenuAction
              icon={session?.pinned ? 'pin.slash' : 'pin'}
              onPress={() => {
                if (sessionId) void useSessions.getState().pin(sessionId, !session?.pinned);
              }}
            >
              {t(session?.pinned ? 'home.unpin' : 'home.pin')}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="pencil" onPress={() => void rename()}>
              {t('home.rename')}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="trash" destructive onPress={() => void remove()}>
              {t('conversation.delete')}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        ) : null}
      </Stack.Toolbar>
    </>
  );

  if (sessionId && state.missing) {
    return (
      <View style={styles.root}>
        <Stack.Screen options={{ title: t('conversation.title') }} />
        <EmptyState icon="msgs" title={t('assistant.notFound')} style={styles.state} />
      </View>
    );
  }

  const renderItem = ({ item }: { item: Item }) => {
    if (item.kind === 'message') {
      const { message } = item;
      if (message.role === 'user') {
        const { text, files: attached } = splitAttachments(message.content);
        const delivered = item.index === lastUser && state.pending === null && !queued.length;
        return (
          <UserMessage
            text={text}
            images={messageImages(message.images)}
            files={attached}
            delivered={delivered}
            actions={userActions}
          />
        );
      }
      const next = messages[item.index + 1];
      const steps = pipelineSteps(message.pipeline);
      const isLatest = message === lastReply && !state.reply && item.index === messages.length - 1;
      return (
        <AssistantReply
          messageId={message.id}
          sessionId={sessionId}
          text={message.content}
          steps={steps}
          references={message.references_}
          answered={item.index < lastUser || state.pending !== null}
          env={env(next?.role === 'user' ? next.content : undefined)}
          actions={
            isLatest && !state.busy ? { onQuote: quote, onRegenerate: () => void regenerate(message.id) } : userActions
          }
          onSteps={() => openSteps(message.id, steps)}
        />
      );
    }
    if (item.kind === 'pending') {
      const { text, files: attached } = splitAttachments(item.text);
      return <UserMessage text={text} images={[...item.images]} files={attached} sending actions={userActions} />;
    }
    if (item.kind === 'queued') {
      const { text, files: attached } = splitAttachments(item.text);
      return (
        <UserMessage
          text={text}
          images={item.images}
          files={attached}
          queued
          failed={item.failed}
          actions={userActions}
          onRetry={() => void sendQueued(item.id, true)}
          onRemove={item.failed ? () => unqueueTurn(item.id) : undefined}
        />
      );
    }
    const reply = state.reply!;
    return (
      <View>
        <AssistantReply
          messageId="live"
          sessionId={sessionId}
          text={reply.text}
          steps={reply.steps}
          live
          working={state.busy}
          runningTool={reply.tool}
          answered={false}
          env={env()}
          onSteps={() => openSteps('live', reply.steps, reply.tool)}
        />
        {reply.error ? <Text style={styles.error}>{reply.error}</Text> : null}
        {state.streamFailed ? <Text style={styles.error}>{t('assistant.streamFailed')}</Text> : null}
        {state.unreconciled ? (
          <Text style={styles.note} onPress={() => void conversation?.reconcile()}>
            {t('assistant.unreconciled')} {t('common.retry')}
          </Text>
        ) : null}
      </View>
    );
  };

  return (
    <View
      ref={root}
      style={styles.root}
      onLayout={() =>
        root.current?.measureInWindow((x, y) => setRootOrigin((now) => (now.x === x && now.y === y ? now : { x, y })))
      }
    >
      {header}
      {/* what opens from here (link chips, cards) says it came from this conversation */}
      <OpenOrigin.Provider value={sessionId ? headerTitle : null}>
        <FlatList<Item>
          ref={list}
          // insets by hand: the top clears the bar, the bottom the composer and the keyboard
          contentInsetAdjustmentBehavior="never"
          scrollIndicatorInsets={{ top: headerInset }}
          data={items}
          keyExtractor={(item) => item.key}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          // older history comes in at the top without moving what is on screen
          // (not while a reply streams: holding the first row in place fights the follow to the end)
          maintainVisibleContentPosition={state.busy ? undefined : KEEP_PLACE}
          onStartReached={() => void conversation?.loadOlder()}
          onStartReachedThreshold={0.5}
          scrollEventThrottle={32}
          onScroll={(e) => {
            const { contentOffset, layoutMeasurement, contentSize, contentInset } = e.nativeEvent;
            const end = atEnd({
              offsetY: contentOffset.y,
              viewportHeight: layoutMeasurement.height,
              contentHeight: contentSize.height + (contentInset?.bottom ?? 0),
            });
            // only the member's own scrolling lets go of the end: content growing under a scroll
            // that is still catching up (a long delta, chips resolving titles, the avatar's room)
            // passes through "not at the end" for a moment and must not stop the follow
            if (dragging.current) pinned.current = end;
            else if (end) pinned.current = true;
            setAway((now) => (now === !pinned.current ? now : !pinned.current));
          }}
          onScrollBeginDrag={() => {
            dragging.current = true;
          }}
          onScrollEndDrag={(e) => {
            const { velocity } = e.nativeEvent;
            if (!velocity || Math.abs(velocity.y) < 0.01) dragging.current = false;
          }}
          onMomentumScrollEnd={() => {
            dragging.current = false;
          }}
          onLayout={(e) => {
            viewport.current = e.nativeEvent.layout.height;
          }}
          onContentSizeChange={(_, height) => {
            const next = { head: headOf(state), tail: `${tailOf(state)}|${queued.length}` };
            const follow = shouldFollowEnd({
              pinned: pinned.current,
              head: next.head,
              prevHead: shape.current.head,
              tail: next.tail,
              prevTail: shape.current.tail,
            });
            shape.current = next;
            // the native scroll view's own end: content, its padding and the keyboard inset
            // (only when it overflows: a short conversation rests at the top, under the bar)
            // (while a reply streams, at once: an animated scroll restarted on every delta never lands)
            if (follow && height > viewport.current)
              scrollRef(list.current)?.scrollToEnd({ animated: !state.busy });
          }}
          ListHeaderComponent={
            <>
              {/* room for Sprouty while it talks below the title, so it never covers a message */}
              <TalkingRoom open={room} />
              {offline ? <Text style={styles.offline}>{t('common.savedCopy')}</Text> : null}
              {state.loadingOlder ? <Spinner style={styles.older} /> : null}
            </>
          }
          renderItem={renderItem}
          ListEmptyComponent={
            !sessionId || state.transcript ? (
              <Text style={styles.hint}>{t('assistant.startHint')}</Text>
            ) : state.loadFailed ? (
              <EmptyState
                icon="alert"
                title={t('assistant.loadFailed')}
                onRetry={() => void conversation?.refocus()}
                style={styles.state}
              />
            ) : (
              <ConversationLoading />
            )
          }
          contentContainerStyle={[
            styles.content,
            { paddingTop: headerInset + space.md, paddingBottom: composerHeight + insets.bottom + keyboardRoom + space.lg },
          ]}
        />
      </OpenOrigin.Provider>
      {avatarOut ? <TalkingBand out={out} height={headerInset} /> : null}
      {avatarOut ? <TalkingAvatar state={face} out={out} origin={rootOrigin} /> : null}
      <KeyboardStickyView offset={{ opened: insets.bottom }} style={styles.composerWrap}>
        {away && items.length ? (
          <Animated.View
            entering={FadeIn.duration(motion.fast).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(motion.fast).reduceMotion(ReduceMotion.System)}
            style={styles.jump}
          >
            <GlassIconButton
              icon="arrowDown"
              size={HIT - space.xs}
              onPress={jumpToEnd}
              accessibilityLabel={t('conversation.jumpLatest')}
            />
          </Animated.View>
        ) : null}
        <View style={{ paddingBottom: Math.max(insets.bottom, space.sm) }}>
          <Composer
            ref={input}
            value={draft}
            onChangeText={setDraft}
            onSend={() => void submit()}
            working={state.busy}
            onStop={sessionId ? () => void stopRun(sessionId) : undefined}
            onAttach={(from) => void files.attach(from)}
            files={files.files}
            onRemoveFile={files.remove}
            onRetryFiles={files.retry}
            placeholder={t(messages.length ? 'composer.followUp' : 'composer.placeholder')}
            autoFocus={!sessionId && !params.k}
            onHeight={setComposerHeight}
          />
        </View>
      </KeyboardStickyView>
    </View>
  );
}

/** The first load: a small spinner, shown only once the wait is noticeable, where the list starts. */
function ConversationLoading() {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View
      style={styles.loading}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('common.loading')}
      accessibilityState={{ busy: true }}
    >
      {slow ? <Spinner /> : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  content: { paddingHorizontal: space.margin, gap: space.lg },
  state: { paddingTop: space.xxxl },
  older: { paddingVertical: space.md },
  note: { ...typo.subheadline, color: c.secondaryLabel },
  error: { ...typo.footnote, color: c.red, marginTop: space.xs },
  hint: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center', marginTop: space.xxxl },
  offline: { ...typo.footnote, color: c.secondaryLabel, textAlign: 'center', paddingBottom: space.sm },
  composerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  jump: { position: 'absolute', right: space.margin, top: -(HIT + space.xs) },
  loading: { height: HIT * 2, alignItems: 'center', justifyContent: 'center', marginTop: space.xxxl },
}));
