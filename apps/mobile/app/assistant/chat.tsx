/**
 * One conversation with the assistant (`/assistant/chat?session=`): the saved messages, then the
 * reply as it streams in (src/assistant/send.ts → src/data/chat-stream.ts), with "Thinking…" or
 * the tool in use until words arrive. Whatever happens to the stream, the saved messages are read
 * again at the end — while the server still writes the reply, the screen waits for that run.
 * Everything belongs to the station and account that opened the conversation.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chatRun, getSession } from '../../src/api/assistant';
import { sendMessage } from '../../src/assistant/send';
import { applyEvent, EMPTY_REPLY, visibleMessages, type LiveReply } from '../../src/data/chat-stream';
import { captureIdentity } from '../../src/data/identity';
import { useT } from '../../src/lib/i18n';
import { Markdown } from '../../src/markdown';
import type { ChatMessage } from '../../src/shared/greenhouse-types';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme } from '../../src/theme';
import { Icon, Spinner } from '../../src/ui/core';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';

type Item =
  | { key: string; kind: 'message'; message: ChatMessage }
  | { key: string; kind: 'pending'; text: string }
  | { key: string; kind: 'reply'; reply: LiveReply };

/** The navigation bar's height under the status bar (iOS 44, Android 56); the list's top inset. */
const NAV_BAR = 56;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function Chat() {
  const { session: sessionId } = useLocalSearchParams<{ session?: string }>();
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [reply, setReply] = useState<LiveReply | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const list = useRef<FlatList<Item>>(null);
  // follow the reply only once the conversation is taller than the screen (a short one stays
  // where the header inset puts it)
  const viewport = useRef(0);
  const alive = useRef(true);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);

  const reload = useCallback(async (current: () => boolean) => {
    if (!sessionId) return;
    const result = await getSession(sessionId);
    if (!alive.current || !current()) return;
    if (result.ok) {
      setMessages(visibleMessages(result.data.messages));
      setTitle(result.data.session.title);
      setFailed(false);
    } else if (result.status === 404 || result.status === 403) setMissing(true);
    else setFailed(true);
  }, [sessionId]);

  useEffect(() => {
    void reload(captureIdentity());
  }, [reload]);

  const send = async () => {
    const text = draft.trim();
    if (!sessionId || !text || sending) return;
    const current = captureIdentity();
    const controller = new AbortController();
    abort.current = controller;
    setDraft('');
    setPending(text);
    setReply(EMPTY_REPLY);
    setSending(true);
    const outcome = await sendMessage(
      sessionId,
      text.slice(0, 20_000),
      (event) => {
        if (alive.current && current()) setReply((before) => applyEvent(before ?? EMPTY_REPLY, event));
      },
      controller.signal,
    );
    if (!alive.current || !current()) return;
    if (!outcome.ok) {
      setPending(null);
      setReply(null);
      setSending(false);
      if (outcome.status !== 409) setDraft(text);
      alertError(outcome.status === 409 ? t('assistant.busy') : t('assistant.sendFailed'), outcome.message || undefined);
      return;
    }
    if (!outcome.finished) {
      // the stream broke off: wait for the server's run to end (at most a minute), then read what it saved
      for (let i = 0; i < 40; i += 1) {
        const run = await chatRun(sessionId);
        if (!alive.current || !current() || !run.ok || !run.data.active) break;
        await sleep(1500);
      }
    }
    await reload(current);
    if (!alive.current || !current()) return;
    setPending(null);
    setReply(null);
    setSending(false);
  };

  const items: Item[] = [
    ...(messages ?? []).map((message): Item => ({ key: `m-${message.id}`, kind: 'message', message })),
    ...(pending ? [{ key: 'pending', kind: 'pending', text: pending } as Item] : []),
    ...(reply ? [{ key: 'reply', kind: 'reply', reply } as Item] : []),
  ];

  if (!sessionId || missing) {
    return (
      <View style={styles.root}>
        <Stack.Screen options={{ title: t('nav.assistant') }} />
        <EmptyState icon="msgs" title={t('assistant.notFound')} style={styles.state} />
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
      <Stack.Screen options={{ title: reply?.title || title || t('assistant.untitled') }} />
      <FlatList<Item>
        ref={list}
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={(item) => item.key}
        keyboardDismissMode="interactive"
        onContentSizeChange={(_, height) => {
          // the visible part is the screen under the bar (status bar + navigation bar)
          if (height > viewport.current - insets.top - NAV_BAR) list.current?.scrollToEnd({ animated: true });
        }}
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
                {!live.text || live.tool ? (
                  <View style={styles.typing} accessibilityLiveRegion="polite">
                    <Spinner size="small" />
                    <Text style={styles.typingText}>
                      {live.tool ? t('assistant.usingTool', { tool: live.tool }) : t('assistant.thinking')}
                    </Text>
                  </View>
                ) : null}
                {live.error ? <Text style={styles.error}>{live.error}</Text> : null}
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
          messages ? (
            <Text style={styles.hint}>{t('assistant.startHint')}</Text>
          ) : failed ? (
            <EmptyState icon="alert" title={t('assistant.loadFailed')} onRetry={() => void reload(captureIdentity())} style={styles.state} />
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
            disabled={!draft.trim() || sending}
            accessibilityRole="button"
            accessibilityLabel={t('assistant.send')}
            accessibilityState={{ disabled: !draft.trim() || sending }}
            style={({ pressed }) => [styles.send, (!draft.trim() || sending) && styles.sendOff, pressed && { opacity: 0.7 }]}
          >
            {sending ? <Spinner size="small" color={c.onAccent} /> : <Icon name="up" size={18} color={c.onAccent} />}
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
  typingText: { ...typo.subheadline, color: c.secondaryLabel },
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
