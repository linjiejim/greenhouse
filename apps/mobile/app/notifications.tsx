/**
 * The notification center (NTF-01; a large-title page over the conversation, opened from the
 * bell): 需要你 lists every pending decision as its card — tap one to decide it in its sheet —
 * and 全部 lists what happened, newest first; opening one marks it read and goes back to its
 * source. 「全部已读」 in the bar. Both refresh as realtime events arrive.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { listNotifications, markNotificationsRead } from '../src/api/notifications';
import { listRequests } from '../src/api/requests';
import { useT } from '../src/lib/i18n';
import { relativeTimeNow } from '../src/lib/time-words';
import { realtime } from '../src/realtime';
import { RequestCard } from '../src/requests/request-card';
import type { NeedsYou, Notification } from '../src/shared/contract';
import { openConversation } from '../src/shell/nav';
import { useWorkspace } from '../src/store/workspace';
import { makeStyles, space, useTheme } from '../src/theme';
import type { IconName } from '../src/ui/core';
import { alertError } from '../src/ui/dialogs';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { ListRow } from '../src/ui/list';
import { Segmented } from '../src/ui/segmented';
import { toolbarIcon } from '../src/ui/toolbar-icon';

type View_ = 'needs' | 'all';

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
  const agents = useWorkspace((s) => s.agents);
  const publicAgents = useWorkspace((s) => s.publicAgents);
  const [view, setView] = useState<View_>('needs');
  const [requests, setRequests] = useState<NeedsYou[] | null>(null);
  const [items, setItems] = useState<Notification[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [pending, list] = await Promise.all([listRequests({ state: 'pending', limit: 100 }), listNotifications({ limit: 50 })]);
    if (pending.ok) setRequests(pending.data.items);
    if (list.ok) {
      setItems(list.data.items);
      setNext(list.data.next_cursor);
    }
    setFailed(!pending.ok && !list.ok);
    void useWorkspace.getState().refreshSummary();
  }, []);

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = realtime.on((event) => {
      if (
        event.type !== 'notification.created' &&
        event.type !== 'notification.read' &&
        event.type !== 'request.updated' &&
        event.type !== 'resync'
      ) {
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 300);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const loadMore = async () => {
    if (!next) return;
    const page = await listNotifications({ cursor: next, limit: 50 });
    if (!page.ok) return;
    setItems((current) => [...(current ?? []), ...page.data.items]);
    setNext(page.data.next_cursor);
  };

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const markAll = async () => {
    setItems((current) => current?.map((item) => ({ ...item, read_at: item.read_at ?? new Date().toISOString() })) ?? null);
    const result = await markNotificationsRead({ all: true });
    if (!result.ok) alertError(t('notifications.markFailed'));
    void useWorkspace.getState().refreshSummary();
  };

  const open = (item: Notification) => {
    if (!item.read_at) {
      setItems((current) => current?.map((n) => (n.id === item.id ? { ...n, read_at: new Date().toISOString() } : n)) ?? null);
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
    // documents and folders: the knowledge base comes to the app in a later phase
    if (item.target_type === 'doc' || item.target_type === 'folder') alertError(t('notifications.webOnly'));
  };

  const agentName = (id: string | null) =>
    (id && (agents?.find((agent) => agent.id === id)?.name ?? publicAgents.find((agent) => agent.id === id)?.name)) || undefined;

  const loading = view === 'needs' ? requests === null : items === null;
  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: t('notifications.title') }} />
      {view === 'all' ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button icon={toolbarIcon('checkCircle')} accessibilityLabel={t('notifications.markAllRead')} onPress={() => void markAll()} />
        </Stack.Toolbar>
      ) : null}
      <FlatList<NeedsYou | Notification>
        contentInsetAdjustmentBehavior="automatic"
        data={(view === 'needs' ? requests : items) ?? []}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        ListHeaderComponent={
          <Segmented<View_>
            value={view}
            onChange={setView}
            options={[
              { value: 'needs', label: t('notifications.needsYou') },
              { value: 'all', label: t('notifications.all') },
            ]}
            style={styles.segmented}
          />
        }
        renderItem={({ item, index }) => {
          if (view === 'needs') {
            const request = item as NeedsYou;
            return (
              <View style={styles.card}>
                <RequestCard request={request} context={agentName(request.agent_id)} />
              </View>
            );
          }
          const notification = item as Notification;
          const list = items ?? [];
          return (
            <ListRow
              title={notification.title}
              subtitle={notification.body || undefined}
              icon={KIND_ICON[notification.kind] ?? 'bell'}
              iconTint={notification.kind === 'request' ? c.orange : notification.kind === 'run_failed' ? c.red : undefined}
              value={relativeTimeNow(notification.created_at)}
              accessory={notification.read_at ? 'none' : <View style={styles.unread} />}
              onPress={() => open(notification)}
              position={list.length === 1 ? 'only' : index === 0 ? 'first' : index === list.length - 1 ? 'last' : 'middle'}
              accessibilityLabel={[notification.title, notification.body, notification.read_at ? '' : t('directory.unread')].filter(Boolean).join(t('common.listSep'))}
            />
          );
        }}
        onEndReached={() => (view === 'all' ? void loadMore() : undefined)}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          loading ? (
            <LoadingState style={styles.empty} />
          ) : failed ? (
            <EmptyState icon="alert" title={t('notifications.loadFailed')} onRetry={() => void load()} />
          ) : view === 'needs' ? (
            <EmptyState icon="checkCircle" title={t('notifications.nothingNeedsYou')} />
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
  segmented: { marginHorizontal: space.margin, marginVertical: space.md },
  card: { paddingHorizontal: space.margin, paddingBottom: space.md },
  unread: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: c.accent },
  empty: { paddingTop: space.xxl },
}));

