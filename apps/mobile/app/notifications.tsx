/**
 * 通知 — the sheet behind home's bell: my notifications, newest first.
 *
 *  - Cache first: the offline copy opens at once (src/store/notifications.ts), the network answer
 *    replaces it; offline, the copy stays with a quiet "showing saved" line.
 *  - A row opens what the notification points at (a document, a task, a record …) as a sheet
 *    stacked on this one, or its own sheet, and reads it; "mark all read" sits in the bar. Read
 *    marks are optimistic and come back on failure.
 *  - Pull to refresh, endless paging.
 *  - A segmented control switches to team activity: the last 14 days of changes I may read
 *    (`/api/activity/recent`, loaded on first visit, paged with `before`; a pull to refresh drops a load-more still in flight); a row opens its object.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { useT } from '../src/lib/i18n';
import { plainText } from '../src/lib/plain-text';
import { relativeTimeNow } from '../src/lib/time-words';
import { clearAllStationBanners } from '../src/push/handler';
import type { PlatformNotification } from '../src/shared/greenhouse-types';
import { openNotificationOrTarget } from '../src/shell/open-notification';
import { listRecentChanges } from '../src/api/activity';
import { beginActivityLoad, finishActivityLoad, NO_ACTIVITY, type ActivityFeedState } from '../src/data/activity-feed';
import { ActivityRow } from '../src/notifications/activity-row';
import type { ActivityItem } from '../src/shared/greenhouse-types';
import { useOpenObject, useOpenTarget } from '../src/shell/open-object';
import { useAuth } from '../src/store/auth';
import { useNotifications } from '../src/store/notifications';
import { makeStyles, space, typo, useTheme } from '../src/theme';
import type { IconName } from '../src/ui/core';
import { alertError } from '../src/ui/dialogs';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { selectionTick } from '../src/ui/haptics';
import { Row, rowPosition } from '../src/ui/list';
import { SheetScreen } from '../src/ui/screen';
import { Segmented } from '../src/ui/segmented';

type Tab = 'notifications' | 'activity';

/** The team activity feed: first page on demand, then `before` pages; a refresh drops loads it overtook. */
function useTeamActivity() {
  const [state, setState] = useState<ActivityFeedState>(NO_ACTIVITY);
  const current = useRef(state);
  current.current = state;
  const load = useCallback(async (more: boolean) => {
    const started = beginActivityLoad(current.current, more);
    if (!started) return;
    // kept in the ref at once so a second tap in the same frame sees the load already running
    current.current = started.state;
    setState(started.state);
    const result = await listRecentChanges({ before: started.load.before });
    setState((prev) => finishActivityLoad(prev, started.load, result));
  }, []);
  return { ...state, refresh: () => load(false), loadMore: () => load(true) };
}

/** The notification kinds the server writes, as icons (unknown kinds get the bell). */
const KIND_ICON: Record<string, IconName> = {
  runtime_attention: 'hand',
  budget_attention: 'bar',
  runtime_completed: 'checkCircle',
  runtime_failed: 'alert',
  system: 'bell',
};

export default function Notifications() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const openObject = useOpenObject();
  const openTarget = useOpenTarget();
  const member = useAuth((s) => s.user?.id);
  const items = useNotifications((s) => s.items);
  const status = useNotifications((s) => s.status);
  const unread = useNotifications((s) => s.unread);
  const loadingMore = useNotifications((s) => s.loadingMore);
  const error = useNotifications((s) => s.error);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('notifications');
  const activity = useTeamActivity();
  const activityStatus = activity.status;
  const refreshActivity = activity.refresh;

  useEffect(() => {
    if (tab === 'activity' && activityStatus === 'idle') void refreshActivity();
  }, [tab, activityStatus, refreshActivity]);

  useEffect(() => {
    if (member) void useNotifications.getState().refresh();
  }, [member]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    if (tab === 'activity') await refreshActivity();
    else await useNotifications.getState().refresh();
    setRefreshing(false);
  }, [tab, refreshActivity]);

  const markAll = useCallback(async () => {
    selectionTick();
    if (!(await useNotifications.getState().markAllRead())) alertError(t('notifications.markFailed'));
    else void clearAllStationBanners();
  }, [t]);

  const offline = status === 'cached' && !!error;
  const empty = useMemo(() => {
    if (status === 'empty' || status === 'loading') return <LoadingState style={styles.empty} />;
    if (status === 'error')
      return <EmptyState icon="alert" title={t('notifications.loadFailed')} onRetry={() => void useNotifications.getState().refresh()} style={styles.empty} />;
    return <EmptyState icon="bell" title={t('notifications.empty')} message={t('notifications.emptyHint')} style={styles.empty} />;
  }, [status, styles.empty, t]);

  const activityEmpty = useMemo(() => {
    if (activityStatus === 'idle' || activityStatus === 'loading') return <LoadingState style={styles.empty} />;
    if (activityStatus === 'error')
      return <EmptyState icon="alert" title={t('notifications.activityLoadFailed')} onRetry={() => void refreshActivity()} style={styles.empty} />;
    return <EmptyState icon="clock" title={t('notifications.activityEmpty')} message={t('notifications.activityEmptyHint')} style={styles.empty} />;
  }, [activityStatus, refreshActivity, styles.empty, t]);

  const segmented = (
    <Segmented
      value={tab}
      onChange={(value) => {
        selectionTick();
        setTab(value);
      }}
      options={[
        { value: 'notifications' as const, label: t('notifications.tabNotifications') },
        { value: 'activity' as const, label: t('notifications.tabActivity') },
      ]}
      style={styles.segmented}
    />
  );

  return (
    <>
      <SheetScreen
        title={t('notifications.title')}
        actions={
          tab === 'notifications'
            ? [{ icon: 'checkCircle', label: t('notifications.markAllRead'), disabled: unread === 0, onPress: () => void markAll() }]
            : []
        }
      />
      {tab === 'activity' ? (
        <FlatList<ActivityItem>
          style={styles.root}
          contentInsetAdjustmentBehavior="automatic"
          data={activity.items}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          ListHeaderComponent={segmented}
          renderItem={({ item, index }) => <ActivityRow item={item} index={index} count={activity.items.length} />}
          onEndReached={() => void activity.loadMore()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={activity.loadingMore ? <LoadingState style={styles.more} /> : null}
          ListEmptyComponent={activityEmpty}
          contentContainerStyle={styles.content}
          initialNumToRender={12}
          windowSize={11}
        />
      ) : (
      <FlatList<PlatformNotification>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        ListHeaderComponent={
          <View>
            {segmented}
            {offline && items.length ? <Text style={styles.offline}>{t('notifications.showingSaved')}</Text> : null}
          </View>
        }
        renderItem={({ item, index }) => {
          const body = plainText(item.body, { oneLine: true });
          return (
            <Row
              title={item.title}
              titleLines={2}
              subtitle={body || undefined}
              icon={KIND_ICON[item.kind] ?? 'bell'}
              iconTint={
                item.kind === 'runtime_attention' || item.kind === 'budget_attention'
                  ? c.orangeTile
                  : item.kind === 'runtime_failed'
                    ? c.redTile
                    : undefined
              }
              value={relativeTimeNow(item.created_at)}
              accessory={item.read_at ? 'chevron' : <View style={styles.unread} />}
              onPress={() => void openNotificationOrTarget(item.id, { object: openObject, target: openTarget })}
              position={rowPosition(index, items.length)}
              accessibilityLabel={[item.title, body, item.read_at ? '' : t('notifications.unread')].filter(Boolean).join(t('common.listSep'))}
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
      />
      )}
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.sm, paddingBottom: space.xxl },
  segmented: { marginHorizontal: space.margin, marginBottom: space.md },
  unread: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: c.accent },
  empty: { paddingTop: space.xxxl },
  more: { paddingVertical: space.lg },
  offline: { ...typo.footnote, color: c.secondaryLabel, paddingHorizontal: space.margin + space.xs, paddingBottom: space.sm },
}));
