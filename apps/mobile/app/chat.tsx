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
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FlatList, Text, View, type TextInput } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chatRun, createSession, getMessages, getSessionInfo, stopRun } from '../src/api/assistant';
import type { ApiResult } from '../src/api/client';
import { Composer } from '../src/chat/composer';
import { sentParts } from '../src/chat/composer-files';
import { AssistantReply, UserMessage } from '../src/chat/messages';
import { attachmentsFence, messageImages, pipelineSteps, splitAttachments, type AttachedFile } from '../src/chat/parts';
import { followRun, sendMessage } from '../src/chat/send';
import { useComposerBridge } from '../src/chat/composer-bridge';
import { useComposerFiles } from '../src/chat/use-composer-files';
import { visibleMessages } from '../src/data/chat-stream';
import { CLOSED_CONVERSATION, Conversation, headOf, tailOf, type ConversationState, type SentImage } from '../src/data/conversation';
import { atEnd, shouldFollowEnd } from '../src/data/follow-end';
import { captureIdentity } from '../src/data/identity';
import type { MessagePage } from '../src/data/transcript';
import { getHandoff } from '../src/lib/handoff';
import { useT } from '../src/lib/i18n';
import type { ChatMessage } from '../src/shared/greenhouse-types';
import { readChatCopy, saveChatCopy } from '../src/store/chat-copies';
import { claimConversation, deliverQueued, queueTurn, unqueueTurn, useOutbox } from '../src/store/outbox';
import { makeStyles, space, typo, useTheme } from '../src/theme';
import { alertError } from '../src/ui/dialogs';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { usePlantWorkState } from '../src/ui/plant-avatar/use-plant-work';
import type { PlantStateInput } from '../src/ui/plant-avatar/plant-ids';
import { Spinner } from '../src/ui/core';

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

/** The navigation bar's height under the status bar; the list's top inset when following the end. */
const NAV_BAR = 56;

const noSubscription = () => () => {};
const closed = (): ConversationState<ChatMessage> => CLOSED_CONVERSATION;

export default function Chat() {
  const params = useLocalSearchParams<{ session?: string; k?: string; draft?: string }>();
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const insets = useSafeAreaInsets();
  const [sessionId, setSessionId] = useState<string | null>(params.session && /^[A-Za-z0-9_-]{1,128}$/.test(params.session) ? params.session : null);
  const [draft, setDraft] = useState(params.draft ?? '');
  const [composerHeight, setComposerHeight] = useState(64);
  const [offline, setOffline] = useState(false);
  const input = useRef<TextInput>(null);
  const list = useRef<FlatList<Item>>(null);
  const viewport = useRef(0);
  const pinned = useRef(true);
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
      send: (text, onEvent, signal, images) => sendMessage(sessionId, text.slice(0, 20_000), onEvent, signal, images),
      runActive: async () => {
        const result = await chatRun(sessionId);
        return result.ok ? { ok: true, data: { active: result.data.active } } : result;
      },
      follow: (onEvent, signal) => followRun(sessionId, onEvent, signal),
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
      const result = await conversation.send(text, images);
      if (result.sent) return true;
      if (result.notice === 'offline') {
        setOffline(true);
        // no answer: it may have arrived, so the outbox looks for it before it goes again
        if (sessionId && queueTurn({ sessionId, text, images: [...images], status: 'unknown' })) return false;
      }
      // my words come back to the box whatever refused them (or when the outbox is full)
      setDraft((now) => now || result.restore);
      const title = result.notice === 'offline' ? t('conversation.outboxFull') : result.notice === 'busy' ? t('assistant.busy') : t('assistant.sendFailed');
      alertError(title, result.notice === 'offline' ? undefined : result.message || undefined);
      return false;
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
          const result = await conversation.send(turn.text, turn.images);
          return result.sent ? { ok: true } : { ok: false, status: result.status, message: result.message };
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

  const submit = async (spoken?: string) => {
    const text = spoken ?? draft;
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
    ...(state.pending !== null ? [{ key: 'pending', kind: 'pending', text: state.pending, images: state.pendingImages } as Item] : []),
    ...(state.reply ? [{ key: 'reply', kind: 'reply' } as Item] : []),
    ...queued.map((turn): Item => ({ key: `q-${turn.id}`, kind: 'queued', id: turn.id, text: turn.text, images: turn.images, failed: turn.status === 'failed' })),
  ];

  // the sprout of the latest reply follows the turn
  const live = state.reply;
  const lastReply = [...messages].reverse().find((m) => m.role === 'assistant');
  const waitingForMe = !!lastReply && !state.busy && !state.pending && pipelineSteps(lastReply.pipeline).some((s) => (s.output as { type?: string } | null)?.type === 'ask_user') && messages.at(-1)?.role === 'assistant';
  const latestState = usePlantWorkState({
    working: state.busy,
    streaming: state.busy && !!live?.text,
    hasText: !!live?.text,
    toolRunning: !!live?.tool,
    waiting: waitingForMe,
    failed: !!live?.error,
  });

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
        return <UserMessage text={text} images={messageImages(message.images)} files={attached} />;
      }
      const next = messages[item.index + 1];
      const isLatest = message === lastReply && !state.reply;
      return (
        <AssistantReply
          messageId={message.id}
          sessionId={sessionId}
          text={message.content}
          steps={pipelineSteps(message.pipeline)}
          references={message.references_}
          state={isLatest ? latestState : 'idle'}
          answered={item.index < lastUser || state.pending !== null}
          env={env(next?.role === 'user' ? next.content : undefined)}
        />
      );
    }
    if (item.kind === 'pending') {
      const { text, files: attached } = splitAttachments(item.text);
      return <UserMessage text={text} images={[...item.images]} files={attached} />;
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
          state={latestState as PlantStateInput}
          live
          answered={false}
          env={env()}
        />
        {state.busy && (!reply.text || reply.tool) ? (
          <View style={styles.typing} accessibilityLiveRegion="polite">
            <Spinner size="small" />
            <Text style={styles.note}>{reply.tool ? t('assistant.usingTool', { tool: reply.tool }) : t('assistant.thinking')}</Text>
          </View>
        ) : null}
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
      style={styles.root}
      onLayout={(e) => {
        viewport.current = e.nativeEvent.layout.height;
      }}
    >
      <Stack.Screen options={{ title: state.title || t(sessionId ? 'assistant.untitled' : 'assistant.newChat') }} />
      <FlatList<Item>
        ref={list}
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={(item) => item.key}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        // older history comes in at the top without moving what is on screen
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onStartReached={() => void conversation?.loadOlder()}
        onStartReachedThreshold={0.5}
        scrollEventThrottle={32}
        onScroll={(e) => {
          const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
          pinned.current = atEnd({ offsetY: contentOffset.y, viewportHeight: layoutMeasurement.height, contentHeight: contentSize.height });
        }}
        onContentSizeChange={(_, height) => {
          const next = { head: headOf(state), tail: `${tailOf(state)}|${queued.length}` };
          const follow = shouldFollowEnd({ pinned: pinned.current, head: next.head, prevHead: shape.current.head, tail: next.tail, prevTail: shape.current.tail });
          shape.current = next;
          if (follow && height > viewport.current - insets.top - NAV_BAR) list.current?.scrollToEnd({ animated: true });
        }}
        ListHeaderComponent={
          <>
            {offline ? <Text style={styles.offline}>{t('common.savedCopy')}</Text> : null}
            {state.loadingOlder ? <Spinner style={styles.older} /> : null}
          </>
        }
        renderItem={renderItem}
        ListEmptyComponent={
          !sessionId || state.transcript ? (
            <Text style={styles.hint}>{t('assistant.startHint')}</Text>
          ) : state.loadFailed ? (
            <EmptyState icon="alert" title={t('assistant.loadFailed')} onRetry={() => void conversation?.refocus()} style={styles.state} />
          ) : (
            <LoadingState style={styles.state} />
          )
        }
        contentContainerStyle={[styles.content, { paddingBottom: composerHeight + insets.bottom + space.lg }]}
      />
      <KeyboardStickyView offset={{ opened: insets.bottom }} style={styles.composerWrap}>
        <View style={{ paddingBottom: Math.max(insets.bottom, space.sm) }}>
          <Composer
            ref={input}
            value={draft}
            onChangeText={setDraft}
            onSend={(spoken) => void submit(spoken)}
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

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  content: { paddingHorizontal: space.margin, paddingTop: space.md, gap: space.lg },
  state: { paddingTop: space.xxxl },
  older: { paddingVertical: space.md },
  typing: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  note: { ...typo.subheadline, color: c.secondaryLabel },
  error: { ...typo.footnote, color: c.red, marginTop: space.xs },
  hint: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center', marginTop: space.xxxl },
  offline: { ...typo.footnote, color: c.secondaryLabel, textAlign: 'center', paddingBottom: space.sm },
  composerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
}));
