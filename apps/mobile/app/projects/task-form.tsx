/**
 * Task form — create / edit a task, subtask or milestone as a form sheet with
 * a real SwiftUI Form (web parity: create-task-dialog + task-drawer's edit).
 *
 * Params: `projectId` (required), `taskId` (edit), `parentId` (new subtask),
 * `status` (preset status — the board's per-lane `+`), `milestone=1` (new
 * milestone).
 *
 * Fields: title (focused on create), notes (grows vertically), status /
 * priority / assignee as menu pickers, 里程碑 toggle, start + due as
 * Reminders-style date toggles with one inline calendar open at a time (a
 * milestone has a single date, saved as both start and due; moving start past
 * due drags due along, and due can't be picked before start — like Calendar),
 * labeled estimated-hours and comma-separated tags rows. Chrome is the shared
 * `FormChrome`: ✓ saves (disabled until there is a title and the dates are in
 * order), refreshes the shared projects store, toasts and dismisses; a failed
 * save is a system alert and the sheet stays open with the edits; ✕ asks
 * before discarding edits (swipe-down is blocked while dirty). While an
 * edited task loads (or if it's gone) the sheet keeps its title + ✕.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Label, LabeledContent, Picker, Section, Text, TextField, Toggle, useNativeState } from '@expo/ui/swift-ui';
import { foregroundStyle, keyboardType, lineLimit, multilineTextAlignment, pickerStyle, tag, textInputAutocapitalization } from '@expo/ui/swift-ui/modifiers';
import { createTask, updateTask, type Priority, type ProjectTask, type TaskInput, type TaskStatus } from '../../src/api/projects';
import { useT } from '../../src/lib/i18n';
import { OptionalDateField } from '../../src/projects/form-fields';
import { PRIORITIES, TASK_STATUSES, findTask, parseTags, priorityLabel, taskStatusIcon, taskStatusLabel, toStamp } from '../../src/projects/meta';
import { useAssignableUsers, useProjectDetail, useProjects } from '../../src/projects/store';
import { useTheme } from '../../src/theme';
import { sfSymbol } from '../../src/ui/core';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { NativeForm } from '../../src/ui/native-form';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';
import { toast } from '../../src/ui/toast';

interface TaskFormValues {
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

export default function TaskFormScreen() {
  const t = useT();
  const params = useLocalSearchParams<{ projectId: string; taskId?: string; parentId?: string; status?: string; milestone?: string }>();
  const projectId = Number(params.projectId);
  const taskId = params.taskId ? Number(params.taskId) : null;
  const { colors: c } = useTheme();
  const { detail, failed, reload } = useProjectDetail(projectId);

  const task = taskId && detail ? findTask(detail.tasks, taskId) : null;
  const parent = params.parentId && detail ? findTask(detail.tasks, Number(params.parentId)) : null;

  // Edit needs the task from the tree before the (uncontrolled) fields mount;
  // meanwhile (or if it's gone) the sheet keeps its title + ✕.
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
    <TaskForm
      key={task?.id ?? 'new'}
      projectId={projectId}
      task={task}
      parentId={params.parentId ? Number(params.parentId) : undefined}
      parentTitle={parent?.title}
      initial={initialValues(task, params.status, params.milestone === '1')}
    />
  );
}

function TaskForm({
  projectId,
  task,
  parentId,
  parentTitle,
  initial: initialProp,
}: {
  projectId: number;
  task: ProjectTask | null;
  parentId?: number;
  parentTitle?: string;
  initial: TaskFormValues;
}) {
  // Frozen at mount: the store may refresh underneath while the sheet is open.
  const [initial] = useState(initialProp);
  const t = useT();
  const router = useRouter();
  const reload = useProjects((s) => s.reload);
  const users = useAssignableUsers();
  const isEdit = !!task;

  const titleText = useNativeState(initial.title);
  const descText = useNativeState(initial.description);
  const hoursText = useNativeState(initial.hours);
  const tagsText = useNativeState(initial.tags);
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

  const sheetTitle = isEdit
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

  return (
    <>
      <FormChrome title={sheetTitle} dirty={dirty} canSave={valid && !dateOrderBad} saving={saving} onSave={() => void save()} />
      <NativeForm>
        <Section footer={parentTitle ? <Text>{t('projects.subtaskOf', { name: parentTitle })}</Text> : undefined}>
          <TextField
            text={titleText}
            autoFocus={!isEdit}
            placeholder={v.milestone ? t('projects.milestonePlaceholder') : t('projects.taskTitlePlaceholder')}
            onTextChange={(s) => set('title', s)}
          />
          <TextField
            text={descText}
            axis="vertical"
            placeholder={t('projects.descPlaceholder')}
            onTextChange={(s) => set('description', s)}
            modifiers={[lineLimit({ min: 2, max: 8 })]}
          />
        </Section>

        <Section>
          <Picker
            label={t('projects.status')}
            systemImage={sfSymbol(taskStatusIcon(v.status))}
            selection={v.status}
            onSelectionChange={(s) => set('status', s as TaskStatus)}
            modifiers={[pickerStyle('menu')]}
          >
            {/* title-only options: the row's own symbol already shows the status glyph */}
            {TASK_STATUSES.map((s) => (
              <Text key={s} modifiers={[tag(s)]}>
                {taskStatusLabel(s, t)}
              </Text>
            ))}
          </Picker>
          <Picker
            label={t('projects.priority')}
            systemImage="flag"
            selection={v.priority}
            onSelectionChange={(p) => set('priority', p as Priority)}
            modifiers={[pickerStyle('menu')]}
          >
            {PRIORITIES.map((p) => (
              <Text key={p} modifiers={[tag(p)]}>
                {priorityLabel(p, t)}
              </Text>
            ))}
          </Picker>
          <Picker
            label={t('projects.assignee')}
            systemImage="person"
            selection={v.assigneeId}
            onSelectionChange={(id) => set('assigneeId', String(id ?? ''))}
            modifiers={[pickerStyle('menu')]}
          >
            <Text modifiers={[tag('')]}>{t('projects.unassigned')}</Text>
            {/* keep a current assignee who is no longer assignable */}
            {v.assigneeId && !users.some((u) => u.id === v.assigneeId) ? (
              <Text modifiers={[tag(v.assigneeId)]}>{task?.assignee_nickname ?? v.assigneeId}</Text>
            ) : null}
            {users.map((u) => (
              <Text key={u.id} modifiers={[tag(u.id)]}>
                {u.nickname}
              </Text>
            ))}
          </Picker>
        </Section>

        <Section
          footer={
            dateOrderBad ? (
              <Text modifiers={[foregroundStyle('red')]}>{t('projects.dateOrder')}</Text>
            ) : v.milestone ? (
              <Text>{t('projects.milestoneHint')}</Text>
            ) : undefined
          }
        >
          <Toggle label={t('projects.milestone')} systemImage="diamond" isOn={v.milestone} onIsOnChange={(on) => set('milestone', on)} />
          {v.milestone ? null : (
            <OptionalDateField
              label={t('projects.startDate')}
              icon="calendar"
              value={v.start}
              onChange={setStart}
              expanded={openDate === 'start'}
              onExpandedChange={(open) => setOpenDate(open ? 'start' : null)}
            />
          )}
          <OptionalDateField
            label={v.milestone ? t('projects.milestoneDate') : t('projects.dueDate')}
            icon={v.milestone ? 'diamond' : 'calendar.badge.clock'}
            value={v.due}
            fallback={v.milestone ? null : v.start}
            min={v.milestone ? null : v.start}
            onChange={(s) => set('due', s)}
            expanded={openDate === 'due'}
            onExpandedChange={(open) => setOpenDate(open ? 'due' : null)}
          />
        </Section>

        <Section>
          <LabeledContent label={<Label title={t('projects.estimatedHours')} systemImage="hourglass" />}>
            <TextField
              text={hoursText}
              placeholder={t('projects.hoursPlaceholder')}
              onTextChange={(s) => set('hours', s.replace(/[^0-9]/g, ''))}
              modifiers={[keyboardType('ascii-capable-number-pad'), multilineTextAlignment('trailing')]}
            />
          </LabeledContent>
          <LabeledContent label={<Label title={t('projects.tags')} systemImage="tag" />}>
            <TextField
              text={tagsText}
              placeholder={t('projects.tagsPlaceholder')}
              onTextChange={(s) => set('tags', s)}
              modifiers={[textInputAutocapitalization('never'), multilineTextAlignment('trailing')]}
            />
          </LabeledContent>
        </Section>
      </NativeForm>
    </>
  );
}
