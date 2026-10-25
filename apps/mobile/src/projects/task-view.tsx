/**
 * One task (`/projects/task?project=&task=`, or the detail pane on an iPad): there is no task-by-id route, so it is read from its
 * project's tree. Its status changes from a menu, optimistically, one save at a time: the last
 * choice is sent after the save in flight settles, so the server and the screen end on it
 * (src/data/latest-choice.ts); assignee and priority change from menus too (saved at once, put
 * back when refused); ✎ (and the due row) opens the task form (app/task-form.tsx) for the title
 * and due day; then the project, the description and the comments, with a toolbar button to add one.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  addTaskComment,
  getProject,
  listAssignableUsers,
  listTaskComments,
  updateTask,
  updateTaskStatus,
} from '../api/projects';
import { noAccess, notFound } from '../data/access';
import { captureIdentity } from '../data/identity';
import { LatestChoice } from '../data/latest-choice';
import { dueBucket, findTask, localDay, TASK_STATUSES, withTaskPatched } from '../data/tasks';
import { useResource } from '../data/use-resource';
import { useT } from '../lib/i18n';
import { calendarDateLabel, relativeTimeNow } from '../lib/time-words';
import { Markdown } from '../markdown';
import { dueTone, statusIcon, statusTint } from '../projects/look';
import type { ProjectTask, TaskComment, TaskPriority, TaskStatus } from '../shared/greenhouse-types';
import { TASK_PRIORITIES } from './task-draft';
import { useAuth } from '../store/auth';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { alertError, promptText } from '../ui/dialogs';
import { EmptyState, LoadingState } from '../ui/empty';
import { notifySuccess, selectionTick } from '../ui/haptics';
import { Badge, Row, Section } from '../ui/list';
import { NativeMenu } from '../ui/menu';
import { toast } from '../ui/toast';
import { SheetScreen } from '../ui/screen';
import { useOpenObject } from '../shell/open-object';

/** One task, as an object sheet (app/sheet/task.tsx), often stacked on its project's sheet. */
export function TaskView({
  projectId,
  taskId,
  onChanged,
}: {
  projectId: string | null;
  taskId: string | null;
  /** A change was saved (the list beside it reloads). */
  onChanged?: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const openObject = useOpenObject();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const load = useCallback(() => getProject(projectId ?? '0'), [projectId]);
  const users = useResource(listAssignableUsers);
  const resource = useResource(load);
  const { setData } = resource;
  const task = useMemo(
    () => (resource.data && taskId != null ? findTask(resource.data.tasks, taskId) : null),
    [resource.data, taskId],
  );
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

  // one save in flight per task; the member's last choice is what the server ends on
  const choices = useRef<{
    taskId: string;
    current: () => boolean;
    choice: LatestChoice<TaskStatus, ProjectTask>;
  } | null>(null);
  // a reload (on focus) brings the server's status: it becomes the baseline while nothing is saving
  useEffect(() => {
    if (task && choices.current?.taskId === task.id) choices.current.choice.rebase(task.status);
  }, [task]);
  const changeStatus = useCallback(
    async (status: TaskStatus) => {
      if (!task || status === task.status) return;
      if (choices.current?.taskId !== task.id || !choices.current.current()) {
        const id = task.id;
        // every save of this task's queue belongs to the station and account choosing now
        const owner = captureIdentity();
        choices.current = {
          taskId: id,
          current: owner,
          choice: new LatestChoice<TaskStatus, ProjectTask>(
            task.status,
            async (value) => {
              const result = await updateTaskStatus(id, value);
              return result.ok ? { ok: true, data: result.data.task } : { ok: false, message: result.message };
            },
            owner,
          ),
        };
      }
      const current = choices.current.current;
      selectionTick();
      setData((detail) => (detail ? { ...detail, tasks: withTaskPatched(detail.tasks, task.id, { status }) } : detail));
      const outcome = await choices.current.choice.choose(status);
      // a later choice took over, or the station / account changed
      if (!outcome || !current()) return;
      if (!outcome.ok) {
        setData((detail) =>
          detail ? { ...detail, tasks: withTaskPatched(detail.tasks, task.id, { status: outcome.rollbackTo }) } : detail,
        );
        alertError(t('projects.statusFailed'), outcome.message || undefined);
        return;
      }
      const saved = outcome.data;
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
      onChanged?.();
    },
    [task, setData, t, onChanged],
  );

  // assignee and priority: saved at once from their menus, put back when the station refuses
  const changeField = useCallback(
    async (patch: { assignee_id?: string | null; priority?: TaskPriority }, local: Partial<ProjectTask>, before: Partial<ProjectTask>) => {
      if (!task) return;
      const id = task.id;
      const current = captureIdentity();
      selectionTick();
      setData((detail) => (detail ? { ...detail, tasks: withTaskPatched(detail.tasks, id, local) } : detail));
      const result = await updateTask(id, patch);
      if (!current()) return;
      if (!result.ok) {
        setData((detail) => (detail ? { ...detail, tasks: withTaskPatched(detail.tasks, id, before) } : detail));
        alertError(t('projects.saveTaskFailed'), result.message || undefined);
        return;
      }
      notifySuccess();
      onChanged?.();
    },
    [task, setData, t, onChanged],
  );

  const editTask = useCallback(() => {
    if (!task) return;
    router.push({ pathname: '/task-form', params: { project: task.project_id, id: task.id } });
  }, [task, router]);

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
      <>
        <SheetScreen title={t('projects.tasks')} />
        <ScrollView style={styles.root} contentInsetAdjustmentBehavior="automatic">
          <EmptyState icon="checkCircle" title={t('projects.taskNotFound')} style={styles.state} />
        </ScrollView>
      </>
    );
  }

  const bucket = task ? dueBucket(task.due_date, localDay(new Date())) : 'none';
  return (
    <>
      <SheetScreen
        title={resource.data?.project.title ?? ''}
        actions={
          task
            ? [
                { icon: 'pen', label: t('projects.editTask'), onPress: editTask },
                { icon: 'comment', label: t('projects.addComment'), onPress: () => void comment() },
              ]
            : []
        }
      />
      <ScrollView style={styles.root} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
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
            <Section>
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
                <Row
                  title={t('projects.statusLabel')}
                  value={t(`projects.status.${task.status}`)}
                  icon={statusIcon(task.status)}
                  iconTint={statusTint(task.status, c)}
                  accessory="chevron"
                  menuTrigger
                />
              </NativeMenu>
              <NativeMenu
                items={[
                  { id: UNASSIGNED, title: t('projects.unassigned'), checked: !task.assignee_id },
                  ...people(users.data?.users ?? [], task).map((person) => ({
                    id: person.id,
                    title: person.name,
                    checked: person.id === task.assignee_id,
                  })),
                ]}
                title={t('projects.assignee')}
                onSelect={(value) => {
                  const next = value === UNASSIGNED ? null : value;
                  if (next === (task.assignee_id ?? null)) return;
                  const name = next ? (people(users.data?.users ?? [], task).find((p) => p.id === next)?.name ?? null) : null;
                  void changeField(
                    { assignee_id: next },
                    { assignee_id: next, assignee_nickname: name },
                    { assignee_id: task.assignee_id, assignee_nickname: task.assignee_nickname },
                  );
                }}
                fill
              >
                <Row
                  title={t('projects.assignee')}
                  value={task.assignee_nickname || t('projects.unassigned')}
                  icon="person"
                  accessory="chevron"
                  menuTrigger
                />
              </NativeMenu>
              <Row
                title={t('projects.due')}
                value={task.due_date ? calendarDateLabel(task.due_date.slice(0, 10)) : t('projects.noDue')}
                icon="clock"
                onPress={editTask}
                accessory={
                  task.due_date && task.status !== 'done' && task.status !== 'cancelled' && bucket !== 'later' && bucket !== 'soon' ? (
                    <Badge label={t(`projects.dueGroup.${bucket}`)} tone={dueTone(bucket)} />
                  ) : (
                    'chevron'
                  )
                }
              />
              <NativeMenu
                items={TASK_PRIORITIES.map((priority) => ({
                  id: priority,
                  title: t(`projects.priority.${priority}`),
                  checked: priority === task.priority,
                }))}
                title={t('projects.priorityLabel')}
                onSelect={(value) => {
                  if (value === task.priority) return;
                  const priority = value as TaskPriority;
                  void changeField({ priority }, { priority }, { priority: task.priority });
                }}
                fill
              >
                <Row
                  title={t('projects.priorityLabel')}
                  value={t(`projects.priority.${task.priority}`)}
                  icon="filter"
                  accessory="chevron"
                  menuTrigger
                />
              </NativeMenu>
              <Row
                title={t('projects.project')}
                value={resource.data?.project.title}
                icon="checkCircle"
                accessory="chevron"
                onPress={() => openObject({ kind: 'project', id: task.project_id })}
              />
            </Section>
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
    </>
  );
}

/** The assignee menu's "nobody" item. */
const UNASSIGNED = '__unassigned';

/** Whom a task may be assigned to; its current assignee stays listed when no longer assignable. */
function people(users: readonly { id: string; nickname: string }[], task: ProjectTask): { id: string; name: string }[] {
  const list = users.map((user) => ({ id: user.id, name: user.nickname }));
  if (task.assignee_id && !list.some((person) => person.id === task.assignee_id)) {
    list.unshift({ id: task.assignee_id, name: task.assignee_nickname || task.assignee_id });
  }
  return list;
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
