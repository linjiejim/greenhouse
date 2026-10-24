/**
 * One conversation with the assistant (`/assistant/chat?session=`). The behaviour lives in
 * src/data/conversation.ts: the latest messages first and older ones as you scroll up, my message
 * and the streaming reply until the saved transcript holds them (with a retry when it does not
 * yet), following a reply that is still being written when the conversation opens or comes back
 * into view, and my words back in the box when a send is refused. Everything belongs to the
 * station and account that opened the conversation.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chatRun, getMessages, getSessionInfo } from '../../src/api/assistant';
import { followRun, sendMessage } from '../../src/assistant/send';
import { visibleMessages, type LiveReply } from '../../src/data/chat-stream';
import { CLOSED_CONVERSATION, Conversation, headOf, tailOf, type ConversationState } from '../../src/data/conversation';
import { atEnd, shouldFollowEnd } from '../../src/data/follow-end';
import { captureIdentity } from '../../src/data/identity';
import { useT } from '../../src/lib/i18n';
import { Markdown } from '../../src/markdown';
import type { ChatMessage } from '../../src/shared/greenhouse-types';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme } from '../../src/theme';
import { NativeButton } from '../../src/ui/button';
import { Icon, Spinner } from '../../src/ui/core';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';

type Item =
  | { key: string; kind: 'message'; message: ChatMessage }
  | { key: string; kind: 'pending'; text: string }
  | { key: string; kind: 'reply'; reply: LiveReply };

/** The navigation bar's height under the status bar (iOS 44, Android 56); the list's top inset. */
const NAV_BAR = 56;

const noSubscription = () => () => {};
const closed = (): ConversationState<ChatMessage> => CLOSED_CONVERSATION;

export default function Chat() {
  const { session: sessionId } = useLocalSearchParams<{ session?: string }>();
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState('');
  const list = useRef<FlatList<Item>>(null);
  // follow the reply only once the conversation is taller than the screen (a short one stays
  // where the header inset puts it)
  const viewport = useRef(0);
  // pinned to the end while the member is at the bottom (src/data/follow-end.ts)
  const pinned = useRef(true);
  const shape = useRef({ head: '', tail: '' });

  const conversation = useMemo(() => {
    if (!sessionId) return null;
    return new Conversation<ChatMessage>({
      title: async () => {
        const result = await getSessionInfo(sessionId);
        return result.ok ? { ok: true, data: { title: result.data.session.title } } : result;
      },
      latestPage: () => getMessages(sessionId),
      olderPage: (before) => getMessages(sessionId, before),
      send: (text, onEvent, signal) => sendMessage(sessionId, text.slice(0, 20_000), onEvent, signal),
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

  useEffect(() => {
    if (!conversation) return;
    void conversation.open();
    return () => conversation.dispose();
  }, [conversation]);

  // back in view (not the first focus): catch up with a reply written meanwhile
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

  const send = async () => {
    const text = draft;
    if (!conversation || !text.trim() || state.busy) return;
    setDraft('');
    // sending takes me to the end of the conversation
    pinned.current = true;
    const result = await conversation.send(text);
    if (result.sent) return;
    // my words come back to the box whatever refused them
    setDraft((now) => now || result.restore);
    alertError(result.notice === 'busy' ? t('assistant.busy') : t('assistant.sendFailed'), result.message || undefined);
  };

  const items: Item[] = [
    ...visibleMessages(state.transcript?.messages ?? []).map(
      (message): Item => ({ key: `m-${message.seq}`, kind: 'message', message }),
    ),
    ...(state.pending ? [{ key: 'pending', kind: 'pending', text: state.pending } as Item] : []),
    ...(state.reply ? [{ key: 'reply', kind: 'reply', reply: state.reply } as Item] : []),
  ];

  if (!sessionId || state.missing) {
    return (
      <View style={styles.root}>
        <Stack.Screen options={{ title: t('nav.assistant') }} />
        <ScrollView contentInsetAdjustmentBehavior="automatic">
          <EmptyState icon="msgs" title={t('assistant.notFound')} style={styles.state} />
        </ScrollView>
      </View>
    );
  }

  return (
    <View
      style={styles.root}
      onLayout={(e) => {
        viewport.current = e.nativeEvent.layout.height;
      }}
    >
      <Stack.Screen options={{ title: state.title || t('assistant.untitled') }} />
      <FlatList<Item>
        ref={list}
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={(item) => item.key}
        keyboardDismissMode="interactive"
        // older history comes in at the top without moving what is on screen
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onStartReached={() => void conversation?.loadOlder()}
        onStartReachedThreshold={0.5}
        scrollEventThrottle={32}
        onScroll={(e) => {
          const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
          pinned.current = atEnd({
            offsetY: contentOffset.y,
            viewportHeight: layoutMeasurement.height,
            contentHeight: contentSize.height,
          });
        }}
        onContentSizeChange={(_, height) => {
          const next = { head: headOf(state), tail: tailOf(state) };
          const follow = shouldFollowEnd({
            pinned: pinned.current,
            head: next.head,
            prevHead: shape.current.head,
            tail: next.tail,
            prevTail: shape.current.tail,
          });
          shape.current = next;
          // the visible part is the screen under the bar (status bar + navigation bar)
          if (follow && height > viewport.current - insets.top - NAV_BAR) list.current?.scrollToEnd({ animated: true });
        }}
        ListHeaderComponent={state.loadingOlder ? <Spinner style={styles.older} /> : null}
        renderItem={({ item }) => {
          if (item.kind === 'message' && item.message.role === 'assistant') {
            return (
              <View style={styles.assistant}>
                <Markdown source={item.message.content} />
              </View>
            );
          }
          if (item.kind === 'reply') {
            const live = item.reply;
            return (
              <View style={styles.assistant}>
                {live.text ? <Markdown source={live.text} /> : null}
                {state.busy && (!live.text || live.tool) ? (
                  <View style={styles.typing} accessibilityLiveRegion="polite">
                    <Spinner size="small" />
                    <Text style={styles.note}>
                      {live.tool ? t('assistant.usingTool', { tool: live.tool }) : t('assistant.thinking')}
                    </Text>
                  </View>
                ) : null}
                {live.error ? <Text style={styles.error}>{live.error}</Text> : null}
                {state.streamFailed ? <Text style={styles.error}>{t('assistant.streamFailed')}</Text> : null}
                {state.unreconciled ? (
                  <View style={styles.unsynced}>
                    <Text style={styles.note}>{t('assistant.unreconciled')}</Text>
                    <NativeButton
                      label={t('common.retry')}
                      icon="refresh"
                      onPress={() => void conversation?.reconcile()}
                    />
                  </View>
                ) : null}
              </View>
            );
          }
          const text = item.kind === 'pending' ? item.text : item.message.content;
          return (
            <View style={styles.userRow}>
              <View style={styles.user}>
                <Text style={styles.userText} selectable>
                  {text}
                </Text>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          state.transcript ? (
            <Text style={styles.hint}>{t('assistant.startHint')}</Text>
          ) : state.loadFailed ? (
            <EmptyState
              icon="alert"
              title={t('assistant.loadFailed')}
              onRetry={() => void conversation?.refocus()}
              style={styles.state}
            />
          ) : (
            <LoadingState style={styles.state} />
          )
        }
        contentContainerStyle={[styles.content, { paddingBottom: 96 + insets.bottom }]}
      />
      <KeyboardStickyView offset={{ opened: insets.bottom }} style={styles.composerWrap}>
        <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('assistant.placeholder')}
            placeholderTextColor={c.placeholder}
            style={styles.input}
            multiline
            maxLength={20_000}
            accessibilityLabel={t('assistant.placeholder')}
          />
          <Pressable
            onPress={() => void send()}
            disabled={!draft.trim() || state.busy}
            accessibilityRole="button"
            accessibilityLabel={t('assistant.send')}
            accessibilityState={{ disabled: !draft.trim() || state.busy }}
            style={({ pressed }) => [
              styles.send,
              (!draft.trim() || state.busy) && styles.sendOff,
              pressed && { opacity: 0.7 },
            ]}
          >
            {state.busy ? <Spinner size="small" color={c.onAccent} /> : <Icon name="up" size={18} color={c.onAccent} />}
          </Pressable>
        </View>
      </KeyboardStickyView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  content: { paddingHorizontal: space.margin, paddingTop: space.md, gap: space.md },
  state: { paddingTop: space.xxxl },
  older: { paddingVertical: space.md },
  assistant: { alignSelf: 'stretch' },
  userRow: { alignItems: 'flex-end' },
  user: {
    maxWidth: '85%',
    paddingHorizontal: space.md + 2,
    paddingVertical: space.sm + 2,
    borderRadius: radius.bubble,
    backgroundColor: c.accentFill,
    ...squircle,
  },
  userText: { ...typo.body, color: c.label },
  typing: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  note: { ...typo.subheadline, color: c.secondaryLabel },
  unsynced: { marginTop: space.sm, gap: space.sm, alignItems: 'flex-start' },
  error: { ...typo.footnote, color: c.red, marginTop: space.xs },
  hint: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center', marginTop: space.xxxl },
  composerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.margin,
    paddingTop: space.sm,
    backgroundColor: c.background,
    borderTopWidth: 0.5,
    borderTopColor: c.separator,
  },
  input: {
    flex: 1,
    ...typo.body,
    color: c.label,
    maxHeight: 140,
    minHeight: HIT,
    paddingHorizontal: space.md,
    paddingTop: space.sm + 2,
    paddingBottom: space.sm + 2,
    borderRadius: radius.bubble,
    backgroundColor: c.secondaryBackground,
    ...squircle,
  },
  send: {
    width: HIT,
    height: HIT,
    borderRadius: radius.full,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendOff: { opacity: 0.4 },
}));
