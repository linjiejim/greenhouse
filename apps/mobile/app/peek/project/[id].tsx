/**
 * Project peek — the web's entity peek drawer as a bottom sheet (param `id`;
 * opened from the projects list context menu and from `#/projects/<id>`
 * entity links in chat). A glanceable summary, not an editor:
 *
 *  - the project name is the sheet's bar title (like the knowledge peek — it
 *    is not repeated in the content),
 *  - hero: color tile, status, owner, date range; then the description,
 *  - progress bar + done/total, task counts per status,
 *  - the next open tasks (earliest due first) — tap opens the task page.
 *
 * Bar: ✕ closes; ↗ opens the full project page (the sheet steps aside first).
 */

import React, { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import type { ProjectTask, TaskStatus } from '../../../src/shared/greenhouse-types';
import { useT } from '../../../src/lib/i18n';
import { usePrefs } from '../../../src/store/prefs';
import {
  TASK_STATUSES,
  forEachTask,
  formatDay,
  isOverdue,
  projectColor,
  projectStatusLabel,
  projectStatusTone,
  taskStatusColor,
  taskStatusIcon,
  taskStatusLabel,
} from '../../../src/projects/meta';
import { ProgressBar } from '../../../src/projects/progress';
import { useProjectDetail } from '../../../src/projects/store';
import { TaskStatusButton } from '../../../src/projects/task-list';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../../src/theme';
import { Icon } from '../../../src/ui/core';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { Badge, IconTile, ListRow, ListSection } from '../../../src/ui/list';
import { SheetClose, useLeaveSheetTo } from '../../../src/ui/sheet-chrome';

const NEXT_LIMIT = 5;

export default function ProjectPeek() {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const leaveTo = useLeaveSheetTo();
  const lang = usePrefs((s) => s.lang);
  const params = useLocalSearchParams<{ id: string }>();
  const projectId = Number(params.id);
  const { detail, failed, reload } = useProjectDetail(projectId);

  // Open work, earliest due first (undated last), parents and children alike.
  const nextTasks = useMemo(() => {
    const open: ProjectTask[] = [];
    forEachTask(detail?.tasks ?? [], (task) => {
      if (task.status !== 'done' && task.status !== 'cancelled') open.push(task);
    });
    return open
      .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.sort_order - b.sort_order)
      .slice(0, NEXT_LIMIT);
  }, [detail]);

  const project = detail?.project;
  const color = projectColor(project?.color, hex);
  const range = [project?.start_date, project?.end_date].map((d) => (d ? formatDay(d, lang) : '')).filter(Boolean).join(' – ');

  return (
    <>
      <Stack.Screen options={{ title: project?.title ?? t('projects.title') }} />
      <SheetClose />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="arrow.up.right.square"
          hidden={!detail}
          onPress={() => leaveTo({ pathname: '/projects/[id]', params: { id: String(projectId) } })}
          accessibilityLabel={t('projects.openFull')}
        />
      </Stack.Toolbar>

      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {!detail || !project ? (
          failed ? (
            <EmptyState
              icon="alert"
              title={t('projects.projectMissing')}
              message={t('projects.projectMissingHint')}
              onRetry={() => void reload()}
              style={styles.centered}
            />
          ) : (
            <LoadingState />
          )
        ) : (
          <>
            {/* hero */}
            <View style={styles.hero}>
              <IconTile icon={project.status === 'archived' ? 'archive' : 'folder'} tint={color} size={44} />
              <View style={styles.heroText}>
                <View style={styles.heroMeta}>
                  <Badge label={projectStatusLabel(project.status, t)} tone={projectStatusTone(project.status)} />
                  {project.visibility === 'private' ? <Icon name="lock" size={13} color={c.secondaryLabel} /> : null}
                  {project.owner_nickname ? (
                    <Text style={styles.metaText} numberOfLines={1}>
                      {t('projects.owner')} · {project.owner_nickname}
                    </Text>
                  ) : null}
                </View>
                {range ? (
                  <View style={styles.heroMeta}>
                    <Icon name="calendar" size={13} color={c.secondaryLabel} />
                    <Text style={styles.metaText}>{range}</Text>
                  </View>
                ) : null}
              </View>
            </View>
            {project.description ? (
              <Text style={styles.description} numberOfLines={6}>
                {project.description}
              </Text>
            ) : null}

            {/* progress + counts */}
            <View style={styles.card}>
              <View style={styles.progressHead}>
                <Text style={styles.progressPct}>{detail.progress}%</Text>
                <Text style={styles.metaText}>
                  {t('projects.taskCount', { done: detail.stats.done, total: detail.stats.total })}
                </Text>
              </View>
              <ProgressBar pct={detail.progress} color={color} />
              <View style={styles.counts}>
                {TASK_STATUSES.map((s: TaskStatus) => (
                  <View key={s} style={styles.count} accessible accessibilityLabel={`${taskStatusLabel(s, t)} ${detail.stats[s]}`}>
                    <Icon name={taskStatusIcon(s)} size={17} color={taskStatusColor(s, c)} />
                    <Text style={styles.countNum}>{detail.stats[s]}</Text>
                    <Text style={styles.countLabel} numberOfLines={1}>
                      {taskStatusLabel(s, t)}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            {/* next up */}
            {nextTasks.length > 0 ? (
              <ListSection header={t('projects.nextUp')} style={styles.flush}>
                {nextTasks.map((task) => (
                  <ListRow
                    key={task.id}
                    title={task.title}
                    leading={<TaskStatusButton task={task} size={22} />}
                    subtitle={task.assignee_nickname ?? undefined}
                    accessory={
                      task.due_date ? (
                        <Text style={[styles.due, isOverdue(task) && { color: c.red, fontWeight: weight.semibold }]}>
                          {formatDay(task.due_date, lang)}
                        </Text>
                      ) : (
                        'none'
                      )
                    }
                    onPress={() =>
                      leaveTo({
                        pathname: '/projects/task/[taskId]',
                        params: { taskId: String(task.id), projectId: String(projectId) },
                      })
                    }
                  />
                ))}
              </ListSection>
            ) : detail.stats.total > 0 ? (
              <Text style={styles.allDone}>{t('projects.allDone')}</Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  content: { paddingHorizontal: space.margin, paddingTop: space.sm, paddingBottom: space.xxxl, gap: space.lg, flexGrow: 1 },
  centered: { flexGrow: 1, justifyContent: 'center' },
  hero: { flexDirection: 'row', alignItems: 'center', gap: space.md + 2 },
  heroText: { flex: 1, minWidth: 0, gap: space.xs + 2 },
  heroMeta: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  metaText: { ...typo.footnote, color: c.secondaryLabel, flexShrink: 1 },
  description: { ...typo.body, color: c.label },
  card: {
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.group,
    ...squircle,
    padding: space.lg,
    gap: space.md,
  },
  progressHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  progressPct: { ...typo.title1, color: c.label, fontVariant: ['tabular-nums'] },
  counts: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.xs },
  count: { flex: 1, alignItems: 'center', gap: 2 },
  countNum: { ...typo.headline, color: c.label, fontVariant: ['tabular-nums'] },
  countLabel: { ...typo.caption2, color: c.secondaryLabel },
  flush: { marginHorizontal: 0 },
  allDone: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center' },
  due: { ...typo.subheadline, color: c.secondaryLabel },
}));
