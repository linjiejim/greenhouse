/**
 * Home — the conversation surface, living inside the slide drawer. One route serves every
 * conversation (src/shell/nav.ts — all five params on every navigation):
 *
 *  - no `c`: the main thread, where the app lands (CONV-01). Its id comes from the directory;
 *    the one remembered for this station + member opens at once on a cold start
 *    (src/shell/main-thread.ts);
 *  - `c=new`: a new chat (src/conversation/new-chat.tsx), with `agent` its Agent;
 *  - `c=<id>`: that conversation (src/conversation/screen.tsx), remounted per conversation.
 *
 * What is on screen is published for the drawer and the push presenter (src/shell/surface.ts).
 * The screen under the launch splash reports when its first content is in.
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { ConversationScreen } from '../../../src/conversation/screen';
import { NewChatScreen } from '../../../src/conversation/new-chat';
import { useT } from '../../../src/lib/i18n';
import { rememberMainThread, rememberedMainThread } from '../../../src/shell/main-thread';
import { NEW_CHAT, homeParams, type HomeParams } from '../../../src/shell/nav';
import { useHomeSurface } from '../../../src/shell/surface';
import { useStartupContent } from '../../../src/startup/context';
import { usePrefs } from '../../../src/store/prefs';
import { useAuth } from '../../../src/store/auth';
import { useThreads } from '../../../src/store/threads';
import { mainConversationId, useWorkspace } from '../../../src/store/workspace';
import { useTheme } from '../../../src/theme';
import { EmptyState, LoadingState } from '../../../src/ui/empty';

export default function Home() {
  const raw = useLocalSearchParams<{ [K in keyof HomeParams]?: string }>();
  const params = homeParams({
    c: raw.c,
    agent: raw.agent,
    title: raw.title,
    compose: raw.compose === '1' ? '1' : '',
    request: raw.request,
  });
  const router = useRouter();
  const t = useT();
  const { colors: c } = useTheme();
  const focused = useIsFocused();
  const member = useAuth((s) => s.user?.id);
  const hydrated = usePrefs((s) => s.hydrated);
  const loaded = useWorkspace((s) => s.conversations !== null);
  const loadFailed = useWorkspace((s) => s.loadFailed);
  const directoryMain = useWorkspace((s) => mainConversationId(s));
  const mainTitle = useWorkspace((s) => s.agents?.find((agent) => agent.is_main)?.name ?? '');

  // The directory: loaded once per identity (the drawer and every screen read it).
  useEffect(() => {
    if (!loaded) void useWorkspace.getState().refresh();
  }, [loaded]);

  // Remember the main thread for the next cold start, whenever the directory names it.
  useEffect(() => {
    if (hydrated && directoryMain) rememberMainThread({ c: directoryMain, title: mainTitle });
  }, [hydrated, directoryMain, mainTitle]);

  const remembered = useMemo(() => (hydrated ? rememberedMainThread() : null), [hydrated]);
  const newChat = params.c === NEW_CHAT;
  const conversationId = newChat ? '' : params.c || directoryMain || remembered?.c || '';
  const title = params.c ? params.title : mainTitle || remembered?.title || '';

  // What is on screen, for the drawer and the push presenter.
  const publish = useHomeSurface((s) => s.publish);
  useEffect(() => {
    publish({ conversationId, newChat, visible: focused && AppState.currentState === 'active' });
  }, [publish, conversationId, newChat, focused]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => publish({ visible: state === 'active' && focused }));
    return () => sub.remove();
  }, [publish, focused]);

  // The splash waits for the first page of the conversation it covers (bounded by the splash itself).
  const threadReady = useThreads((s) =>
    conversationId ? s.threads[conversationId]?.status !== 'loading' && !!s.threads[conversationId] : false,
  );
  useStartupContent(newChat ? loaded : threadReady || (loaded && !conversationId) || loadFailed);

  const clearRequest = useCallback(() => router.setParams({ request: '' }), [router]);

  if (!member) return null;
  if (newChat)
    return <NewChatScreen key={`new:${params.agent}`} agentId={params.agent} compose={params.compose === '1'} />;
  if (!conversationId) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: '' }} />
        {loadFailed ? (
          <EmptyState
            icon="alert"
            title={t('conversation.loadFailed')}
            onRetry={() => void useWorkspace.getState().refresh()}
          />
        ) : (
          <LoadingState />
        )}
      </View>
    );
  }
  return (
    <ConversationScreen
      key={conversationId}
      conversationId={conversationId}
      title={title}
      request={params.request}
      compose={params.compose === '1'}
      onRequestSeen={clearRequest}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
