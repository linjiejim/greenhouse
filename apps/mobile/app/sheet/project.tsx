/**
 * One project as an object sheet (`/sheet/project?id=`): its status, owner, dates and progress,
 * then its tasks by status (open ones first; subtasks flattened under the tree order). A task
 * opens as a sheet stacked on this one. A project the member cannot read answers 404 — "not
 * available", not an error with a retry.
 */

import React, { useCallback, useMemo } from 'react';
import { FlatList, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
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
import { Badge, Row, SectionHeader, rowPosition, type RowPosition } from '../../src/ui/list';
import { usePullRefresh } from '../../src/ui/refresh';
import { SheetScreen } from '../../src/ui/screen';
import { useOpenObject } from '../../src/shell/open-object';
import { objectId } from '../../src/lib/object-id';

type Item =
  | { key: string; type: 'header'; title: string }
  | { key: string; type: 'task'; task: ProjectTask; position: RowPosition };

export default function ProjectSheet() {
  const { id: raw } = useLocalSearchParams<{ id?: string }>();
  const id = objectId(raw);
  const t = useT();
  const openObject = useOpenObject();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const load = useCallback(() => getProject(id ?? '0'), [id]);
  const resource = useResource(load);
  const pull = usePullRefresh(resource.refresh);
  const detail = resource.data;

  // back from a task sheet stacked on this one: its change shows here
  const seen = React.useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (seen.current) void resource.refresh();
      seen.current = true;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh on refocus only
    }, []),
  );

  const rows = useMemo((): Item[] => {
    if (!detail) return [];
    const tasks = flattenTasks(detail.tasks);
    const out: Item[] = [];
    for (const status of TASK_STATUSES) {
      const group = tasks.filter((task) => task.status === status);
      if (!group.length) continue;
      out.push({ key: `h-${status}`, type: 'header', title: `${t(`projects.status.${status}`)} · ${group.length}` });
      group.forEach((task, i) => out.push({ key: `t-${task.id}`, type: 'task', task, position: rowPosition(i, group.length) }));
    }
    return out;
  }, [detail, t]);

  if (id == null || (!detail && !resource.loading && (notFound(resource.error) || noAccess(resource.error)))) {
    return (
      <View style={styles.root}>
        <SheetScreen title={t('nav.projects')} />
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

  return (
    <>
      <SheetScreen title={project?.title ?? ''} busy={resource.loading && !!detail && !pull.refreshing} />
      <FlatList<Item>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={(row) => row.key}
        ListHeaderComponent={header}
        refreshing={pull.refreshing}
        onRefresh={pull.onRefresh}
        renderItem={({ item }) => {
          if (item.type === 'header') return <SectionHeader title={item.title} />;
          const { task } = item;
          const bucket = dueBucket(task.due_date, today);
          return (
            <Row
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
              onPress={() => openObject({ kind: 'task', projectId: task.project_id, id: task.id })}
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
