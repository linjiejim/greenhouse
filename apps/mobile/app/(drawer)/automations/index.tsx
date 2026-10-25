/**
 * 定时任务 — my automations (`/api/tasks`; a super's list holds every member's, the phone keeps
 * mine): one row each, its name, then when it runs and when it runs next (or 已暂停), its last
 * result on the leading tile. The list is kept on the phone and reads offline; it reloads
 * whenever the place comes back into view, so one the assistant just made shows up. An
 * automation opens as a sheet (app/sheet/automation.tsx).
 *
 * There is no form to make one: + (and the empty state) opens a new conversation with the
 * assistant, its composer filled with "帮我创建一个定时任务：", and it is made there with the
 * assistant's automation tool.
 */

import React, { useCallback, useMemo } from 'react';
import { FlatList, Text } from 'react-native';
import { Stack } from 'expo-router';
import { listAutomations } from '../../../src/api/automations';
import { lastResult, myAutomations, parseSavedAutomations, type Automation } from '../../../src/automations/model';
import { resultIcon, resultTint } from '../../../src/automations/look';
import { nextRunNow, scheduleLabel } from '../../../src/automations/words';
import { noAccess } from '../../../src/data/access';
import { useOfflineResource } from '../../../src/data/use-offline-resource';
import { useT } from '../../../src/lib/i18n';
import { useOpenObject, useStartChat } from '../../../src/shell/open-object';
import { useAuth } from '../../../src/store/auth';
import { makeStyles, space, typo, useTheme } from '../../../src/theme';
import { NativeButton } from '../../../src/ui/button';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { Row, rowPosition } from '../../../src/ui/list';
import { refreshItem, usePullRefresh } from '../../../src/ui/refresh';
import { SidebarToolbar } from '../../../src/ui/sidebar';
import { toolbarIcon } from '../../../src/ui/toolbar-icon';

export default function Automations() {
  const t = useT();
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
  const rows = useMemo(() => resource.data ?? [], [resource.data]);
  const create = () => startChat(t('automations.draft'));

  const empty = !resource.data ? (
    resource.loading ? (
      <LoadingState style={styles.state} />
    ) : noAccess(resource.error) ? (
      <EmptyState icon="hand" title={t('automations.noAccess')} message={t('automations.noAccessHint')} style={styles.state} />
    ) : (
      <EmptyState icon="alert" title={t('automations.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
    )
  ) : (
    <EmptyState
      icon="clock"
      title={t('automations.empty')}
      message={t('automations.emptyHint')}
      action={<NativeButton label={t('automations.create')} icon="compose" variant="prominent" onPress={create} />}
      style={styles.state}
    />
  );

  return (
    <>
      <Stack.Screen options={{ title: t('nav.automations') }} />
      <SidebarToolbar />
      <Stack.Toolbar placement="right">
        {refreshItem(busy, t('common.loading'))}
        <Stack.Toolbar.Button icon={toolbarIcon('compose')} accessibilityLabel={t('automations.create')} onPress={create} />
      </Stack.Toolbar>
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
  offline: { ...typo.footnote, color: c.secondaryLabel, marginHorizontal: space.margin + space.xs, marginBottom: space.sm },
}));
