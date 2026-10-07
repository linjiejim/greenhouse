/**
 * The conversation — home of the app, living inside the slide drawer. ONE
 * screen serves a new and an existing conversation (route params: `id?`
 * session, `title?` placeholder title, `ro?='1'` shared/read-only,
 * `compose?='1'` focus the composer — the widget's "新对话" deep link).
 *
 *  - New: a minimal hero (Sprouty + greeting) above the composer (plus an
 *    agent capsule when there is more than one agent); the first send creates the session, re-points the route with
 *    `router.setParams({ id })` (no remount) and the hero fades into the turn.
 *  - Existing: history loads, new turns stream (src/chat/use-conversation.ts).
 *
 * Chrome is native: inline title (live-updated by the server's title event),
 * Liquid Glass toolbar — ☰ opens the drawer (as does a right swipe from
 * anywhere), 新对话, and a system menu with the real conversation actions
 * (标签 / 分享 / 重命名 / 删除). Content is the solid layer (session tag chips,
 * messages); the composer is the floating glass layer, kept above the keyboard
 * by KeyboardStickyView. Details open as sheets: reasoning and tool calls
 * (following a streaming reply live — src/chat/live-turn.ts), references,
 * sources, tables. Cards in a reply (an ask_user form, a ```confirm) answer
 * through `reply()` — a send like the composer's, anchored the same way.
 *
 * Scrolling never chases the stream (pinning the end on every drain tick made
 * a reply judder). Opening a conversation lands on its end; every turn — a
 * send, 重新生成, a run re-attached on open — is *anchored*: the user's message
 * slides up under the nav bar and the reply unfolds below it in place
 * (ChatGPT / Claude style). KeyboardChatScrollView's `blankSpace` (an inset
 * floor) keeps that offset reachable while the reply is short and shrinks as
 * it grows, so nothing moves; past the fold the reply simply continues below,
 * and "回到最新" appears whenever the end is out of view. The rules live in
 * src/chat/use-turn-anchor.ts (shared with the Bots thread).
 *
 * Streaming re-renders this screen ~30×/s, so everything handed to children is
 * kept referentially stable (header and composer are memoised, callbacks read
 * the latest state through a ref) — only the reply being streamed re-renders.
 *
 * Bots (spec docs/specs/20261008-mobile-bots.md §2.2 / §2.5.2, D2–D4): the
 * default export is `Home`, a dispatcher — `?c=<session>` renders the Bots
 * thread (src/bots/thread/thread-screen.tsx, remounted per thread), anything
 * else this conversation screen. Every route here carries all seven home
 * params (src/bots/nav.ts). On a cold start a bare home reopens the Bots
 * thread the member left the app in (src/bots/home/initial-surface.ts), once
 * per process. With Bots on, the conversation screen also gets: the hero's
 * "a new chat starts fresh" hint, the bridge row back into the Bots and a
 * shelf of their faces; a `?profile=` new chat with one Bot (its face and
 * name in the hero, a "Back to …" button; the profile is never saved); the ☰
 * badge (other conversations that need the member or have something unread)
 * and — over an existing conversation — the "needs you" capsule; a Bots
 * session reached by id is forwarded to its thread. With Bots off (or on
 * Android) none of this renders and the screen is exactly what it was.
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Linking, Platform, Share, StyleSheet, Text, View, type LayoutChangeEvent, type TextInput } from 'react-native';
import { Stack, useIsFocused, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { DrawerActions } from 'expo-router/react-navigation';
import { useHeaderInset } from '../../../src/ui/header-inset';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import {
  KeyboardChatScrollView,
  KeyboardStickyView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import type { Session, SessionTag } from '../../../src/shared/greenhouse-types';
import { splitAttachments } from '../../../src/shared/rich-output';
import { deleteSession, updateSessionTitle } from '../../../src/api/sessions';
import { prepareImage, uploadImage } from '../../../src/api/upload';
import { useAuth } from '../../../src/store/auth';
import { useTags } from '../../../src/store/tags';
import { Composer, ReadOnlyBar, type ComposerImage } from '../../../src/chat/composer';
import { useComposerBridge } from '../../../src/chat/composer-bridge';
import { AiMessage, UserMessage, type MessageAction } from '../../../src/chat/message';
import { excerpt, plainText, transcript, type Annotation, type ChatMessage } from '../../../src/chat/model';
import { openTurn, publishTurns } from '../../../src/chat/live-turn';
import { TagChip } from '../../../src/chat/tag-chip';
import { nextId, useConversation } from '../../../src/chat/use-conversation';
import { useTurnAnchor } from '../../../src/chat/use-turn-anchor';
import { putHandoff } from '../../../src/lib/handoff';
import { greeting } from '../../../src/lib/format';
import { t as tNow, useT } from '../../../src/lib/i18n';
import { makeStyles, space, typo, useTheme } from '../../../src/theme';
import { NativeButton } from '../../../src/ui/button';
import { alertError, confirmAction, promptText } from '../../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { PlantAvatar } from '../../../src/ui/plant-avatar';
import { toast } from '../../../src/ui/toast';
import { toolbarIcon } from '../../../src/ui/toolbar-icon';
import {
  BOTS_PLATFORM_READY,
  botsEnabledNow,
  useBotIdentityEnabled,
  useBotsEnabled,
} from '../../../src/bots/availability';
import { AttentionCapsule } from '../../../src/bots/cards/attention-capsule';
import { useRowCopy } from '../../../src/bots/drawer/conversation-row';
import { rowTitle } from '../../../src/bots/drawer/row-text';
import { BotsShelf } from '../../../src/bots/home/bots-shelf';
import { HomeBridge, useBotsWarm, useProfileBot } from '../../../src/bots/home/home-bridge';
import { initialSurface } from '../../../src/bots/home/initial-surface';
import { forgetThread, lastThread, rememberThread, type LastThread } from '../../../src/bots/last-surface';
import { homeParams, openNewChat, openThread, type HomeParams } from '../../../src/bots/nav';
import { attentionCount, useBots } from '../../../src/bots/store';
import { BotThreadScreen } from '../../../src/bots/thread/thread-screen';
import { BotAvatar } from '../../../src/bots/ui/bot-avatar';
import { usePrefs } from '../../../src/store/prefs';

const MAX_IMAGES = 4;

/** What a message shows — a user turn without its attachments fence (that's for chips, not for copying). */
const visibleText = (msg: ChatMessage) => (msg.role === 'user' ? splitAttachments(msg.text).text : msg.text);

/* ------------------------------ native header ------------------------------ */

interface HeaderActions {
  openDrawer: () => void;
  newChat: () => void;
  openTags: () => void;
  share: () => void;
  rename: () => void;
  remove: () => void;
}

/**
 * Title + glass toolbar. Memoised: Stack.Toolbar re-applies the navigation
 * options whenever it re-renders, which must not happen on every stream tick.
 */
const ConversationHeader = memo(function ConversationHeader({
  title,
  hasSession,
  readOnly,
  badge,
  actions,
}: {
  title: string;
  hasSession: boolean;
  readOnly: boolean;
  /** The ☰ badge — Bots conversations that need the member or have something unread ('' = none). */
  badge: string;
  actions: HeaderActions;
}) {
  const t = useT();
  return (
    <>
      <Stack.Screen options={{ title }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon={toolbarIcon('menu')}
          accessibilityLabel={
            badge
              ? [t('chat.openDrawer'), t('bots.nav.menuBadgeA11y', { n: badge })].join(t('bots.nav.listSep'))
              : t('chat.openDrawer')
          }
          onPress={actions.openDrawer}
        >
          {badge ? <Stack.Toolbar.Badge>{badge}</Stack.Toolbar.Badge> : null}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('compose')}
          hidden={!hasSession}
          accessibilityLabel={t('drawer.newChat')}
          onPress={actions.newChat}
        />
        <Stack.Toolbar.Menu icon={toolbarIcon('more')} hidden={!hasSession} accessibilityLabel={t('common.more')}>
          <Stack.Toolbar.MenuAction icon={toolbarIcon('tag')} hidden={readOnly} onPress={actions.openTags}>
            {t('chat.actionTags')}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon={toolbarIcon('share')} onPress={actions.share}>
            {t('chat.actionShare')}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon={toolbarIcon('pen')} hidden={readOnly} onPress={actions.rename}>
            {t('chat.actionRename')}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.Menu inline hidden={readOnly}>
            <Stack.Toolbar.MenuAction icon={toolbarIcon('trash')} destructive onPress={actions.remove}>
              {t('chat.actionDelete')}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
    </>
  );
});

/* ------------------------------ screen ------------------------------ */

function Conversation() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderInset();
  const params = useLocalSearchParams<{
    id?: string;
    title?: string;
    ro?: string;
    compose?: string;
    profile?: string;
  }>();
  const user = useAuth((s) => s.user);

  /* ---------- Bots: hint, bridge, ☰ badge, capsule, `?profile=` (see header) ---------- */
  const botsOn = useBotsEnabled();
  const identityOn = useBotIdentityEnabled();
  useBotsWarm(botsOn);
  const attention = useBots((s) => (botsOn ? attentionCount(s, null) : 0));
  const badge = attention > 99 ? '99+' : attention > 0 ? String(attention) : '';
  // A new chat with one Bot ("Ask Dandy in a New Chat"): this chat only, never the saved default.
  const profile = identityOn && params.profile ? params.profile : undefined;
  const profileBot = useProfileBot(profile);

  const onCreated = useCallback((s: { id: string }) => router.setParams({ id: s.id }), [router]);
  // A Bots conversation reached by id (`greenhouse://chat/<id>`) belongs on its thread.
  const leave = useCallback(
    (session: Session) => {
      if (session.channel !== 'bots' || !botsEnabledNow()) return false;
      openThread(router, { c: session.id, title: session.title ?? '' });
      return true;
    },
    [router],
  );
  const convo = useConversation({ initialId: params.id || undefined, onCreated, profile, leave });
  // Destructure the stable callbacks — `convo` itself changes on every drain tick.
  const { sessionId, messages, streaming, rerun, stop, setTitle, send: convoSend, reload } = convo;
  const readOnly = params.ro === '1' || convo.isOwner === false;
  // An existing conversation that's still loading has no title yet — show none
  // rather than flash "新对话".
  const title = convo.title || params.title || (sessionId && convo.loading ? '' : t('chat.newConversation'));
  const isNew = !sessionId && messages.length === 0;

  /* ---------- composer state ---------- */
  const inputRef = useRef<TextInput>(null);
  const [input, setInput] = useState('');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [composerH, setComposerH] = useState(60);
  // Insets are managed here, not by UIKit (`contentInsetAdjustmentBehavior`
  // "never"): KeyboardChatScrollView's keyboard lift assumes a 0 rest offset,
  // so the top (header) inset is content padding and the bottom inset = the
  // floating composer + home indicator, extended by the keyboard while it's up.
  // Space under the composer: the home indicator / gesture bar inset (Android
  // adds a little air — its gesture handle sits right on the inset's edge).
  const composerBottom = Math.max(insets.bottom, space.md) + (Platform.OS === 'android' ? space.sm : 0);
  const extraPad = useSharedValue(60 + composerBottom + space.md);
  const onComposerHeight = useCallback(
    (h: number) => {
      setComposerH(h);
      extraPad.value = h + composerBottom + space.md;
    },
    [extraPad, composerBottom],
  );
  const focusInput = useCallback(() => setTimeout(() => inputRef.current?.focus(), 300), []);

  /* ---------- scrolling: land on the end, anchor each turn (see header) ---------- */
  const {
    scrollRef,
    blankSpace,
    endVisible,
    onEndVisible,
    onViewport,
    onContentSize,
    onDragStart,
    onAnchorRowLayout,
    anchorNext,
    holdForTurn,
    cancelTurn,
    jumpToLatest,
    landOnEnd,
  } = useTurnAnchor({
    topPad: headerHeight + space.sm,
    // Height a turn can fill without scrolling ends at the composer.
    bottomInset: () => composerH + composerBottom + space.md,
  });
  const lastUserId = useMemo(() => [...messages].reverse().find((m) => m.role === 'user')?.id, [messages]);
  const lastUserIdRef = useRef(lastUserId);
  lastUserIdRef.current = lastUserId;

  // the last user message reports where it sits — that's what a turn anchors to
  const onLastUserLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const id = lastUserIdRef.current;
      if (id) onAnchorRowLayout(id, e);
    },
    [onAnchorRowLayout],
  );

  // Every turn is anchored — sent here, re-run, or a live run re-attached on open.
  useEffect(() => {
    if (streaming) anchorNext(lastUserIdRef.current ?? '');
  }, [streaming, anchorNext]);

  // Another conversation (or a fresh one): land on its end again, no anchor.
  const empty = messages.length === 0;
  useEffect(() => {
    if (empty) landOnEnd();
  }, [empty, landOnEnd]);

  // The widget's 新对话 deep link (`?compose=1`) can land on an already-open
  // screen (autoFocus only applies on mount): focus, then consume the param.
  useEffect(() => {
    if (params.compose !== '1') return;
    focusInput();
    router.setParams({ compose: undefined });
  }, [params.compose, focusInput, router]);

  // Sheets hand context back through the bridge (e.g. a source's "就此提问").
  // A read-only conversation has no composer — drop it rather than hide it.
  const pendingCount = useComposerBridge((s) => s.pending.length);
  useEffect(() => {
    if (!pendingCount) return;
    const texts = useComposerBridge.getState().take();
    if (readOnly) return;
    setAnnotations((a) => [...a, ...texts.map((text) => ({ id: nextId(), text }))]);
    focusInput();
  }, [pendingCount, focusInput, readOnly]);

  const addPicked = useCallback(async (assets: ImagePicker.ImagePickerAsset[]) => {
    for (const asset of assets) {
      const localId = nextId();
      setImages((arr) => [...arr, { id: localId, uri: asset.uri, status: 'uploading' }]);
      const uri = await prepareImage(asset.uri, asset.width);
      const up = await uploadImage(uri, asset.mimeType || 'image/jpeg');
      setImages((arr) =>
        arr.map((im) =>
          im.id === localId
            ? up
              ? { ...im, status: 'done', remote: { id: up.id, url: up.url } }
              : { ...im, status: 'error' }
            : im,
        ),
      );
      if (!up) alertError(tNow('upload.failed'));
    }
  }, []);

  const imageCount = images.length;
  const onAttach = useCallback(
    async (from: 'camera' | 'library') => {
      const room = MAX_IMAGES - imageCount;
      if (room <= 0) {
        alertError(tNow('chat.maxImages', { n: MAX_IMAGES }));
        return;
      }
      if (from === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          // The system only asks once — after a "Don't Allow" the way back is Settings.
          const go = await confirmAction({
            title: tNow('chat.cameraDenied'),
            message: tNow('chat.cameraDeniedHint'),
            confirmLabel: tNow('chat.openSettings'),
          });
          if (go) void Linking.openSettings();
          return;
        }
        const res = await ImagePicker.launchCameraAsync({ quality: 0.9 });
        if (!res.canceled) void addPicked(res.assets);
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: room,
        quality: 0.9,
      });
      if (!res.canceled) void addPicked(res.assets.slice(0, room));
    },
    [imageCount, addPicked],
  );
  const removeAnnotation = useCallback((id: string) => setAnnotations((a) => a.filter((x) => x.id !== id)), []);
  const removeImage = useCallback((id: string) => setImages((arr) => arr.filter((im) => im.id !== id)), []);

  // Reset to a new conversation in place (the 新对话 deep link on an open one):
  // the old conversation's draft doesn't carry over.
  const prevSession = useRef(sessionId);
  useEffect(() => {
    if (prevSession.current && !sessionId) {
      setInput('');
      setAnnotations([]);
      setImages([]);
    }
    prevSession.current = sessionId;
  }, [sessionId]);

  const send = useCallback(async () => {
    const text = input.trim();
    const ready = images.filter((im) => im.status === 'done' && im.remote);
    // Send stays disabled while a picked image is still uploading (see Composer).
    if ((!text && !ready.length) || streaming || images.some((im) => im.status === 'uploading')) return;
    const draft = { input, annotations, images };
    setInput('');
    // Clear natively too: a multiline field emptied only through `value` keeps
    // its grown height on iOS (Fabric doesn't re-measure the emptied text view).
    inputRef.current?.clear();
    setAnnotations([]);
    setImages([]);
    // Read the reply, not the keyboard. A temporary floor first: with the
    // keyboard gone, the current offset must stay valid until the anchor lands.
    // The anchor itself starts with the turn (the `streaming` effect), once the
    // new message is in the list — starting it here would anchor the previous
    // message and drop the floor (the next scroll then clamps short).
    holdForTurn();
    Keyboard.dismiss();
    const ok = await convoSend({
      text,
      annotation: annotations.length ? annotations.map((a) => a.text).join('\n') : null,
      images: ready.map((im) => im.remote!),
    });
    if (!ok) {
      cancelTurn();
      setInput(draft.input);
      setAnnotations(draft.annotations);
      setImages(draft.images);
      alertError(tNow('chat.createFailed'));
    }
  }, [input, images, annotations, streaming, convoSend, holdForTurn, cancelTurn]);

  /** A follow-up sent from a card in a reply (ask_user answers, a confirm pick). Stable: reads `streaming` live. */
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const reply = useCallback(
    async (text: string) => {
      if (streamingRef.current) {
        toast(tNow('chat.busy'), 'clock');
        return false;
      }
      // same as a composer send (see `send`): floor now, anchor with the turn
      holdForTurn();
      Keyboard.dismiss();
      const ok = await convoSend({ text, annotation: null, images: [] });
      if (!ok) {
        cancelTurn();
        alertError(tNow('chat.createFailed'));
      }
      return ok;
    },
    [convoSend, holdForTurn, cancelTurn],
  );

  /* ---------- message actions (stable — messages are memoised) ---------- */
  const onAction = useCallback(
    async (msg: ChatMessage, action: MessageAction) => {
      switch (action) {
        case 'copy':
          await Clipboard.setStringAsync(visibleText(msg)).catch(() => {});
          toast(tNow('common.copied'), 'copy');
          break;
        case 'share':
          void Share.share({ message: msg.text });
          break;
        case 'quote':
          setAnnotations((a) => [...a, { id: nextId(), text: excerpt(plainText(msg.text), 120) }]);
          focusInput();
          break;
        case 'edit':
          setInput(visibleText(msg));
          focusInput();
          break;
        case 'regenerate':
          void rerun();
          break;
      }
    },
    [rerun, focusInput],
  );
  const onRetry = useCallback(() => void rerun(), [rerun]);
  // the reply's sheets follow it while it streams
  useEffect(() => publishTurns(messages), [messages]);
  const onOpenTools = useCallback(
    (msg: ChatMessage) => router.push({ pathname: '/peek/tools', params: { id: openTurn(msg) } }),
    [router],
  );
  const onOpenReasoning = useCallback(
    (msg: ChatMessage) => router.push({ pathname: '/peek/reasoning', params: { id: openTurn(msg) } }),
    [router],
  );
  const onOpenRefs = useCallback(
    (msg: ChatMessage) =>
      router.push({
        pathname: '/peek/refs',
        // readOnly: no composer to "ask about" a source in
        params: { k: putHandoff('refs', { sources: msg.sources, web: msg.web, readOnly }) },
      }),
    [router, readOnly],
  );

  /* ---------- conversation actions (stable; read the latest state via a ref) ---------- */
  const latest = useRef({ sessionId, title, messages });
  latest.current = { sessionId, title, messages };
  const headerActions = useMemo<HeaderActions>(
    () => ({
      openDrawer: () => navigation.dispatch(DrawerActions.openDrawer()),
      newChat: () => openNewChat(router),
      openTags: () => {
        const id = latest.current.sessionId;
        if (id) router.push({ pathname: '/sheets/session-tags', params: { sessionId: id } });
      },
      share: () => {
        const { title: tt, messages: ms } = latest.current;
        void Share.share({
          message: transcript(tt, ms, { user: tNow('chat.you'), assistant: tNow('chat.assistant') }),
        });
      },
      rename: async () => {
        const { sessionId: id, title: current } = latest.current;
        if (!id) return;
        const next = await promptText({
          title: tNow('chat.renameTitle'),
          defaultValue: current,
          confirmLabel: tNow('common.save'),
        });
        if (!next || next === current) return;
        if (await updateSessionTitle(id, next)) setTitle(next);
        else alertError(tNow('chat.renameFailed'));
      },
      remove: async () => {
        const id = latest.current.sessionId;
        if (!id) return;
        const ok = await confirmAction({
          title: tNow('drawer.deleteTitle'),
          message: tNow('chat.deleteHint'),
          confirmLabel: tNow('common.delete'),
          destructive: true,
        });
        if (!ok) return;
        stop();
        if (await deleteSession(id)) {
          openNewChat(router);
          toast(tNow('chat.deleted'), 'trash');
        } else alertError(tNow('chat.deleteFailed'));
      },
    }),
    [navigation, router, setTitle, stop],
  );

  /* ---------- session tags ---------- */
  const tags = useTags((s) => (sessionId ? s.sessionTags[sessionId] : undefined));
  // Through the store: optimistic, serialized with the tags sheet, rolled back on failure.
  const removeTag = useCallback(
    (tag: SessionTag) => {
      if (!sessionId) return;
      void useTags
        .getState()
        .toggleSessionTag(sessionId, tag)
        .then((r) => {
          if (r === 'failed') alertError(tNow('tags.assignFailed'));
        });
    },
    [sessionId],
  );

  /* ---------- layout ---------- */
  const { height: kbHeight } = useReanimatedKeyboardAnimation();
  // Keep the hero centred in the space left between the header, composer and keyboard.
  // …and fade it while a sheet is up: the mascot sits right under a form
  // sheet's half-height detent, where the sheet's glass edge would refract it
  // (bright, undimmed) above the dimming.
  const focused = useIsFocused();
  const heroAlpha = useSharedValue(1);
  useEffect(() => {
    heroAlpha.value = withTiming(focused ? 1 : 0, { duration: focused ? 220 : 120 });
  }, [focused, heroAlpha]);
  const heroFade = useAnimatedStyle(() => ({ opacity: heroAlpha.value }));
  const heroLift = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(0, Math.abs(kbHeight.value) - insets.bottom) / 2 }],
  }));
  const stickyOffset = useMemo(() => ({ closed: 0, opened: insets.bottom - space.sm }), [insets.bottom]);
  const lastAiId = useMemo(() => [...messages].reverse().find((m) => m.role === 'assistant')?.id, [messages]);

  return (
    <View style={styles.root}>
      <ConversationHeader
        title={title}
        hasSession={!!sessionId}
        readOnly={readOnly}
        badge={badge}
        actions={headerActions}
      />

      <KeyboardChatScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingTop: headerHeight + space.sm }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        keyboardLiftBehavior="persistent"
        offset={insets.bottom}
        extraContentPadding={extraPad}
        blankSpace={blankSpace}
        onLayout={onViewport}
        onScrollBeginDrag={onDragStart}
        onEndVisible={onEndVisible}
        onContentSizeChange={onContentSize}
      >
        {tags?.length ? (
          <View style={styles.tags}>
            {tags.map((tag) => (
              <TagChip key={tag.id} tag={tag} onRemove={readOnly ? undefined : () => removeTag(tag)} />
            ))}
          </View>
        ) : null}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            // the last user message reports where it sits — that's what a turn anchors to
            <View key={m.id} onLayout={m.id === lastUserId ? onLastUserLayout : undefined}>
              <UserMessage msg={m} readOnly={readOnly} onAction={onAction} />
            </View>
          ) : (
            <AiMessage
              key={m.id}
              msg={m}
              isLatest={m.id === lastAiId}
              readOnly={readOnly}
              followUp={messages[i + 1]?.role === 'user' ? (messages[i + 1].wire ?? messages[i + 1].text) : undefined}
              onOpenTools={onOpenTools}
              onOpenReasoning={onOpenReasoning}
              onOpenRefs={onOpenRefs}
              onAction={onAction}
              onRetry={onRetry}
              onReply={reply}
            />
          ),
        )}
      </KeyboardChatScrollView>

      {/* new conversation: the hero, centred above the composer (only the Bots links in it take touches) */}
      {isNew ? (
        <Animated.View
          pointerEvents="box-none"
          exiting={FadeOut.duration(180)}
          style={[styles.heroWrap, { top: headerHeight, bottom: composerH + composerBottom }]}
        >
          <Animated.View pointerEvents="box-none" style={heroFade}>
            <Animated.View pointerEvents="box-none" entering={FadeIn.duration(320)} style={[styles.hero, heroLift]}>
              {profileBot ? (
                <View pointerEvents="none" style={styles.heroFace}>
                  <BotAvatar bot={profileBot.bot} size={76} animate={focused} />
                  {profileBot.bot ? (
                    <>
                      <Text style={styles.heroTitle}>{profileBot.bot.name}</Text>
                      <Text style={styles.heroSub}>{t('bots.nav.profileHint', { name: profileBot.bot.name })}</Text>
                    </>
                  ) : null}
                </View>
              ) : (
                <View pointerEvents="none" style={styles.heroFace}>
                  <PlantAvatar size={76} animate={focused} />
                  <Text style={styles.heroTitle}>
                    {t('home.greetingFormat', { greeting: greeting(), name: user?.nickname ?? t('home.fallbackName') })}
                  </Text>
                  <Text style={styles.heroSub}>{t('home.title')}</Text>
                  {botsOn ? <Text style={styles.heroHint}>{t('bots.nav.freshHint')}</Text> : null}
                </View>
              )}
              {profileBot?.bot && profileBot.dm && botsOn ? (
                <NativeButton
                  label={t('bots.nav.backTo', { name: profileBot.bot.name })}
                  variant="glass"
                  size="small"
                  style={styles.heroAction}
                  onPress={() => openThread(router, { c: profileBot.dm!, title: profileBot.bot!.name })}
                />
              ) : null}
              {botsOn && !profileBot ? (
                <>
                  <HomeBridge />
                  <BotsShelf />
                </>
              ) : null}
            </Animated.View>
          </Animated.View>
        </Animated.View>
      ) : null}

      {/* an existing conversation: another Bots conversation needing the member floats under the nav bar */}
      {botsOn && sessionId ? (
        <View pointerEvents="box-none" style={[styles.capsule, { top: headerHeight + space.xs }]}>
          <AttentionCapsule excludeSid={null} />
        </View>
      ) : null}

      {convo.loading && !messages.length ? (
        <LoadingState style={[styles.center, { top: headerHeight, bottom: composerH + composerBottom }]} />
      ) : null}
      {convo.loadFailed ? (
        <View style={[styles.center, { top: headerHeight, bottom: composerH + composerBottom }]}>
          <EmptyState
            icon="alert"
            title={t('chat.loadFailed')}
            onRetry={() => void reload()}
            style={styles.stretch}
          />
        </View>
      ) : null}

      {/* floating control layer: jump-to-latest + composer, riding the keyboard */}
      <KeyboardStickyView offset={stickyOffset} style={styles.sticky}>
        {!endVisible && messages.length && !convo.loading ? (
          <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(140)} style={styles.jumpWrap}>
            <NativeButton
              label={streaming ? t('chat.newContent') : t('chat.jumpLatest')}
              icon="arrowDown"
              variant="glass"
              size="small"
              onPress={jumpToLatest}
            />
          </Animated.View>
        ) : null}
        {/* Android: the input row sits on the page surface (Material, as in Messages) —
            iOS lets content flow under its glass */}
        <View style={[{ paddingBottom: composerBottom }, Platform.OS === 'android' && { backgroundColor: c.background }]}>
          {readOnly ? (
            <ReadOnlyBar onHeight={onComposerHeight} />
          ) : (
            <Composer
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              onSend={send}
              streaming={streaming}
              onStop={stop}
              onAttach={onAttach}
              annotations={annotations}
              onRemoveAnnotation={removeAnnotation}
              images={images}
              onRemoveImage={removeImage}
              maxImages={MAX_IMAGES}
              placeholder={sessionId ? t('chat.followUpPlaceholder') : t('home.heroPlaceholder')}
              showProfile={isNew && !profileBot}
              autoFocus={params.compose === '1'}
              onHeight={onComposerHeight}
            />
          )}
        </View>
      </KeyboardStickyView>
    </View>
  );
}

/* ------------------------------ home: a Bots thread or the conversation ------------------------------ */

/** A cold start reopens the last Bots thread at most once per process (D3); warm starts stay where they are. */
let restoreSettled = false;
/** How long a cold start waits for persisted prefs before settling on a new chat. */
const RESTORE_WAIT_MS = 400;

/**
 * The home route (D2): `?c=` renders the Bots thread — keyed by session, so
 * another thread is a fresh screen and its engine — anything else the
 * conversation screen, which stays exactly as it was. The first time a bare
 * home mounts in a process, the thread the member left the app in comes back
 * (src/bots/home/initial-surface.ts): rendered at once, and the route is
 * pointed at it with `setParams` (same screen, no animation). Which thread is
 * open is remembered per station + account for the next cold start; any chat
 * or new chat forgets it.
 */
export default function Home() {
  const raw = useLocalSearchParams<{ [K in keyof HomeParams]?: string }>();
  const params = homeParams({
    id: raw.id,
    c: raw.c,
    title: raw.title,
    ro: raw.ro === '1' ? '1' : '0',
    compose: raw.compose === '1' ? '1' : '',
    request: raw.request,
    profile: raw.profile,
  });
  const router = useRouter();
  const focused = useIsFocused();
  const hydrated = usePrefs((s) => s.hydrated);
  const [settled, setSettled] = useState(restoreSettled);
  const [gaveUp, setGaveUp] = useState(false);
  // The restored thread, shown until the route's own `c` catches up with `setParams`.
  const [restored, setRestored] = useState<LastThread | null>(null);

  const surface = settled
    ? null
    : initialSurface({
        params,
        hydrated: hydrated || gaveUp,
        last: hydrated ? lastThread() : null,
        botsEnabled: botsEnabledNow(),
        restored: restoreSettled,
        // a cold-start deep link stacked over home decides where home points
        covered: !focused,
      });
  const kind = surface?.kind;
  const target = surface?.kind === 'thread' ? surface : null;
  const targetC = target?.c;
  const targetTitle = target?.title;

  useEffect(() => {
    if (settled || !kind) return;
    if (kind === 'wait') {
      const timer = setTimeout(() => setGaveUp(true), RESTORE_WAIT_MS);
      return () => clearTimeout(timer);
    }
    restoreSettled = true;
    if (kind === 'thread' && targetC) {
      setRestored({ c: targetC, title: targetTitle ?? '' });
      // all seven keys (a fresh literal: router params want an index signature)
      router.setParams({ ...homeParams({ c: targetC, title: targetTitle }) });
    }
    setSettled(true);
  }, [settled, kind, targetC, targetTitle, router]);

  useEffect(() => {
    if (restored && params.c === restored.c) setRestored(null);
  }, [restored, params.c]);

  const pending = target ?? restored;
  const c = params.c || pending?.c || '';
  const title = params.c ? params.title : (pending?.title ?? '');
  // Android has no Bots surfaces in v1 (§2.9): a stray `?c=` stays the conversation screen.
  const thread = BOTS_PLATFORM_READY && !!c;

  // Remember the open thread for the next cold start — with its real title once the list knows it.
  const copy = useRowCopy();
  const knownTitle = useBots((s) => {
    if (!thread) return '';
    const row = s.conversations.find((r) => r.session_id === c);
    return row ? rowTitle(row, s, copy) : '';
  });
  useEffect(() => {
    if (!settled || !hydrated) return;
    if (thread) rememberThread({ c, title: knownTitle || title });
    else forgetThread();
  }, [settled, hydrated, thread, c, knownTitle, title]);

  if (kind === 'wait') return <RestoreWait />;
  return thread ? (
    <BotThreadScreen key={c} sessionId={c} title={title} request={params.request} compose={params.compose === '1'} />
  ) : (
    <Conversation />
  );
}

/** The plain surface a cold start shows while it waits (≤ 400 ms) for prefs — no hero to flash away. */
function RestoreWait() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <>
      <Stack.Screen options={{ title: '' }} />
      <View style={styles.root} />
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  scroll: { flex: 1 },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs + 2,
    paddingHorizontal: space.margin,
    paddingBottom: space.md,
  },
  heroWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
  hero: { alignItems: 'center', paddingHorizontal: space.xxl, gap: space.xs },
  heroFace: { alignItems: 'center', gap: space.xs },
  heroTitle: { ...typo.title2, color: c.label, textAlign: 'center', marginTop: space.md },
  heroSub: { ...typo.body, color: c.secondaryLabel, textAlign: 'center' },
  heroHint: { ...typo.footnote, color: c.secondaryLabel, textAlign: 'center', marginTop: space.xs },
  heroAction: { marginTop: space.md },
  capsule: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  stretch: { alignSelf: 'stretch' },
  sticky: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  jumpWrap: { position: 'absolute', bottom: '100%', alignSelf: 'center', paddingBottom: space.xs },
}));
