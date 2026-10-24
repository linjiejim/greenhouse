/**
 * Projects (项目): my tasks — open tasks assigned to me across projects, grouped by when they are
 * due (src/data/tasks.ts `myTasks`, from the gantt view; kept on the phone and shown offline,
 * src/data/use-offline-resource.ts) — and the project list. A member without
 * the Projects capability gets a 403: say so instead of an error with a retry.
 */

import { TaskView } from '../../src/projects/task-view';
import { SplitView, useSplit } from '../../src/ui/split';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { gantt, listProjects } from '../../src/api/projects';
import type { ApiResult } from '../../src/api/client';
import { captureIdentity } from '../../src/data/identity';
import { noAccess } from '../../src/data/access';
import { groupMyTasks, localDay, myTasks, type DueBucket, type MyTask } from '../../src/data/tasks';
import { parseMyTasks } from '../../src/data/recent-items';
import { useOfflineResource } from '../../src/data/use-offline-resource';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import { calendarDateLabel } from '../../src/lib/time-words';
import { statusIcon, statusTint } from '../../src/projects/look';
import type { Project } from '../../src/shared/greenhouse-types';
import { useAuth } from '../../src/store/auth';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSectionHeader, type RowPosition } from '../../src/ui/list';
import { Segmented } from '../../src/ui/segmented';

type Tab = 'mine' | 'all';
type Row =
  | { key: string; type: 'header'; title: string }
  | { key: string; type: 'task'; task: MyTask; bucket: DueBucket; position: RowPosition }
  | { key: string; type: 'project'; project: Project; position: RowPosition };

const position = (index: number, count: number): RowPosition =>
  count === 1 ? 'only' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle';

export default function Projects() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const tab: Tab = params.tab === 'all' ? 'all' : 'mine';
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  // iPad: the task opens beside the list (src/ui/split.tsx)
  const split = useSplit();
  const [selected, setSelected] = useState<{ project: number; task: number } | null>(null);
  const userId = useAuth((s) => s.user?.id);

  const loadMine = useCallback(async (): Promise<ApiResult<ReturnType<typeof myTasks>>> => {
    const result = await gantt();
    if (!result.ok) return result;
    return { ok: true, data: myTasks(result.data.projects, userId ?? '', localDay(new Date())) };
  }, [userId]);
  const loadAll = useCallback(() => listProjects(captureIdentity()), []);
  // my tasks read offline too: the last list the station gave stays on this phone
  const mine = useOfflineResource('my-tasks', loadMine, parseMyTasks);
  const all = useResource(loadAll);
  const resource = tab === 'mine' ? mine : all;

  const rows = useMemo((): Row[] => {
    if (tab === 'mine') {
      const out: Row[] = [];
      // grouped again for today: a saved copy keeps the groups of the day it was saved
      const groups = groupMyTasks((mine.data ?? []).flatMap((group) => group.tasks), localDay(new Date()));
      for (const group of groups) {
        out.push({ key: `h-${group.bucket}`, type: 'header', title: t(`projects.dueGroup.${group.bucket}`) });
        group.tasks.forEach((task, i) =>
          out.push({ key: `t-${task.id}`, type: 'task', task, bucket: group.bucket, position: position(i, group.tasks.length) }),
        );
      }
      return out;
    }
    const projects = (all.data ?? []).filter((p) => p.status !== 'archived');
    return projects.map((project, i) => ({ key: `p-${project.id}`, type: 'project', project, position: position(i, projects.length) }));
  }, [tab, mine.data, all.data, t]);

  const header = (
    <View>
      <Segmented
        value={tab}
        onChange={(value) => router.setParams({ tab: value })}
        options={(['mine', 'all'] as const).map((value) => ({ value, label: t(`projects.tabs.${value}`) }))}
        style={styles.segmented}
      />
      {tab === 'mine' && mine.offline ? <Text style={styles.offline}>{t('common.savedCopy')}</Text> : null}
    </View>
  );

  const empty = !resource.data ? (
    resource.loading ? (
      <LoadingState style={styles.state} />
    ) : noAccess(resource.error) ? (
      <EmptyState icon="hand" title={t('projects.noAccess')} message={t('projects.noAccessHint')} style={styles.state} />
    ) : (
      <EmptyState icon="alert" title={t('projects.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
    )
  ) : tab === 'mine' ? (
    <EmptyState icon="checkCircle" title={t('projects.noTasks')} message={t('projects.noTasksHint')} style={styles.state} />
  ) : (
    <EmptyState icon="checkCircle" title={t('projects.empty')} style={styles.state} />
  );

  const listing = (
    <>
      <Stack.Screen options={{ title: t('nav.projects') }} />
      <FlatList<Row>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={(row) => row.key}
        ListHeaderComponent={header}
        refreshing={resource.loading && !!resource.data}
        onRefresh={() => void resource.refresh()}
        renderItem={({ item }) => {
          if (item.type === 'header') return <ListSectionHeader title={item.title} />;
          if (item.type === 'task') {
            const { task } = item;
            const due = task.due_date ? calendarDateLabel(task.due_date.slice(0, 10)) : '';
            return (
              <ListRow
                title={task.title}
                subtitle={[due, task.project_title].filter(Boolean).join(' · ')}
                titleLines={2}
                icon={statusIcon(task.status)}
                iconTint={statusTint(task.status, c)}
                accessibilityLabel={[task.title, t(`projects.status.${task.status}`), due, task.project_title].filter(Boolean).join(', ')}
                accessory="chevron"
                position={item.position}
                onPress={() =>
                  split
                    ? setSelected({ project: task.project_id, task: task.id })
                    : router.push({ pathname: '/projects/task', params: { project: String(task.project_id), task: String(task.id) } })
                }
              />
            );
          }
          const { project } = item;
          const stats = project.stats;
          return (
            <ListRow
              title={project.title}
              subtitle={[
                t(`projects.projectStatus.${project.status}`),
                stats ? t('projects.taskCount', { n: stats.total }) : '',
                project.progress != null ? t('projects.progress', { n: project.progress }) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
              icon="checkCircle"
              iconTint={project.color ?? undefined}
              accessory="chevron"
              position={item.position}
              onPress={() => router.push({ pathname: '/projects/detail', params: { id: String(project.id) } })}
            />
          );
        }}
        ListEmptyComponent={empty}
        contentContainerStyle={styles.content}
      />
    </>
  );
  if (!split) return listing;
  return (
    <SplitView
      list={listing}
      detail={selected ? <TaskView key={selected.task} projectId={selected.project} taskId={selected.task} embedded onChanged={() => void mine.refresh()} /> : null}
      placeholder={{ icon: 'checkCircle', title: t('projects.pick') }}
    />
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl },
  segmented: { marginHorizontal: space.margin, marginVertical: space.md },
  state: { paddingTop: space.xxxl },
  offline: { ...typo.footnote, color: c.secondaryLabel, marginHorizontal: space.margin + space.xs, marginBottom: space.sm },
}));
