import { ScreenActions } from '../ui/screen-actions';
/**
 * 定时任务 — my automations (`/api/tasks`; a super's list holds every member's, the phone keeps
 * mine): one row each, its name, then when it runs and when it runs next (or 已暂停), its last
 * result on the leading tile. The list is kept on the phone and reads offline; it reloads
 * whenever the place comes back into view, so one the assistant just made shows up. An
 * automation opens as a sheet (app/sheet/automation.tsx).
 *
 * There is no form to make one: + opens a new conversation with the assistant, its composer
 * filled with "帮我创建一个定时任务：", and it is made there with the assistant's automation tool.
 * The search bar beside + filters the list by name (on the phone: the list is short and kept here).
 */

import React, { useCallback, useMemo } from 'react';
import { FlatList, Text } from 'react-native';
import { Stack } from 'expo-router';
import { listAutomations } from '../api/automations';
import { lastResult, myAutomations, parseSavedAutomations, type Automation } from '../automations/model';
import { resultIcon, resultTint } from '../automations/look';
import { nextRunNow, scheduleLabel } from '../automations/words';
import { noAccess } from '../data/access';
import { useOfflineResource } from '../data/use-offline-resource';
import { useT } from '../lib/i18n';
import { useOpenObject, useStartChat } from '../shell/open-object';
import { useAuth } from '../store/auth';
import { makeStyles, space, typo, useTheme } from '../theme';
import { DirectorySearch, useDirectoryFilter } from '../ui/directory-search';
import { EmptyState, LoadingState } from '../ui/empty';
import { Row, rowPosition } from '../ui/list';
import { usePullRefresh } from '../ui/refresh';
import { SidebarToolbar } from '../ui/sidebar';
import { useWholePageDrawerSwipe } from '../ui/place-swipe';

export default function Automations() {
  const t = useT();
  // a rightward swipe anywhere on the page opens the sidebar, as on home
  useWholePageDrawerSwipe();
  const openObject = useOpenObject();
  const startChat = useStartChat();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const userId = useAuth((s) => s.user?.id);

  const load = useCallback(async () => {
    const result = await listAutomations();
    return result.ok ? { ok: true as const, data: myAutomations(result.data, userId) } : result;
  }, [userId]);
  // read whenever the place is focused (useResource), kept on the phone for offline reading
  const resource = useOfflineResource('automations', load, parseSavedAutomations);
  const pull = usePullRefresh(resource.refresh);
  const busy = resource.loading && !!resource.data && !pull.refreshing;
  const filter = useDirectoryFilter();
  const query = filter.query.trim().toLowerCase();
  const rows = useMemo(
    () => (resource.data ?? []).filter((task) => !query || task.name.toLowerCase().includes(query)),
    [resource.data, query],
  );
  const create = () => startChat(t('automations.draft'));

  const empty = query ? (
    <EmptyState icon="search" title={t('common.noMatches')} style={styles.state} />
  ) : !resource.data ? (
    resource.loading ? (
      <LoadingState style={styles.state} />
    ) : noAccess(resource.error) ? (
      <EmptyState
        icon="hand"
        title={t('automations.noAccess')}
        message={t('automations.noAccessHint')}
        style={styles.state}
      />
    ) : (
      <EmptyState
        icon="alert"
        title={t('automations.loadFailed')}
        onRetry={() => void resource.refresh()}
        style={styles.state}
      />
    )
  ) : (
    <EmptyState icon="clock" title={t('automations.empty')} message={t('automations.emptyHint')} style={styles.state} />
  );

  return (
    <>
      <Stack.Screen options={{ title: t('nav.automations') }} />
      <DirectorySearch filter={filter} />
      <SidebarToolbar />
      <ScreenActions
        placement={'right'}
        actions={[
          { id: 'refresh', icon: 'refresh', label: t('common.loading'), onPress: () => {}, busy: busy },
          { id: 'action-1', icon: 'plus' as const, label: t('automations.create'), onPress: create },
        ]}
      />
      <FlatList<Automation>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={(task) => task.id}
        ListHeaderComponent={resource.offline ? <Text style={styles.offline}>{t('common.savedCopy')}</Text> : null}
        refreshing={pull.refreshing}
        onRefresh={pull.onRefresh}
        renderItem={({ item, index }) => {
          const result = lastResult(item);
          const schedule = scheduleLabel(item.schedule, item.timezone);
          const next = item.enabled ? nextRunNow(item.next_run_at) : '';
          const when = item.enabled ? (next ? t('automations.nextRun', { when: next }) : '') : t('automations.paused');
          return (
            <Row
              title={item.name}
              subtitle={[schedule, when].filter(Boolean).join(' · ')}
              subtitleLines={1}
              icon={resultIcon(result, item.enabled)}
              iconTint={resultTint(result, c, item.enabled)}
              accessory="chevron"
              position={rowPosition(index, rows.length)}
              accessibilityLabel={[
                item.name,
                schedule,
                when,
                result !== 'none' ? `${t('automations.lastRun')}: ${t(`automations.result.${result}`)}` : '',
              ]
                .filter(Boolean)
                .join(t('common.listSep'))}
              onPress={() => openObject({ kind: 'automation', id: item.id })}
            />
          );
        }}
        ListEmptyComponent={empty}
        contentContainerStyle={styles.content}
      />
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
  offline: {
    ...typo.footnote,
    color: c.secondaryLabel,
    marginHorizontal: space.margin + space.xs,
    marginBottom: space.sm,
  },
}));
