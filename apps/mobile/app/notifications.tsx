import { plainText } from '../src/chat/text';
/** One notification list, refreshed across open clients. Decisions live in conversations. */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { listNotifications, markNotificationsRead } from '../src/api/notifications';
import { useT } from '../src/lib/i18n';
import { relativeTimeNow } from '../src/lib/time-words';
import { captureIdentity } from '../src/data/identity';
import { realtime } from '../src/realtime';
import type { Notification } from '../src/shared/contract';
import { openConversation } from '../src/shell/nav';
import { useWorkspace } from '../src/store/workspace';
import { makeStyles, space, useTheme } from '../src/theme';
import type { IconName } from '../src/ui/core';
import { alertError } from '../src/ui/dialogs';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { ListRow } from '../src/ui/list';
import { toolbarIcon } from '../src/ui/toolbar-icon';

const KIND_ICON: Record<string, IconName> = {
  request: 'hand',
  run_done: 'checkCircle',
  run_failed: 'alert',
  reply: 'msg',
  mention: 'at',
  comment: 'comment',
  share: 'users',
  automation: 'clock',
  skill_scan: 'wand',
  budget: 'bar',
  system: 'bell',
};

export default function Notifications() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const generation = useRef(0);
  const cleared = useRef(new Set<string>());
  const load = useCallback(async () => {
    const n = ++generation.current;
    const current = captureIdentity();
    const list = await listNotifications({ limit: 50 });
    if (!current() || generation.current !== n) return;
    if (list.ok) {
      setItems(list.data.items.filter((item) => !item.request_id || !cleared.current.has(item.request_id)));
      setNext(list.data.next_cursor);
    }
    setFailed(!list.ok);
    void useWorkspace.getState().refreshSummary();
  }, []);

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = realtime.on((event) => {
      if (
        event.type !== 'notification.created' &&
        event.type !== 'notification.read' &&
        event.type !== 'notification.removed' &&
        event.type !== 'request.updated' &&
        event.type !== 'resync'
      ) {
        return;
      }
      if (event.type === 'notification.removed') {
        cleared.current.add(event.data.request_id);
        setItems((current) => current?.filter((item) => item.request_id !== event.data.request_id) ?? null);
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 300);
    });
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- invalidate pending reads on cleanup
      generation.current++;
      off();
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const loadMore = async () => {
    if (!next) return;
    const n = generation.current;
    const current = captureIdentity();
    const page = await listNotifications({ cursor: next, limit: 50 });
    if (!page.ok || !current() || generation.current !== n) return;
    setItems((current) => [
      ...(current ?? []),
      ...page.data.items.filter((item) => !item.request_id || !cleared.current.has(item.request_id)),
    ]);
    setNext(page.data.next_cursor);
  };

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const markAll = async () => {
    setItems(
      (current) => current?.map((item) => ({ ...item, read_at: item.read_at ?? new Date().toISOString() })) ?? null,
    );
    const result = await markNotificationsRead({ all: true });
    if (!result.ok) alertError(t('notifications.markFailed'));
    void useWorkspace.getState().refreshSummary();
  };

  const open = (item: Notification) => {
    if (!item.read_at) {
      setItems(
        (current) => current?.map((n) => (n.id === item.id ? { ...n, read_at: new Date().toISOString() } : n)) ?? null,
      );
      void markNotificationsRead({ ids: [item.id] }).then(() => void useWorkspace.getState().refreshSummary());
    }
    if (item.request_id && item.target_type === 'conversation' && item.target_id) {
      openConversation(router, { id: item.target_id, request: item.request_id }, 'dismissTo');
      return;
    }
    if (item.run_id) {
      router.push({ pathname: '/runs/[id]', params: { id: item.run_id } });
      return;
    }
    if (item.target_type === 'conversation' && item.target_id) {
      openConversation(router, { id: item.target_id }, 'dismissTo');
      return;
    }
    if (item.target_type === 'agent' && item.target_id) {
      router.push({ pathname: '/agents/[id]', params: { id: item.target_id } });
      return;
    }
    if (item.target_id && item.target_type === 'doc') {
      router.push({ pathname: '/knowledge/doc', params: { id: item.target_id } });
    } else if (item.target_id && item.target_type === 'folder') {
      router.push({ pathname: '/knowledge', params: { folder: item.target_id } });
    } else if (item.target_id && item.target_type === 'record') {
      router.push({ pathname: '/tables/record', params: { id: item.target_id } });
    }
  };

  const loading = items === null;
  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: t('notifications.title') }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('checkCircle')}
          accessibilityLabel={t('notifications.markAllRead')}
          onPress={() => void markAll()}
        />
      </Stack.Toolbar>
      <FlatList<Notification>
        contentInsetAdjustmentBehavior="automatic"
        data={items ?? []}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        renderItem={({ item, index }) => {
          const notification = item as Notification;
          const list = items ?? [];
          return (
            <ListRow
              title={notification.title}
              subtitle={plainText(notification.body) || undefined}
              icon={KIND_ICON[notification.kind] ?? 'bell'}
              iconTint={
                notification.kind === 'request' ? c.orange : notification.kind === 'run_failed' ? c.red : undefined
              }
              value={relativeTimeNow(notification.created_at)}
              accessory={notification.read_at ? 'none' : <View style={styles.unread} />}
              onPress={() => open(notification)}
              position={
                list.length === 1 ? 'only' : index === 0 ? 'first' : index === list.length - 1 ? 'last' : 'middle'
              }
              accessibilityLabel={[
                notification.title,
                plainText(notification.body),
                notification.read_at ? '' : t('directory.unread'),
              ]
                .filter(Boolean)
                .join(t('common.listSep'))}
            />
          );
        }}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          loading ? (
            <LoadingState style={styles.empty} />
          ) : failed ? (
            <EmptyState icon="alert" title={t('notifications.loadFailed')} onRetry={() => void load()} />
          ) : (
            <EmptyState icon="bell" title={t('notifications.empty')} />
          )
        }
        contentContainerStyle={styles.content}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxl },
  unread: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: c.accent },
  empty: { paddingTop: space.xxl },
}));
