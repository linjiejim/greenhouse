/**
 * One task (`/projects/task?project=&task=`): there is no task-by-id route, so it is read from its
 * project's tree. Its status changes from a menu, optimistically (only the latest change may
 * apply or roll back, src/data/latest.ts); assignee, due date, priority and the project are shown;
 * then the description and the comments, with a toolbar button to add one.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { addTaskComment, getProject, listTaskComments, updateTaskStatus } from '../../src/api/projects';
import { noAccess, notFound } from '../../src/data/access';
import { captureIdentity } from '../../src/data/identity';
import { Latest } from '../../src/data/latest';
import { dueBucket, findTask, localDay, TASK_STATUSES, withTaskPatched } from '../../src/data/tasks';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import { calendarDateLabel, relativeTimeNow } from '../../src/lib/time-words';
import { Markdown } from '../../src/markdown';
import { dueTone, statusIcon, statusTint } from '../../src/projects/look';
import type { TaskComment, TaskStatus } from '../../src/shared/greenhouse-types';
import { useAuth } from '../../src/store/auth';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../src/theme';
import { alertError, promptText } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { notifySuccess, selectionTick } from '../../src/ui/haptics';
import { Badge, ListRow, ListSection } from '../../src/ui/list';
import { NativeMenu } from '../../src/ui/menu';
import { toast } from '../../src/ui/toast';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

const id = (raw: string | undefined) => (raw && /^[0-9]+$/.test(raw) ? Number(raw) : null);

export default function TaskScreen() {
  const params = useLocalSearchParams<{ project?: string; task?: string }>();
  const projectId = id(params.project);
  const taskId = id(params.task);
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const load = useCallback(() => getProject(projectId ?? 0), [projectId]);
  const resource = useResource(load);
  const { setData } = resource;
  const task = useMemo(
    () => (resource.data && taskId != null ? findTask(resource.data.tasks, taskId) : null),
    [resource.data, taskId],
  );
  const latest = useRef(new Latest()).current;
  const me = useAuth((s) => s.user?.nickname ?? null);

  const [comments, setComments] = useState<TaskComment[] | null>(null);
  useEffect(() => {
    if (taskId == null) return;
    let alive = true;
    const current = captureIdentity();
    void listTaskComments(taskId).then((result) => {
      if (alive && current() && result.ok) setComments(result.data.comments);
    });
    return () => {
      alive = false;
    };
  }, [taskId]);

  const changeStatus = useCallback(
    async (status: TaskStatus) => {
      if (!task || status === task.status) return;
      const before = task.status;
      const mine = latest.begin();
      const current = captureIdentity();
      selectionTick();
      setData((detail) => (detail ? { ...detail, tasks: withTaskPatched(detail.tasks, task.id, { status }) } : detail));
      const result = await updateTaskStatus(task.id, status);
      if (!current() || !mine()) return;
      if (!result.ok) {
        setData((detail) =>
          detail ? { ...detail, tasks: withTaskPatched(detail.tasks, task.id, { status: before }) } : detail,
        );
        alertError(t('projects.statusFailed'), result.message || undefined);
        return;
      }
      const saved = result.data.task;
      setData((detail) =>
        detail
          ? {
              ...detail,
              tasks: withTaskPatched(detail.tasks, task.id, {
                status: saved.status,
                completed_at: saved.completed_at,
                updated_at: saved.updated_at,
              }),
            }
          : detail,
      );
      notifySuccess();
      toast(t('projects.statusChanged', { status: t(`projects.status.${saved.status}`) }), 'check');
    },
    [task, latest, setData, t],
  );

  const comment = useCallback(async () => {
    if (taskId == null) return;
    const text = await promptText({ title: t('projects.addComment'), placeholder: t('projects.commentPlaceholder') });
    if (!text?.trim()) return;
    const current = captureIdentity();
    const result = await addTaskComment(taskId, text.trim().slice(0, 5000));
    if (!current()) return;
    if (!result.ok) {
      alertError(t('projects.commentFailed'), result.message || undefined);
      return;
    }
    notifySuccess();
    // the answer carries no author name: it is mine
    setComments((list) => [...(list ?? []), { ...result.data.comment, user_nickname: result.data.comment.user_nickname ?? me }]);
    toast(t('projects.commentAdded'), 'check');
  }, [taskId, t, me]);

  const gone =
    projectId == null ||
    taskId == null ||
    (!resource.loading && (resource.data ? !task : notFound(resource.error) || noAccess(resource.error)));
  if (gone) {
    return (
      <View style={styles.root}>
        <Stack.Screen options={{ title: t('projects.tasks') }} />
        <EmptyState icon="checkCircle" title={t('projects.taskNotFound')} style={styles.state} />
      </View>
    );
  }

  const bucket = task ? dueBucket(task.due_date, localDay(new Date())) : 'none';
  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: '' }} />
      {task ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon={toolbarIcon('comment')}
            accessibilityLabel={t('projects.addComment')}
            onPress={() => void comment()}
          />
        </Stack.Toolbar>
      ) : null}
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {!task ? (
          resource.loading ? (
            <LoadingState style={styles.state} />
          ) : (
            <EmptyState icon="alert" title={t('projects.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
          )
        ) : (
          <>
            <Text style={styles.title} accessibilityRole="header" selectable>
              {task.title}
            </Text>
            <ListSection>
              <NativeMenu
                items={TASK_STATUSES.map((status) => ({
                  id: status,
                  title: t(`projects.status.${status}`),
                  icon: statusIcon(status),
                  checked: status === task.status,
                }))}
                title={t('projects.changeStatus')}
                onSelect={(value) => void changeStatus(value as TaskStatus)}
                fill
              >
                <ListRow
                  title={t('projects.statusLabel')}
                  value={t(`projects.status.${task.status}`)}
                  icon={statusIcon(task.status)}
                  iconTint={statusTint(task.status, c)}
                  accessory="chevron"
                  menuTrigger
                />
              </NativeMenu>
              <ListRow
                title={t('projects.assignee')}
                value={task.assignee_nickname || t('projects.unassigned')}
                icon="person"
                accessory="none"
              />
              <ListRow
                title={t('projects.due')}
                value={task.due_date ? calendarDateLabel(task.due_date.slice(0, 10)) : t('projects.noDue')}
                icon="clock"
                accessory={
                  task.due_date && task.status !== 'done' && task.status !== 'cancelled' && bucket !== 'later' && bucket !== 'soon' ? (
                    <Badge label={t(`projects.dueGroup.${bucket}`)} tone={dueTone(bucket)} />
                  ) : (
                    'none'
                  )
                }
              />
              <ListRow
                title={t('projects.priorityLabel')}
                value={t(`projects.priority.${task.priority}`)}
                icon="filter"
                accessory="none"
              />
              <ListRow
                title={t('projects.project')}
                value={resource.data?.project.title}
                icon="checkCircle"
                accessory="chevron"
                onPress={() => router.push({ pathname: '/projects/detail', params: { id: String(task.project_id) } })}
              />
            </ListSection>
            {task.description ? (
              <View style={styles.block}>
                <Text style={styles.blockTitle} accessibilityRole="header">
                  {t('projects.description')}
                </Text>
                <Markdown source={task.description} />
              </View>
            ) : null}
            {comments && comments.length ? (
              <View style={styles.block}>
                <Text style={styles.blockTitle} accessibilityRole="header">
                  {t('projects.comments', { n: comments.length })}
                </Text>
                {comments.map((entry) => (
                  <View key={entry.id} style={styles.comment}>
                    <Text style={styles.commentMeta}>
                      {[entry.user_nickname, relativeTimeNow(entry.created_at)].filter(Boolean).join(' · ')}
                    </Text>
                    <Markdown source={entry.content} />
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl * 2 },
  state: { paddingTop: space.xxxl },
  title: { ...typo.title2, fontWeight: weight.bold, color: c.label, marginHorizontal: space.margin + space.xs, marginVertical: space.md },
  block: { marginHorizontal: space.margin + space.xs, marginTop: space.xl, gap: space.sm },
  blockTitle: { ...typo.headline, fontWeight: weight.semibold, color: c.label },
  comment: {
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: c.secondaryGroupedBackground,
    ...squircle,
  },
  commentMeta: { ...typo.footnote, color: c.secondaryLabel, marginBottom: space.xs },
}));
