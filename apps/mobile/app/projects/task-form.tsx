/**
 * Task form — create / edit a task, subtask or milestone as a form sheet with
 * a real SwiftUI Form (web parity: create-task-dialog + task-drawer's edit).
 * Android: ./task-form.android.tsx; behaviour: src/projects/use-task-form.tsx.
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

import React from 'react';
import { Label, LabeledContent, Picker, Section, Text, TextField, Toggle, useNativeState } from '@expo/ui/swift-ui';
import { foregroundStyle, keyboardType, lineLimit, multilineTextAlignment, pickerStyle, tag, textInputAutocapitalization } from '@expo/ui/swift-ui/modifiers';
import type { Priority, TaskStatus } from '../../src/api/projects';
import { useT } from '../../src/lib/i18n';
import { OptionalDateField } from '../../src/projects/form-fields';
import { PRIORITIES, TASK_STATUSES, priorityLabel, taskStatusIcon, taskStatusLabel } from '../../src/projects/meta';
import { TaskFormGate, useTaskForm, type TaskFormProps } from '../../src/projects/use-task-form';
import { sfSymbol } from '../../src/ui/core';
import { NativeForm } from '../../src/ui/native-form';
import { FormChrome } from '../../src/ui/sheet-chrome';

export default function TaskFormScreen() {
  return <TaskFormGate render={(props) => <TaskForm {...props} />} />;
}

function TaskForm(props: TaskFormProps) {
  const t = useT();
  const { parentTitle, task } = props;
  const { initial, v, set, setStart, openDate, setOpenDate, dirty, valid, dateOrderBad, saving, save, users, isEdit, title: sheetTitle } =
    useTaskForm(props);
  const titleText = useNativeState(initial.title);
  const descText = useNativeState(initial.description);
  const hoursText = useNativeState(initial.hours);
  const tagsText = useNativeState(initial.tags);

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
