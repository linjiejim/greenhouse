/**
 * Assistant (助手): my conversations with the in-app assistant, newest first and a page at a time
 * as the list scrolls (each page bound to the identity that asked), and a compose button for a
 * new one. Light by design — the full chat with agents and tools lives on the web.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { createSession, listSessions, SESSION_PAGE } from '../../src/api/assistant';
import { captureIdentity } from '../../src/data/identity';
import { appendUnique, nextOffset } from '../../src/data/paging';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import { relativeTimeNow } from '../../src/lib/time-words';
import type { ChatSession } from '../../src/shared/greenhouse-types';
import { makeStyles, space, useTheme } from '../../src/theme';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, type RowPosition } from '../../src/ui/list';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

export default function Assistant() {
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const load = useCallback(async () => {
    const result = await listSessions(0);
    return result.ok
      ? {
          ok: true as const,
          data: {
            sessions: result.data.sessions,
            next: nextOffset(result.data.page, result.data.sessions.length, SESSION_PAGE, 0),
          },
        }
      : result;
  }, []);
  const resource = useResource(load);
  const first = resource.data;

  // later pages, cleared whenever the first page is read again
  const [more, setMore] = useState<{ first: typeof first; sessions: ChatSession[]; next: number | null }>({
    first: null,
    sessions: [],
    next: null,
  });
  const extra = useMemo(
    () => (more.first === first ? more : { first, sessions: [] as ChatSession[], next: first?.next ?? null }),
    [more, first],
  );
  const loadingMore = useRef(false);
  const loadMore = useCallback(async () => {
    if (!first || extra.next == null || loadingMore.current) return;
    loadingMore.current = true;
    const current = captureIdentity();
    const offset = extra.next;
    const page = await listSessions(offset);
    loadingMore.current = false;
    if (!current() || !page.ok) return;
    setMore({
      first,
      sessions: [...extra.sessions, ...page.data.sessions],
      next: nextOffset(page.data.page, page.data.sessions.length, SESSION_PAGE, offset),
    });
  }, [first, extra]);
  const sessions = useMemo(() => appendUnique(first?.sessions ?? [], extra.sessions), [first, extra.sessions]);
  const [starting, setStarting] = useState(false);

  const start = async () => {
    if (starting) return;
    const current = captureIdentity();
    setStarting(true);
    const result = await createSession();
    setStarting(false);
    if (!current()) return;
    if (!result.ok) {
      alertError(t('assistant.sendFailed'), result.message || undefined);
      return;
    }
    router.push({ pathname: '/assistant/chat', params: { session: result.data.id } });
  };

  const position = (index: number): RowPosition =>
    sessions.length === 1 ? 'only' : index === 0 ? 'first' : index === sessions.length - 1 ? 'last' : 'middle';

  return (
    <>
      <Stack.Screen options={{ title: t('nav.assistant') }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('compose')}
          accessibilityLabel={t('assistant.newChat')}
          disabled={starting}
          onPress={() => void start()}
        />
      </Stack.Toolbar>
      <FlatList<ChatSession>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={sessions}
        keyExtractor={(session) => session.id}
        refreshing={resource.loading && !!resource.data}
        onRefresh={() => void resource.refresh()}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        renderItem={({ item, index }) => (
          <ListRow
            title={item.title?.trim() || t('assistant.untitled')}
            subtitle={relativeTimeNow(item.updated_at)}
            icon="msg"
            accessory="chevron"
            position={position(index)}
            onPress={() => router.push({ pathname: '/assistant/chat', params: { session: item.id } })}
          />
        )}
        ListEmptyComponent={
          !first ? (
            resource.loading ? (
              <LoadingState style={styles.state} />
            ) : (
              <EmptyState icon="alert" title={t('assistant.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
            )
          ) : (
            <EmptyState icon="msgs" title={t('assistant.empty')} message={t('assistant.emptyHint')} style={styles.state} />
          )
        }
        contentContainerStyle={styles.content}
      />
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
}));
