/**
 * The task form's behaviour, shared by both platforms' views
 * (app/projects/task-form.tsx — SwiftUI, task-form.android.tsx — Material):
 *
 *  - `TaskFormGate` — the route body: reads the params (`projectId`,
 *    `taskId` edit, `parentId` new subtask, `status` preset, `milestone=1`),
 *    waits for the task to edit (title + ✕ and a spinner / not-found / retry
 *    meanwhile) and renders the platform form with frozen initial values;
 *  - `useTaskForm` — the values, dirty / valid / date-order checks, Calendar
 *    date behaviour (moving start past due drags due along; one date picker
 *    open at a time) and `save` (create or update, refresh the store, toast,
 *    dismiss; a failed save is a system alert and the form stays open).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { createTask, updateTask, type Priority, type ProjectTask, type TaskInput, type TaskStatus } from '../api/projects';
import { useT } from '../lib/i18n';
import { useTheme } from '../theme';
import { alertError } from '../ui/dialogs';
import { EmptyState, LoadingState } from '../ui/empty';
import { SheetClose } from '../ui/sheet-chrome';
import { toast } from '../ui/toast';
import { TASK_STATUSES, findTask, parseTags, toStamp } from './meta';
import { useAssignableUsers, useProjectDetail, useProjects } from './store';

export interface TaskFormValues {
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assigneeId: string;
  milestone: boolean;
  start: string | null;
  due: string | null;
  hours: string;
  tags: string;
}

function initialValues(task: ProjectTask | null, presetStatus?: string, milestone?: boolean): TaskFormValues {
  const status = TASK_STATUSES.includes(presetStatus as TaskStatus) ? (presetStatus as TaskStatus) : 'todo';
  return {
    title: task?.title ?? '',
    description: task?.description ?? '',
    status: task?.status ?? status,
    priority: task?.priority ?? 'normal',
    assigneeId: task?.assignee_id ?? '',
    milestone: task ? task.task_type === 'milestone' : !!milestone,
    start: toStamp(task?.start_date),
    due: toStamp(task?.due_date),
    hours: task?.estimated_hours != null ? String(task.estimated_hours) : '',
    tags: task ? parseTags(task.tags).join(', ') : '',
  };
}

export interface TaskFormProps {
  projectId: number;
  task: ProjectTask | null;
  parentId?: number;
  parentTitle?: string;
  initial: TaskFormValues;
}

export function TaskFormGate({ render }: { render: (props: TaskFormProps) => React.ReactNode }) {
  const t = useT();
  const params = useLocalSearchParams<{ projectId: string; taskId?: string; parentId?: string; status?: string; milestone?: string }>();
  const projectId = Number(params.projectId);
  const taskId = params.taskId ? Number(params.taskId) : null;
  const { colors: c } = useTheme();
  const { detail, failed, reload } = useProjectDetail(projectId);

  const task = taskId && detail ? findTask(detail.tasks, taskId) : null;
  const parent = params.parentId && detail ? findTask(detail.tasks, Number(params.parentId)) : null;

  // Edit needs the task from the tree before the (uncontrolled) fields mount;
  // meanwhile (or if it's gone) the form keeps its title + ✕.
  if (taskId && !task) {
    return (
      <>
        <Stack.Screen options={{ title: t('projects.editTask') }} />
        <SheetClose />
        <View style={{ flex: 1, justifyContent: 'center', backgroundColor: c.groupedBackground }}>
          {detail ? (
            <EmptyState icon="alert" title={t('projects.taskMissing')} />
          ) : failed ? (
            <EmptyState icon="alert" title={t('projects.loadFailed')} message={t('projects.loadFailedHint')} onRetry={() => void reload()} />
          ) : (
            <LoadingState />
          )}
        </View>
      </>
    );
  }

  return (
    <React.Fragment key={task?.id ?? 'new'}>
      {render({
        projectId,
        task,
        parentId: params.parentId ? Number(params.parentId) : undefined,
        parentTitle: parent?.title,
        initial: initialValues(task, params.status, params.milestone === '1'),
      })}
    </React.Fragment>
  );
}

export function useTaskForm({ projectId, task, parentId, initial: initialProp }: TaskFormProps) {
  // Frozen at mount: the store may refresh underneath while the form is open.
  const [initial] = useState(initialProp);
  const t = useT();
  const router = useRouter();
  const reload = useProjects((s) => s.reload);
  const users = useAssignableUsers();
  const isEdit = !!task;

  const [v, setV] = useState<TaskFormValues>(initial);
  const [saving, setSaving] = useState(false);
  const [openDate, setOpenDate] = useState<'start' | 'due' | null>(null);
  const set = useCallback(<K extends keyof TaskFormValues>(k: K, val: TaskFormValues[K]) => setV((p) => ({ ...p, [k]: val })), []);
  // Calendar behaviour: moving start past due drags due along.
  const setStart = useCallback(
    (s: string | null) => setV((p) => ({ ...p, start: s, due: s && p.due && p.due < s ? s : p.due })),
    [],
  );

  const dirty = useMemo(() => (Object.keys(initial) as (keyof TaskFormValues)[]).some((k) => initial[k] !== v[k]), [initial, v]);
  const valid = v.title.trim().length > 0;
  const dateOrderBad = !v.milestone && !!v.start && !!v.due && v.start > v.due;

  const title = isEdit
    ? t('projects.editTask')
    : v.milestone
      ? t('projects.newMilestone')
      : parentId
        ? t('projects.newSubtask')
        : t('projects.newTask');

  const save = useCallback(async () => {
    if (!valid || dateOrderBad || saving) return;
    setSaving(true);
    const hours = v.hours.trim() ? parseInt(v.hours, 10) : NaN;
    const body: TaskInput = {
      title: v.title.trim(),
      description: isEdit ? v.description.trim() : v.description.trim() || undefined,
      status: v.status,
      priority: v.priority,
      assignee_id: v.assigneeId || null,
      task_type: v.milestone ? 'milestone' : 'task',
      start_date: v.milestone ? v.due : v.start,
      due_date: v.due,
      estimated_hours: Number.isFinite(hours) ? hours : null,
      tags: v.tags
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const ok = isEdit
      ? !!(await updateTask(task!.id, body))
      : !!(await createTask(projectId, { ...body, title: body.title!, parent_id: parentId ?? null }));
    if (!ok) {
      setSaving(false);
      alertError(t('projects.saveFailed'));
      return;
    }
    await reload(projectId, { fresh: true });
    toast(isEdit ? t('projects.saved') : t('projects.taskCreated'), 'checkCircle');
    router.back();
  }, [valid, dateOrderBad, saving, v, isEdit, task, projectId, parentId, reload, t, router]);

  return { initial, v, set, setStart, openDate, setOpenDate, dirty, valid, dateOrderBad, saving, save, users, isEdit, title };
}
