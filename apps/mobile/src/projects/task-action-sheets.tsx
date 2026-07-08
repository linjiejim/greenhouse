/**
 * Long-press task actions — the touch replacement for the web gantt/list
 * context menu: view / change status / edit / add subtask / toggle milestone /
 * delete. Status + milestone + delete mutate here; view / edit / subtask are
 * delegated to the host screen.
 */

import React, { useState } from 'react';
import { Alert } from 'react-native';
import type { ProjectTask, TaskStatus } from '../shared/greenhouse-types';
import { deleteTask, updateTask } from '../api/projects';
import { useT } from '../lib/i18n';
import { ActionSheet, type ActionItem } from '../ui';
import { TASK_STATUSES, taskStatusIcon, taskStatusLabel } from './meta';

export function TaskActionsHost({
  task,
  onClose,
  onChanged,
  onView,
  onEdit,
  onAddSubtask,
  showView = true,
}: {
  /** The long-pressed task; null hides the sheet. */
  task: ProjectTask | null;
  onClose: () => void;
  /** A mutation landed — reload the tree. */
  onChanged: () => void;
  onView?: (task: ProjectTask) => void;
  onEdit: (task: ProjectTask) => void;
  onAddSubtask: (task: ProjectTask) => void;
  showView?: boolean;
}) {
  const t = useT();
  const [statusFor, setStatusFor] = useState<ProjectTask | null>(null);

  const isMilestone = task?.task_type === 'milestone';

  const items: ActionItem[] = [
    ...(showView && onView ? [{ id: 'view', label: t('projects.viewDetail'), icon: 'expand' } as ActionItem] : []),
    { id: 'status', label: t('projects.changeStatus'), icon: 'refresh' },
    { id: 'edit', label: t('projects.edit'), icon: 'pen' },
    { id: 'subtask', label: t('projects.newSubtask'), icon: 'plus' },
    { id: 'milestone', label: isMilestone ? t('projects.unmakeMilestone') : t('projects.makeMilestone'), icon: 'diamond' },
    { id: 'delete', label: t('projects.deleteTask'), icon: 'trash', danger: true },
  ];

  const handlePick = (id: string) => {
    const current = task;
    if (!current) return;
    if (id === 'view') {
      onView?.(current);
    } else if (id === 'status') {
      setStatusFor(current);
    } else if (id === 'edit') {
      onEdit(current);
    } else if (id === 'subtask') {
      onAddSubtask(current);
    } else if (id === 'milestone') {
      void updateTask(current.id, { task_type: current.task_type === 'milestone' ? 'task' : 'milestone' }).then(onChanged);
    } else if (id === 'delete') {
      Alert.alert(t('projects.deleteTask'), t('projects.deleteTaskConfirm', { name: current.title }), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => void deleteTask(current.id).then(onChanged),
        },
      ]);
    }
  };

  return (
    <>
      <ActionSheet visible={!!task} onClose={onClose} items={items} onPick={handlePick} />
      <ActionSheet
        visible={!!statusFor}
        onClose={() => setStatusFor(null)}
        items={TASK_STATUSES.map((s) => ({ id: s, label: taskStatusLabel(s, t), icon: taskStatusIcon(s) }))}
        onPick={(s) => {
          const target = statusFor;
          if (!target) return;
          void updateTask(target.id, { status: s as TaskStatus }).then(onChanged);
        }}
      />
    </>
  );
}
