/**
 * Notifications — a minimal list of the platform notification center
 * (`/api/notifications`, spec 20261011-mobile-tables-apps §3): newest first,
 * unread rows marked, paged as you scroll, pull to refresh. A tap marks the row
 * read and opens what it is about the way its push would (src/inbox/model.ts:
 * a Tables record, an app record, a Bots thread, a task's chat); a row the
 * phone has no page for says "open this on the web". "Mark All as Read" in the
 * navigation bar.
 *
 * Gate: iOS + an internal account (the list is not Tables-specific). Entries:
 * the drawer's bottom bar, the Tables page's bell.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type InboxNotification,
} from '../src/api/notifications';
import { inboxHref } from '../src/inbox/model';
import { relativeTime } from '../src/lib/format';
import { useT } from '../src/lib/i18n';
import { TablesRouteGate } from '../src/tables/route-gate';
import { space, useTheme } from '../src/theme';
import { alertError } from '../src/ui/dialogs';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { ListRow, type RowPosition } from '../src/ui/list';
import { toolbarIcon } from '../src/ui/toolbar-icon';

export default function InboxScreen() {
  return (
    <TablesRouteGate area="internal">
      <Inbox />
    </TablesRouteGate>
  );
}

function position(index: number, count: number): RowPosition {
  if (count === 1) return 'only';
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'middle';
}

function Inbox() {
  const t = useT();
  const router = useRouter();
  const { colors: c, hex } = useTheme();
  const [items, setItems] = useState<InboxNotification[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const result = await listNotifications();
    if (mine !== seq.current) return;
    if (result.ok) {
      setItems(result.value.notifications);
      setCursor(result.value.next_cursor);
      setFailed(false);
    } else {
      setItems((prev) => prev ?? []);
      setFailed(true);
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useEffect(() => () => void seq.current++, []);

  const more = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const result = await listNotifications(cursor);
    setLoadingMore(false);
    if (!result.ok) return;
    setItems((prev) => [...(prev ?? []), ...result.value.notifications]);
    setCursor(result.value.next_cursor);
  }, [cursor, loadingMore]);

  const open = useCallback(
    (item: InboxNotification) => {
      if (!item.read_at) {
        setItems(
          (prev) =>
            prev?.map((entry) => (entry.id === item.id ? { ...entry, read_at: new Date().toISOString() } : entry)) ??
            prev,
        );
        void markNotificationRead(item.id);
      }
      const href = inboxHref(item);
      if (href) router.push(href as never);
      else alertError(t('inbox.webOnly'));
    },
    [router, t],
  );

  const readAll = useCallback(async () => {
    const result = await markAllNotificationsRead();
    if (!result.ok) return alertError(t('inbox.loadFailed'));
    const now = new Date().toISOString();
    setItems((prev) => prev?.map((entry) => (entry.read_at ? entry : { ...entry, read_at: now })) ?? prev);
  }, [t]);

  const unread = (items ?? []).some((item) => !item.read_at);
  return (
    <>
      <Stack.Screen options={{ title: t('inbox.title') }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('checklist')}
          hidden={!unread}
          accessibilityLabel={t('inbox.markAllRead')}
          onPress={() => void readAll()}
        />
      </Stack.Toolbar>
      <FlatList
        data={items ?? []}
        keyExtractor={(item) => item.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingTop: space.sm, flexGrow: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
            tintColor={hex.accent}
          />
        }
        onEndReached={() => void more()}
        onEndReachedThreshold={0.5}
        renderItem={({ item, index }) => (
          <ListRow
            title={item.title}
            subtitle={[item.body, relativeTime(item.created_at)].filter(Boolean).join('\n')}
            subtitleLines={3}
            titleLines={2}
            leading={
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  marginLeft: space.xs,
                  backgroundColor: item.read_at ? 'transparent' : c.accent,
                }}
              />
            }
            leadingWidth={12}
            accessibilityLabel={item.read_at ? undefined : `${t('inbox.unread')}, ${item.title}`}
            position={position(index, items?.length ?? 0)}
            onPress={() => open(item)}
          />
        )}
        ListEmptyComponent={
          items === null ? (
            <LoadingState />
          ) : failed ? (
            <EmptyState icon="alert" title={t('inbox.loadFailed')} onRetry={() => void load()} />
          ) : (
            <EmptyState icon="bell" title={t('inbox.empty')} message={t('inbox.emptyHint')} />
          )
        }
        ListFooterComponent={<View style={{ height: space.xxl }} />}
      />
    </>
  );
}
