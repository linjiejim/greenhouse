/**
 * Runs (RUN-01; a large-title page, from 更多): what the Agents do in the background, from
 * conversations, schedules and automations — 运行中 and 已结束, filtered by Agent from the bar's
 * menu. A row opens its detail. Refreshes as realtime `run.updated` events arrive.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { listRuns } from '../../src/api/runs';
import { useT } from '../../src/lib/i18n';
import { relativeTimeNow } from '../../src/lib/time-words';
import { realtime } from '../../src/realtime';
import { RUN_SOURCE, RUN_STATUS } from '../../src/runs/status';
import type { RunView } from '../../src/shared/contract';
import { useWorkspace } from '../../src/store/workspace';
import { makeStyles, radius, space, typo, useTheme, weight } from '../../src/theme';
import { AgentAvatar } from '../../src/ui/agent-avatar';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, type RowPosition } from '../../src/ui/list';
import { Segmented } from '../../src/ui/segmented';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

type View_ = 'active' | 'done';

const position = (index: number, count: number): RowPosition =>
  count === 1 ? 'only' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle';

export default function Runs() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const agents = useWorkspace((s) => s.agents);
  const [view, setView] = useState<View_>('active');
  const [agent, setAgent] = useState<string>('');
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const page = await listRuns({ state: view, agent: agent || undefined, limit: 50 });
    if (page.ok) {
      setRuns(page.data.items);
      setNext(page.data.next_cursor);
      setFailed(false);
    } else setFailed(true);
  }, [view, agent]);

  useEffect(() => {
    setRuns(null);
    void load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = realtime.on((event) => {
      if (event.type !== 'run.updated' && event.type !== 'resync') return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 400);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const loadMore = async () => {
    if (!next) return;
    const page = await listRuns({ state: view, agent: agent || undefined, cursor: next, limit: 50 });
    if (!page.ok) return;
    setRuns((current) => [...(current ?? []), ...page.data.items]);
    setNext(page.data.next_cursor);
  };

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const filterName = agent ? agents?.find((item) => item.id === agent)?.name : null;
  const list = runs ?? [];
  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: t('runs.title') }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon={toolbarIcon(agent ? 'filterOn' : 'filter')} accessibilityLabel={t('runs.byAgent')}>
          <Stack.Toolbar.MenuAction isOn={!agent} onPress={() => setAgent('')}>
            {t('runs.allAgents')}
          </Stack.Toolbar.MenuAction>
          {(agents ?? []).map((item) => (
            <Stack.Toolbar.MenuAction key={item.id} isOn={agent === item.id} onPress={() => setAgent(item.id)}>
              {item.name}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <FlatList<RunView>
        contentInsetAdjustmentBehavior="automatic"
        data={list}
        keyExtractor={(run) => run.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        ListHeaderComponent={
          <View>
            <Segmented<View_>
              value={view}
              onChange={setView}
              options={[
                { value: 'active', label: t('runs.active') },
                { value: 'done', label: t('runs.done') },
              ]}
              style={styles.segmented}
            />
            {filterName ? <Text style={styles.filter}>{t('runs.filteredBy', { name: filterName })}</Text> : null}
          </View>
        }
        renderItem={({ item, index }) => {
          const owner = agents?.find((a) => a.id === item.agent_id);
          const status = RUN_STATUS[item.status];
          const tone =
            status.tone === 'warning'
              ? c.orange
              : status.tone === 'danger'
                ? c.red
                : status.tone === 'success'
                  ? c.green
                  : status.tone === 'info'
                    ? c.blue
                    : c.secondaryLabel;
          const when = item.finished_at ?? item.started_at ?? item.created_at;
          return (
            <ListRow
              title={item.title}
              subtitle={[owner?.name, t(`runs.${RUN_SOURCE[item.source]}` as 'runs.fromConversation'), relativeTimeNow(when)]
                .filter(Boolean)
                .join(' · ')}
              leading={<AgentAvatar agent={owner ?? null} size={30} state={item.status === 'running' ? 'thinking' : undefined} />}
              leadingWidth={30}
              accessory={
                <View style={[styles.status, { borderColor: tone }]}>
                  <Text style={[styles.statusText, { color: tone }]}>{t(`runs.status.${status.word}` as 'runs.status.running')}</Text>
                </View>
              }
              position={position(index, list.length)}
              onPress={() => router.push({ pathname: '/runs/[id]', params: { id: item.id } })}
            />
          );
        }}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          runs === null && !failed ? (
            <LoadingState style={styles.empty} />
          ) : failed ? (
            <EmptyState icon="alert" title={t('runs.loadFailed')} onRetry={() => void load()} />
          ) : (
            <EmptyState icon="runs" title={view === 'active' ? t('runs.noneActive') : t('runs.noneDone')} />
          )
        }
        ListFooterComponent={<View style={{ height: space.xxl }} />}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  segmented: { marginHorizontal: space.margin, marginVertical: space.md },
  filter: { ...typo.footnote, color: c.secondaryLabel, marginHorizontal: space.margin + space.xs, marginBottom: space.sm },
  status: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 1 },
  statusText: { ...typo.caption1, fontWeight: weight.semibold },
  empty: { paddingTop: space.xxl },
}));
