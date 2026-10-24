/**
 * One project (`/projects/detail?id=`): its status, owner, dates and progress, then its tasks by
 * status (open ones first; subtasks flattened under the tree order). A project the member cannot
 * read answers 404 — "not available", not an error with a retry.
 */

import { TaskView } from '../../src/projects/task-view';
import { SplitView, useSplit } from '../../src/ui/split';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { getProject } from '../../src/api/projects';
import { noAccess, notFound } from '../../src/data/access';
import { dueBucket, flattenTasks, localDay, TASK_STATUSES } from '../../src/data/tasks';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import { plainText } from '../../src/lib/plain-text';
import { calendarDateLabel } from '../../src/lib/time-words';
import { dueTone, statusIcon, statusTint } from '../../src/projects/look';
import type { ProjectTask } from '../../src/shared/greenhouse-types';
import { makeStyles, radius, space, squircle, typo, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { Badge, ListRow, ListSectionHeader, type RowPosition } from '../../src/ui/list';

type Row =
  | { key: string; type: 'header'; title: string }
  | { key: string; type: 'task'; task: ProjectTask; position: RowPosition };

const position = (index: number, count: number): RowPosition =>
  count === 1 ? 'only' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle';

export default function ProjectDetailScreen() {
  const { id: raw } = useLocalSearchParams<{ id?: string }>();
  const id = raw && /^[0-9]+$/.test(raw) ? Number(raw) : null;
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  // iPad: the task opens beside the list (src/ui/split.tsx)
  const split = useSplit();
  const [selected, setSelected] = useState<{ project: number; task: number } | null>(null);
  const load = useCallback(() => getProject(id ?? 0), [id]);
  const resource = useResource(load);
  const detail = resource.data;

  const rows = useMemo((): Row[] => {
    if (!detail) return [];
    const tasks = flattenTasks(detail.tasks);
    const out: Row[] = [];
    for (const status of TASK_STATUSES) {
      const group = tasks.filter((task) => task.status === status);
      if (!group.length) continue;
      out.push({ key: `h-${status}`, type: 'header', title: `${t(`projects.status.${status}`)} · ${group.length}` });
      group.forEach((task, i) => out.push({ key: `t-${task.id}`, type: 'task', task, position: position(i, group.length) }));
    }
    return out;
  }, [detail, t]);

  if (id == null || (!detail && !resource.loading && (notFound(resource.error) || noAccess(resource.error)))) {
    return (
      <View style={styles.root}>
        <Stack.Screen options={{ title: t('nav.projects') }} />
        <ScrollView contentInsetAdjustmentBehavior="automatic">
          <EmptyState icon="checkCircle" title={t('projects.notFound')} style={styles.state} />
        </ScrollView>
      </View>
    );
  }

  const project = detail?.project;
  const today = localDay(new Date());
  const header = project ? (
    <View style={styles.card}>
      <View style={styles.badges}>
        <Badge label={t(`projects.projectStatus.${project.status}`)} tone="accent" />
        <Badge label={t('projects.progress', { n: detail.progress })} />
        <Badge label={t('projects.taskCount', { n: detail.stats.total })} />
      </View>
      {project.description ? (
        <Text style={styles.description} numberOfLines={4}>
          {plainText(project.description)}
        </Text>
      ) : null}
      <Text style={styles.meta}>
        {[
          project.owner_nickname ? `${t('projects.owner')}: ${project.owner_nickname}` : '',
          project.start_date || project.end_date
            ? `${t('projects.dates')}: ${[project.start_date, project.end_date]
                .map((day) => (day ? calendarDateLabel(day.slice(0, 10)) : '…'))
                .join(' – ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')}
      </Text>
    </View>
  ) : null;

  const listing = (
    <>
      <Stack.Screen options={{ title: project?.title ?? '' }} />
      <FlatList<Row>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={(row) => row.key}
        ListHeaderComponent={header}
        refreshing={resource.loading && !!detail}
        onRefresh={() => void resource.refresh()}
        renderItem={({ item }) => {
          if (item.type === 'header') return <ListSectionHeader title={item.title} />;
          const { task } = item;
          const bucket = dueBucket(task.due_date, today);
          return (
            <ListRow
              title={task.title}
              subtitle={[task.assignee_nickname || t('projects.unassigned'), task.due_date ? calendarDateLabel(task.due_date.slice(0, 10)) : '']
                .filter(Boolean)
                .join(' · ')}
              titleLines={2}
              icon={statusIcon(task.status)}
              iconTint={statusTint(task.status, c)}
              accessory={
                task.due_date && (bucket === 'overdue' || bucket === 'today') && task.status !== 'done' ? (
                  <Badge label={t(`projects.dueGroup.${bucket}`)} tone={dueTone(bucket)} />
                ) : (
                  'chevron'
                )
              }
              position={item.position}
              onPress={() =>
                split
                  ? setSelected({ project: task.project_id, task: task.id })
                  : router.push({ pathname: '/projects/task', params: { project: String(task.project_id), task: String(task.id) } })
              }
            />
          );
        }}
        ListEmptyComponent={
          !detail ? (
            resource.loading ? (
              <LoadingState style={styles.state} />
            ) : (
              <EmptyState icon="alert" title={t('projects.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
            )
          ) : (
            <EmptyState icon="checkCircle" title={t('projects.noProjectTasks')} style={styles.state} />
          )
        }
        contentContainerStyle={styles.content}
      />
    </>
  );
  if (!split) return listing;
  return (
    <SplitView
      list={listing}
      detail={selected ? <TaskView key={selected.task} projectId={selected.project} taskId={selected.task} embedded onChanged={() => void resource.refresh()} /> : null}
      placeholder={{ icon: 'checkCircle', title: t('projects.pick') }}
    />
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
  card: {
    marginHorizontal: space.margin,
    marginTop: space.md,
    padding: space.lg,
    gap: space.sm,
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.group,
    ...squircle,
  },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  description: { ...typo.body, color: c.label },
  meta: { ...typo.subheadline, color: c.secondaryLabel },
}));
