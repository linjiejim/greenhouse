/**
 * TaskFormSheet — create / edit a task, subtask or milestone (web parity:
 * create-task-dialog + task-drawer's edit form). Milestones collapse to a
 * single date that fills both start and due.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { AssignableUser, ProjectTask, TaskInput } from '../api/projects';
import { createTask, updateTask } from '../api/projects';
import { useT } from '../lib/i18n';
import { BottomSheetScrollView, Button, DateField, Field, Sheet } from '../ui';
import { font, makeStyles, useTheme } from '../theme';
import { FormLabel, OptionChips, PickerRow } from './form-bits';
import { UserPickerSheet } from './user-picker-sheet';
import {
  PRIORITIES,
  TASK_STATUSES,
  parseTags,
  priorityColor,
  priorityLabel,
  taskStatusColor,
  taskStatusLabel,
} from './meta';

export function TaskFormSheet({
  visible,
  onClose,
  projectId,
  task,
  parentId,
  milestone = false,
  users,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  projectId: number;
  /** Present → edit mode. */
  task?: ProjectTask | null;
  /** Create a subtask under this task. */
  parentId?: number;
  /** Create-mode milestone (single date). */
  milestone?: boolean;
  users: AssignableUser[];
  onSaved: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();

  const isEdit = !!task;
  const isMilestone = isEdit ? task!.task_type === 'milestone' : milestone;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<ProjectTask['status']>('todo');
  const [priority, setPriority] = useState<ProjectTask['priority']>('normal');
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [hours, setHours] = useState('');
  const [tags, setTags] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // (Re)seed the form whenever the sheet opens.
  useEffect(() => {
    if (!visible) return;
    setError('');
    setTitle(task?.title ?? '');
    setDescription(task?.description ?? '');
    setStatus(task?.status ?? 'todo');
    setPriority(task?.priority ?? 'normal');
    setAssigneeId(task?.assignee_id ?? null);
    setStartDate(task?.start_date?.slice(0, 10) ?? null);
    setDueDate(task?.due_date?.slice(0, 10) ?? null);
    setHours(task?.estimated_hours != null ? String(task.estimated_hours) : '');
    setTags(task ? parseTags(task.tags).join(', ') : '');
  }, [visible, task]);

  const assigneeName = useMemo(
    () => (assigneeId ? users.find((u) => u.id === assigneeId)?.nickname ?? assigneeId : null),
    [assigneeId, users],
  );

  const sheetTitle = isEdit
    ? t('projects.editTask')
    : isMilestone
      ? t('projects.newMilestone')
      : parentId
        ? t('projects.newSubtask')
        : t('projects.newTask');

  const save = async () => {
    if (!title.trim()) {
      setError(t('projects.titleRequired'));
      return;
    }
    setSaving(true);
    setError('');
    const body: TaskInput = {
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      assignee_id: assigneeId,
      estimated_hours: hours.trim() ? parseInt(hours, 10) || null : null,
      tags: tags
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    if (isMilestone) {
      body.task_type = 'milestone';
      body.start_date = dueDate;
      body.due_date = dueDate;
    } else {
      body.start_date = startDate;
      body.due_date = dueDate;
    }
    let ok: boolean;
    if (isEdit) {
      body.status = status;
      ok = !!(await updateTask(task!.id, body));
    } else {
      ok = !!(await createTask(projectId, { ...body, title: title.trim(), parent_id: parentId }));
    }
    setSaving(false);
    if (!ok) {
      setError(t('projects.saveFailed'));
      return;
    }
    onSaved();
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={sheetTitle} heightPct={88}>
      <BottomSheetScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Field
          placeholder={isMilestone ? t('projects.milestonePlaceholder') : t('projects.taskTitlePlaceholder')}
          value={title}
          onChangeText={setTitle}
        />
        <Field
          placeholder={t('projects.descPlaceholder')}
          value={description}
          onChangeText={setDescription}
          multiline
          style={{ minHeight: 64, paddingTop: 4 }}
        />

        {isEdit ? (
          <View>
            <FormLabel text={t('projects.status')} />
            <OptionChips
              options={TASK_STATUSES.map((s) => ({ id: s, label: taskStatusLabel(s, t), color: taskStatusColor(s, c) }))}
              value={status}
              onChange={setStatus}
            />
          </View>
        ) : null}

        <View>
          <FormLabel text={t('projects.priority')} />
          <OptionChips
            options={PRIORITIES.map((p) => ({ id: p, label: priorityLabel(p, t), color: priorityColor(p, c) }))}
            value={priority}
            onChange={setPriority}
          />
        </View>

        <View>
          <FormLabel text={t('projects.assignee')} />
          <PickerRow value={assigneeName} placeholder={t('projects.unassigned')} onPress={() => setPickerOpen(true)} />
        </View>

        {isMilestone ? (
          <DateField label={t('projects.milestoneDate')} value={dueDate} onChange={setDueDate} />
        ) : (
          <View style={styles.dateRow}>
            <View style={{ flex: 1 }}>
              <DateField label={t('projects.startDate')} value={startDate} onChange={setStartDate} />
            </View>
            <View style={{ flex: 1 }}>
              <DateField label={t('projects.dueDate')} value={dueDate} onChange={setDueDate} />
            </View>
          </View>
        )}

        <View style={styles.dateRow}>
          <View style={{ flex: 1 }}>
            <FormLabel text={t('projects.estimatedHours')} />
            <Field value={hours} onChangeText={setHours} keyboardType="number-pad" placeholder="—" />
          </View>
          <View style={{ flex: 2 }}>
            <FormLabel text={t('projects.tagsComma')} />
            <Field value={tags} onChangeText={setTags} autoCapitalize="none" placeholder="—" />
          </View>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button label={isEdit ? t('common.save') : t('common.create')} loading={saving} onPress={save} />
      </BottomSheetScrollView>

      <UserPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        users={users}
        selectedId={assigneeId}
        onPick={setAssigneeId}
        allowClear
      />
    </Sheet>
  );
}

const useStyles = makeStyles((c) => ({
  body: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 40, gap: 14 },
  dateRow: { flexDirection: 'row', gap: 10 },
  error: { fontSize: font.small, color: c.danger },
}));
