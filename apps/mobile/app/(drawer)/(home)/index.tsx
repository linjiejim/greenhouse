/**
 * 首页 — where a conversation starts:
 *
 *  - the bar: 「我」 (→ the sheet: account, station, text size, my agents, settings) on the left;
 *    search (→ the search page) and the bell with the unread count (→ notifications) on the right;
 *  - the assistant's sprout (src/ui/greeting-sprout.tsx: it waves; each tap answers with a
 *    bounce and the next face, quick taps make an easter egg) and a greeting; a quiet line when
 *    something waits for me;
 *  - my five latest conversations, one line each, pinned first (swipe to pin), and 全部 (→ the
 *    all-conversations sheet with search); kept on the phone, so they show at once and offline;
 *  - the composer: words, + (photos, camera, files — uploaded as they are picked, into a
 *    conversation made for them). Sending opens the conversation page with the
 *    message on its way; offline it waits in the outbox. While it has focus the recent list
 *    fades away (in place, nothing moves) and comes back when it lets go.

 *
 * The launch splash waits for the first list (saved or fresh) under it.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View, type TextInput } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { createSession } from '../../../src/api/assistant';
import { Composer } from '../../../src/chat/composer';
import { sentParts } from '../../../src/chat/composer-files';
import { ConversationRow } from '../../../src/chat/conversation-row';
import { useComposerFiles } from '../../../src/chat/use-composer-files';
import { useChatAgents } from '../../../src/chat/use-agents';
import { greetingFor } from '../../../src/data/home';
import { usePrefs } from '../../../src/store/prefs';
import { captureIdentity } from '../../../src/data/identity';
import { putHandoff } from '../../../src/lib/handoff';
import { useT } from '../../../src/lib/i18n';
import { softAskWhenSettled } from '../../../src/push/soft-ask';
import { useStartupContent } from '../../../src/startup/context';
import { useAuth } from '../../../src/store/auth';
import { useNotifications } from '../../../src/store/notifications';
import { queueTurn } from '../../../src/store/outbox';
import { useSessions } from '../../../src/store/sessions';
import { HIT, makeStyles, motion, space, typo, useTheme, weight } from '../../../src/theme';
import { Icon, Touchable } from '../../../src/ui/core';
import { alertError, promptText } from '../../../src/ui/dialogs';
import { EmptyState } from '../../../src/ui/empty';
import { GreetingSprout } from '../../../src/ui/greeting-sprout';
import { Skeleton } from '../../../src/ui/skeleton';
import { rowPosition } from '../../../src/ui/list';
import { toolbarIcon } from '../../../src/ui/toolbar-icon';
import { SidebarToolbar } from '../../../src/ui/sidebar';
import type { FirstTurn } from './chat';

/** A provider of its own, so the insets are this screen's: the composer's solid band reaches the bottom edge. */
export default function HomeScreen() {
  return (
    <SafeAreaProvider>
      <Home />
    </SafeAreaProvider>
  );
}

function Home() {
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const insets = useSafeAreaInsets();
  const user = useAuth((s) => s.user);
  const sessions = useSessions((s) => s.items);
  const status = useSessions((s) => s.status);
  const offline = useSessions((s) => s.offline);
  const unread = useNotifications((s) => s.unread);
  const needsYou = useNotifications((s) => s.items.filter((n) => !n.read_at && n.kind === 'runtime_attention').length);
  const [draft, setDraft] = useState('');
  const [composerHeight, setComposerHeight] = useState(64);
  const input = useRef<TextInput>(null);
  // the agent a new conversation starts with (offered only where there is more than Sprouty)
  const agents = useChatAgents();
  const [agentId, setAgentId] = useState<string | null>(null);
  // writing: the recent list steps back (fades in place) so the composer is the one thing in view
  const [composing, setComposing] = useState(false);
  const recentShown = useSharedValue(1);
  useEffect(() => {
    recentShown.value = withTiming(composing ? 0 : 1, {
      duration: composing ? motion.exit : motion.base,
      reduceMotion: ReduceMotion.System,
    });
  }, [composing, recentShown]);
  const recentFade = useAnimatedStyle(() => ({ opacity: recentShown.value }));

  // back on home (from a conversation, a sheet): the list catches up
  useFocusEffect(
    useCallback(() => {
      if (!user?.id) return;
      void useSessions.getState().refresh();
      void useNotifications.getState().refresh();
    }, [user?.id]),
  );

  // the splash leaves once a list (saved or fresh) or a failure is here
  useStartupContent(status !== 'empty');
  const notifications = useNotifications((s) => s.status);
  useEffect(() => {
    if (notifications === 'ready') void softAskWhenSettled();
  }, [notifications]);

  // a conversation is made the first time a file is picked; sending moves to its page
  const made = useRef<string | null>(null);
  const ensureSession = useCallback(async () => {
    if (made.current) return made.current;
    const current = captureIdentity();
    const result = await createSession(agentId);
    if (!current()) return null;
    if (!result.ok) {
      if (result.status !== 0) alertError(t('assistant.sendFailed'), result.message || undefined);
      return null;
    }
    made.current = result.data.id;
    return made.current;
  }, [t, agentId]);
  const files = useComposerFiles(ensureSession);

  const send = async () => {
    const text = draft;
    const parts = sentParts(files.files);
    if (!text.trim() && !parts.images.length && !parts.attachments.length) return;
    const sessionId = await ensureSession();
    if (!sessionId) {
      // the station cannot be reached: the message waits and goes once it can
      if (parts.attachments.length) return;
      if (!queueTurn({ sessionId: null, text, images: parts.images })) {
        // the outbox is full: the words stay in the box
        alertError(t('conversation.outboxFull'));
        return;
      }
      setDraft('');
      files.clear();
      alertError(t('home.queuedTitle'), t('home.queuedHint'));
      return;
    }
    const turn: FirstTurn = { text, images: parts.images, attachments: parts.attachments };
    made.current = null;
    setDraft('');
    files.clear();
    router.push({ pathname: '/chat', params: { session: sessionId, k: putHandoff('first-turn', turn) } });
  };

  const rename = async (id: string, title: string | null) => {
    const next = await promptText({ title: t('home.rename'), defaultValue: title ?? '' });
    if (next) void useSessions.getState().rename(id, next.slice(0, 200));
  };

  const name = user?.nickname?.trim() || '';
  // how many is a setting in 「我」 (0 lists none; the All button stays)
  const recentCount = usePrefs((s) => s.homeRecent);
  const recent = sessions.slice(0, recentCount);

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: '', headerLargeTitleEnabled: false }} />
      {/* the sidebar (places, and 「我」 at its foot) */}
      <SidebarToolbar />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('search')}
          accessibilityLabel={t('common.search')}
          onPress={() => router.push('/search')}
        />
        <Stack.Toolbar.Button
          icon={toolbarIcon('bell')}
          accessibilityLabel={unread > 0 ? t('home.notificationsUnread', { n: unread }) : t('notifications.title')}
          onPress={() => router.push('/notifications')}
        >
          {unread > 0 ? <Stack.Toolbar.Badge>{unread > 99 ? '99+' : String(unread)}</Stack.Toolbar.Badge> : null}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        contentContainerStyle={[styles.content, { paddingBottom: composerHeight + space.xxl }]}
      >
        <GreetingSprout size={88} accessibilityLabel={t('conversation.assistant')} style={styles.hero} />
        <Text style={styles.greeting} accessibilityRole="header">
          {t(`home.greeting.${greetingFor(new Date().getHours())}`, { name })}
        </Text>
        {needsYou > 0 ? (
          <Touchable onPress={() => router.push('/notifications')} style={styles.waiting} accessibilityRole="button">
            <Icon name="hand" size={14} color={c.orange} />
            <Text style={styles.waitingText}>{t('home.needsYou', { n: needsYou })}</Text>
          </Touchable>
        ) : null}

        <Animated.View
          style={recentFade}
          pointerEvents={composing ? 'none' : 'auto'}
          accessibilityElementsHidden={composing}
          importantForAccessibility={composing ? 'no-hide-descendants' : 'auto'}
        >
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle} accessibilityRole="header">
              {t('home.recent')}
            </Text>
            {sessions.length ? (
              <Touchable
                onPress={() => router.push('/conversations')}
                accessibilityRole="button"
                hitSlop={8}
                style={styles.all}
              >
                <Text style={styles.allText}>{t('home.all')}</Text>
              </Touchable>
            ) : null}
          </View>
          {offline ? <Text style={styles.offline}>{t('common.savedCopy')}</Text> : null}
          {recentCount === 0 ? null : recent.length ? (
            <View>
              {recent.map((session, index) => (
                <ConversationRow
                  key={session.id}
                  session={session}
                  position={rowPosition(index, recent.length)}
                  compact
                  onOpen={() => router.push({ pathname: '/chat', params: { session: session.id } })}
                  onPin={(pinned) => void useSessions.getState().pin(session.id, pinned)}
                  onRename={() => void rename(session.id, session.title)}
                />
              ))}
            </View>
          ) : status === 'empty' ? (
            <Skeleton rows={recentCount} />
          ) : status === 'error' ? (
            <EmptyState
              icon="alert"
              title={t('assistant.loadFailed')}
              onRetry={() => void useSessions.getState().refresh()}
              style={styles.state}
            />
          ) : (
            <Text style={styles.empty}>{t('home.noConversations')}</Text>
          )}
        </Animated.View>
      </ScrollView>

      <KeyboardStickyView offset={{ opened: insets.bottom }} style={styles.composerWrap}>
        <Composer
          ref={input}
          value={draft}
          onChangeText={setDraft}
          onSend={() => void send()}
          onAttach={(from) => void files.attach(from)}
          files={files.files}
          onRemoveFile={files.remove}
          onRetryFiles={files.retry}
          placeholder={t('composer.placeholder')}
          onHeight={setComposerHeight}
          bottomInset={insets.bottom}
          grouped
          agents={agents}
          agentId={agentId}
          onAgent={setAgentId}
          onFocusChange={setComposing}
        />
      </KeyboardStickyView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.md },
  hero: { alignSelf: 'flex-start', marginHorizontal: space.margin + space.xs, marginBottom: space.md },
  greeting: { ...typo.title1, color: c.label, marginHorizontal: space.margin + space.xs },
  waiting: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.xs,
    marginHorizontal: space.margin + space.xs,
    marginTop: space.sm,
    minHeight: HIT - space.sm,
  },
  waitingText: { ...typo.subheadline, color: c.orange },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.xxl,
    marginHorizontal: space.margin + space.xs,
    marginBottom: space.sm,
  },
  sectionTitle: { ...typo.headline, color: c.label },
  all: { minHeight: HIT, justifyContent: 'center' },
  allText: { ...typo.body, fontWeight: weight.semibold, color: c.accent },
  offline: {
    ...typo.footnote,
    color: c.secondaryLabel,
    marginHorizontal: space.margin + space.xs,
    marginBottom: space.sm,
  },
  state: { paddingTop: space.xl },
  empty: { ...typo.subheadline, color: c.secondaryLabel, marginHorizontal: space.margin + space.xs },
  composerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
}));
