/**
 * Task form on Android — create / edit a task, subtask or milestone as a
 * Material full-screen dialog (iOS: ./task-form.tsx, SwiftUI; behaviour and
 * params: src/projects/use-task-form.tsx). Outlined title / notes fields,
 * status / priority / assignee dropdown rows, the 里程碑 switch, start + due
 * date rows (Material date picker), estimated hours and comma-separated tags.
 * Chrome is the shared `FormChrome` (✕ asks before discarding; ✓ saves).
 */

import React from 'react';
import type { Priority, TaskStatus } from '../../src/api/projects';
import { useT } from '../../src/lib/i18n';
import { OptionalDateField } from '../../src/projects/form-fields.android';
import { PRIORITIES, TASK_STATUSES, priorityLabel, taskStatusIcon, taskStatusLabel } from '../../src/projects/meta';
import { TaskFormGate, useTaskForm, type TaskFormProps } from '../../src/projects/use-task-form';
import {
  FormFields,
  FormSection,
  FormSelectRow,
  FormSwitchRow,
  FormTextField,
  NativeForm,
  useNativeState,
} from '../../src/ui/native-form.android';
import { FormChrome } from '../../src/ui/sheet-chrome';

export default function TaskFormScreen() {
  return <TaskFormGate render={(props) => <TaskForm {...props} />} />;
}

function TaskForm(props: TaskFormProps) {
  const t = useT();
  const { parentTitle, task } = props;
  const { initial, v, set, setStart, openDate, setOpenDate, dirty, valid, dateOrderBad, saving, save, users, isEdit, title } =
    useTaskForm(props);
  const titleText = useNativeState(initial.title);
  const descText = useNativeState(initial.description);
  const hoursText = useNativeState(initial.hours);
  const tagsText = useNativeState(initial.tags);

  const assignees = [
    { value: '', label: t('projects.unassigned') },
    // keep a current assignee who is no longer assignable
    ...(v.assigneeId && !users.some((u) => u.id === v.assigneeId)
      ? [{ value: v.assigneeId, label: task?.assignee_nickname ?? v.assigneeId }]
      : []),
    ...users.map((u) => ({ value: u.id, label: u.nickname })),
  ];

  return (
    <>
      <FormChrome title={title} dirty={dirty} canSave={valid && !dateOrderBad} saving={saving} onSave={() => void save()} />
      <NativeForm>
        <FormFields>
          <FormTextField
            label={v.milestone ? t('projects.milestonePlaceholder') : t('projects.taskTitlePlaceholder')}
            state={titleText}
            autoFocus={!isEdit}
            onChangeText={(s) => set('title', s)}
            supporting={parentTitle ? t('projects.subtaskOf', { name: parentTitle }) : undefined}
            imeAction="next"
          />
          <FormTextField
            label={t('projects.descPlaceholder')}
            state={descText}
            multiline
            onChangeText={(s) => set('description', s)}
          />
        </FormFields>

        <FormSection>
          <FormSelectRow<TaskStatus>
            label={t('projects.status')}
            icon={taskStatusIcon(v.status)}
            value={v.status}
            onChange={(s) => set('status', s)}
            options={TASK_STATUSES.map((s) => ({ value: s, label: taskStatusLabel(s, t) }))}
          />
          <FormSelectRow<Priority>
            label={t('projects.priority')}
            icon="flag"
            value={v.priority}
            onChange={(p) => set('priority', p)}
            options={PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p, t) }))}
          />
          <FormSelectRow
            label={t('projects.assignee')}
            icon="person2"
            value={v.assigneeId}
            onChange={(id) => set('assigneeId', id)}
            options={assignees}
          />
        </FormSection>

        <FormSection
          footer={dateOrderBad ? t('projects.dateOrder') : v.milestone ? t('projects.milestoneHint') : undefined}
          footerError={dateOrderBad}
        >
          <FormSwitchRow label={t('projects.milestone')} value={v.milestone} onValueChange={(on) => set('milestone', on)} />
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
            icon={v.milestone ? 'diamond' : 'calendar'}
            value={v.due}
            fallback={v.milestone ? null : v.start}
            min={v.milestone ? null : v.start}
            onChange={(s) => set('due', s)}
            expanded={openDate === 'due'}
            onExpandedChange={(open) => setOpenDate(open ? 'due' : null)}
          />
        </FormSection>

        <FormFields>
          <FormTextField
            label={t('projects.estimatedHours')}
            placeholder={t('projects.hoursPlaceholder')}
            state={hoursText}
            keyboard="number"
            onChangeText={(s) => set('hours', s.replace(/[^0-9]/g, ''))}
          />
          <FormTextField
            label={t('projects.tags')}
            placeholder={t('projects.tagsPlaceholder')}
            state={tagsText}
            onChangeText={(s) => set('tags', s)}
          />
        </FormFields>
      </NativeForm>
    </>
  );
}
