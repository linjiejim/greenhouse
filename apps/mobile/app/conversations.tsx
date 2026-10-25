/**
 * 全部对话 — a sheet over home, in two segments. 我的: my conversations, pinned first (swipe to
 * pin, long press to rename), the ones the phone keeps showing at once; search shows the native
 * field only when asked for and searches every conversation I can read on the station
 * (`/api/search?kind=session`). 共享给我: conversations others shared with me (`/api/shares`,
 * newest first, unread marked), each opening read-only; opening one marks it read. The bar:
 * search (我的 only) and new conversation as one group, ✕ alone at the far right. A conversation
 * opens its page (the sheet closes first).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { searchAll } from '../src/api/assistant';
import { listShares, markShareRead, type SharedConversation } from '../src/api/shares';
import { ConversationRow } from '../src/chat/conversation-row';
import { captureIdentity } from '../src/data/identity';
import { sharedRows, type SharedRow } from '../src/data/shares';
import { useResource } from '../src/data/use-resource';
import { useT } from '../src/lib/i18n';
import { relativeTimeNow } from '../src/lib/time-words';
import type { ChatSession } from '../src/shared/greenhouse-types';
import { useOpenObject } from '../src/shell/open-object';
import { useSessions } from '../src/store/sessions';
import { makeStyles, space, typo, useTheme } from '../src/theme';
import { promptText } from '../src/ui/dialogs';
import { RevealedSearch, useDirectoryFilter } from '../src/ui/directory-search';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { Skeleton } from '../src/ui/skeleton';
import { Row, rowPosition } from '../src/ui/list';
import { usePullRefresh } from '../src/ui/refresh';
import { SheetScreen, type ScreenAction } from '../src/ui/screen';
import { Segmented } from '../src/ui/segmented';

type Tab = 'mine' | 'shared';

type Item =
  | { key: string; type: 'session'; session: ChatSession }
  | { key: string; type: 'share'; row: SharedRow<SharedConversation> };

export default function Conversations() {
  const t = useT();
  const router = useRouter();
  const openObject = useOpenObject();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [tab, setTab] = useState<Tab>('mine');
  const sessions = useSessions((s) => s.items);
  const status = useSessions((s) => s.status);
  const offline = useSessions((s) => s.offline);
  const shares = useResource(listShares);
  const { refresh: refreshShares, setData: setShares } = shares;
  const refresh = useCallback(
    () => (tab === 'mine' ? useSessions.getState().refresh() : refreshShares()),
    [tab, refreshShares],
  );
  const pull = usePullRefresh(refresh);
  const filter = useDirectoryFilter();
  const [searching, setSearching] = useState(false);
  const query = tab === 'mine' ? filter.query.trim() : '';
  const [hits, setHits] = useState<{ id: string; title: string; subtitle?: string }[] | null>(null);

  useEffect(() => {
    void useSessions.getState().refresh();
  }, []);

  useEffect(() => {
    if (!query) {
      setHits(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void searchAll(query, 'session').then((result) => {
        if (!alive) return;
        const group = result.ok ? result.data.groups.find((g) => g.kind === 'session') : undefined;
        setHits(
          (group?.items ?? []).flatMap((item) => (item.sessionId ? [{ id: item.sessionId, title: item.title, subtitle: item.subtitle ?? undefined }] : [])),
        );
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  // the conversation is a page: it opens on the stack under this sheet, which closes first
  const open = (id: string) => openObject({ kind: 'chat', sessionId: id });
  const rename = async (session: ChatSession) => {
    const next = await promptText({ title: t('home.rename'), defaultValue: session.title ?? '' });
    if (next) void useSessions.getState().rename(session.id, next.slice(0, 200));
  };
  // opening a shared conversation reads it: its shares are marked read (quietly; the list follows)
  const openShared = (row: SharedRow<SharedConversation>) => {
    if (row.unread) {
      const current = captureIdentity();
      const now = new Date().toISOString();
      setShares((list) => list?.map((share) => (row.ids.includes(share.id) ? { ...share, read_at: share.read_at ?? now } : share)) ?? list);
      void Promise.all(row.ids.map((id) => markShareRead(id))).then(() => {
        if (current()) void refreshShares();
      });
    }
    open(row.share.session_id);
  };

  const shared = useMemo(() => sharedRows(shares.data ?? []), [shares.data]);
  const items = useMemo(
    (): Item[] =>
      tab === 'mine'
        ? sessions.map((session): Item => ({ key: `s-${session.id}`, type: 'session', session }))
        : shared.map((row): Item => ({ key: `h-${row.share.session_id}`, type: 'share', row })),
    [tab, sessions, shared],
  );

  const empty = useMemo(() => {
    if (tab === 'shared') {
      if (!shares.data) {
        return shares.loading ? (
          <LoadingState style={styles.state} />
        ) : (
          <EmptyState icon="alert" title={t('conversation.sharedFailed')} onRetry={() => void refreshShares()} style={styles.state} />
        );
      }
      return <EmptyState icon="users" title={t('conversation.sharedEmpty')} message={t('conversation.sharedEmptyHint')} style={styles.state} />;
    }
    return status === 'empty' ? (
      <Skeleton rows={8} />
    ) : status === 'error' ? (
      <EmptyState icon="alert" title={t('assistant.loadFailed')} onRetry={() => void useSessions.getState().refresh()} style={styles.state} />
    ) : (
      <EmptyState icon="msgs" title={t(hits ? 'common.noMatches' : 'assistant.empty')} style={styles.state} />
    );
  }, [tab, shares.data, shares.loading, refreshShares, status, hits, styles.state, t]);

  const segmented = (
    <View>
      <Segmented
        value={tab}
        onChange={(value) => {
          setTab(value);
          if (value === 'shared') setSearching(false);
        }}
        options={(['mine', 'shared'] as const).map((value) => ({ value, label: t(`conversation.tabs.${value}`) }))}
        style={styles.segmented}
      />
      {tab === 'mine' && offline ? <Text style={styles.offline}>{t('common.savedCopy')}</Text> : null}
    </View>
  );

  const actions: ScreenAction[] = [
    ...(tab === 'mine'
      ? [
          {
            icon: 'search' as const,
            label: t('common.search'),
            onPress: () => (searching ? filter.ref.current?.focus() : setSearching(true)),
          },
        ]
      : []),
    {
      icon: 'compose',
      label: t('assistant.newChat'),
      onPress: () => {
        router.back();
        setTimeout(() => router.push('/chat'), 0);
      },
    },
  ];

  return (
    <>
      <SheetScreen
        title={t('home.allTitle')}
        closeApart
        busy={tab === 'shared' && shares.loading && !!shares.data && !pull.refreshing}
        actions={actions}
      />
      <RevealedSearch filter={filter} open={searching && tab === 'mine'} onClose={() => setSearching(false)} />
      {hits ? (
        <FlatList
          style={styles.root}
          contentInsetAdjustmentBehavior="automatic"
          data={hits}
          keyExtractor={(hit) => hit.id}
          renderItem={({ item, index }) => (
            <Row
              title={item.title || t('assistant.untitled')}
              subtitle={item.subtitle}
              leading={null}
              position={rowPosition(index, hits.length)}
              onPress={() => open(item.id)}
            />
          )}
          ListEmptyComponent={empty}
          contentContainerStyle={styles.content}
        />
      ) : (
        <FlatList<Item>
          style={styles.root}
          contentInsetAdjustmentBehavior="automatic"
          data={items}
          keyExtractor={(item) => item.key}
          ListHeaderComponent={segmented}
          renderItem={({ item, index }) => {
            const position = rowPosition(index, items.length);
            if (item.type === 'session') {
              const { session } = item;
              return (
                <ConversationRow
                  session={session}
                  position={position}
                  onOpen={() => open(session.id)}
                  onPin={(pinned) => void useSessions.getState().pin(session.id, pinned)}
                  onRename={() => void rename(session)}
                />
              );
            }
            const { share, unread } = item.row;
            const by = t('conversation.sharedBy', { name: share.shared_by_nickname });
            const when = relativeTimeNow(share.created_at);
            return (
              <Row
                title={share.session_title || t('assistant.untitled')}
                subtitle={[by, share.message?.trim()].filter(Boolean).join(' · ')}
                subtitleLines={1}
                value={when}
                leading={<View style={[styles.dot, unread && styles.dotUnread]} />}
                leadingWidth={8}
                position={position}
                onPress={() => openShared(item.row)}
                accessibilityLabel={[unread ? t('conversation.unread') : '', share.session_title, by, when]
                  .filter(Boolean)
                  .join(t('common.listSep'))}
              />
            );
          }}
          refreshing={pull.refreshing}
          onRefresh={pull.onRefresh}
          ListEmptyComponent={empty}
          contentContainerStyle={styles.content}
        />
      )}
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.sm, paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
  segmented: { marginHorizontal: space.margin, marginBottom: space.md },
  offline: { ...typo.footnote, color: c.secondaryLabel, marginHorizontal: space.margin + space.xs, marginBottom: space.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotUnread: { backgroundColor: c.accent },
}));
