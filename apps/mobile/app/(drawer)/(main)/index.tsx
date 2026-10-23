/**
 * Home (动态 / 通知) — the drawer's screen: the member's notifications, newest first.
 *
 *  - Cache first: the offline copy opens at once (src/store/notifications.ts), the network
 *    answer replaces it; offline, the copy stays with a quiet "showing saved" line.
 *  - A row opens the notification page (/notification?id=), which marks it read; "mark all
 *    read" sits in the toolbar. Read marks are optimistic and come back on failure.
 *  - Pull to refresh, endless paging, ☰ opens the drawer.
 *  - The launch splash waits for the first list (cached or fresh) under it.
 *  - Once notifications are on screen, the push soft ask may follow (src/push/soft-ask.ts).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { Stack, useNavigation, useRouter } from 'expo-router';
import { DrawerActions } from 'expo-router/react-navigation';
import { useT } from '../../../src/lib/i18n';
import { plainText } from '../../../src/lib/plain-text';
import { relativeTimeNow } from '../../../src/lib/time-words';
import { softAskWhenSettled } from '../../../src/push/soft-ask';
import { clearReadBanners } from '../../../src/push/handler';
import type { PlatformNotification } from '../../../src/shared/greenhouse-types';
import { openNotification } from '../../../src/shell/nav';
import { useStartupContent } from '../../../src/startup/context';
import { useAuth } from '../../../src/store/auth';
import { useNotifications } from '../../../src/store/notifications';
import { makeStyles, space, typo, useTheme } from '../../../src/theme';
import type { IconName } from '../../../src/ui/core';
import { alertError } from '../../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { selectionTick } from '../../../src/ui/haptics';
import { ListRow, type RowPosition } from '../../../src/ui/list';
import { toolbarIcon } from '../../../src/ui/toolbar-icon';

/** The notification kinds the server writes, as icons (unknown kinds get the bell). */
const KIND_ICON: Record<string, IconName> = {
  runtime_attention: 'hand',
  budget_attention: 'bar',
  runtime_completed: 'checkCircle',
  runtime_failed: 'alert',
  system: 'bell',
};

function position(index: number, count: number): RowPosition {
  if (count === 1) return 'only';
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'middle';
}

export default function Home() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const navigation = useNavigation();
  const member = useAuth((s) => s.user?.id);
  const items = useNotifications((s) => s.items);
  const status = useNotifications((s) => s.status);
  const unread = useNotifications((s) => s.unread);
  const loadingMore = useNotifications((s) => s.loadingMore);
  const error = useNotifications((s) => s.error);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (member) void useNotifications.getState().refresh();
  }, [member]);

  // the splash leaves as soon as a list (saved or fresh), an empty state or a failure is here
  const settled = status === 'cached' || status === 'ready' || status === 'error';
  useStartupContent(settled);

  // the soft ask comes only once real notifications are on screen
  useEffect(() => {
    if (status === 'ready') void softAskWhenSettled();
  }, [status]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await useNotifications.getState().refresh();
    setRefreshing(false);
  }, []);

  const markAll = useCallback(async () => {
    selectionTick();
    if (!(await useNotifications.getState().markAllRead())) alertError(t('notifications.markFailed'));
    else void clearReadBanners({ all: true });
  }, [t]);

  const open = useCallback(
    (item: PlatformNotification) => {
      openNotification(router, item.id);
    },
    [router],
  );

  // the saved copy is on screen and the network did not answer
  const offline = status === 'cached' && !!error;
  const empty = useMemo(() => {
    if (status === 'empty' || status === 'loading') return <LoadingState style={styles.empty} />;
    if (status === 'error')
      return (
        <EmptyState
          icon="alert"
          title={t('notifications.loadFailed')}
          onRetry={() => void useNotifications.getState().refresh()}
          style={styles.empty}
        />
      );
    return (
      <EmptyState
        icon="bell"
        title={t('notifications.empty')}
        message={t('notifications.emptyHint')}
        style={styles.empty}
      />
    );
  }, [status, styles.empty, t]);

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: t('nav.home') }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon={toolbarIcon('menu')}
          accessibilityLabel={t('shell.openDrawer')}
          onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('checkCircle')}
          accessibilityLabel={t('notifications.markAllRead')}
          disabled={unread === 0}
          onPress={() => void markAll()}
        />
      </Stack.Toolbar>
      <FlatList<PlatformNotification>
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        ListHeaderComponent={
          offline && items.length ? <Text style={styles.offline}>{t('notifications.showingSaved')}</Text> : null
        }
        renderItem={({ item, index }) => {
          const body = plainText(item.body, { oneLine: true });
          return (
            <ListRow
              title={item.title}
              titleLines={2}
              subtitle={body || undefined}
              icon={KIND_ICON[item.kind] ?? 'bell'}
              iconTint={
                item.kind === 'runtime_attention' || item.kind === 'budget_attention'
                  ? c.orange
                  : item.kind === 'runtime_failed'
                    ? c.red
                    : undefined
              }
              value={relativeTimeNow(item.created_at)}
              accessory={item.read_at ? 'chevron' : <View style={styles.unread} />}
              onPress={() => open(item)}
              position={position(index, items.length)}
              accessibilityLabel={[item.title, body, item.read_at ? '' : t('notifications.unread')]
                .filter(Boolean)
                .join(t('common.listSep'))}
            />
          );
        }}
        onEndReached={() => void useNotifications.getState().loadMore()}
        onEndReachedThreshold={0.4}
        ListFooterComponent={loadingMore ? <LoadingState style={styles.more} /> : null}
        ListEmptyComponent={empty}
        contentContainerStyle={styles.content}
        initialNumToRender={12}
        windowSize={11}
        removeClippedSubviews
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.sm, paddingBottom: space.xxl },
  unread: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: c.accent },
  empty: { paddingTop: space.xxxl },
  more: { paddingVertical: space.lg },
  offline: {
    ...typo.footnote,
    color: c.secondaryLabel,
    paddingHorizontal: space.margin + space.xs,
    paddingBottom: space.sm,
  },
}));
