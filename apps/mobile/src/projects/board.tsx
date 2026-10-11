/**
 * BoardView — a project's kanban: one lane per task status on the shared
 * `Lanes` (src/ui/lanes.tsx; Tables and app kanban cards use the same lanes).
 * Web drags cards between columns — on touch, status moves go through the
 * card's long-press system menu (状态 submenu) instead, and tapping a card
 * opens the task. With write access each lane header carries a `+` that opens
 * the task form preset to that status (web board parity: per-column add).
 * VoiceOver: a card is one element with open / mark-done as accessibility
 * actions.
 */

import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ProjectTask, TaskStatus } from '../shared/greenhouse-types';
import { useT } from '../lib/i18n';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { InitialAvatar } from '../ui/avatar';
import { Lanes, useLaneCardStyle, type LaneSpec } from '../ui/lanes';
import { NativeMenu } from '../ui/menu';
import { TASK_STATUSES, forEachTask, taskStatusColor, taskStatusIcon, taskStatusLabel } from './meta';
import { TaskMeta, TaskStatusButton, taskRowA11y } from './task-list';
import type { useTaskActions } from './task-actions';

type TaskActions = ReturnType<typeof useTaskActions>;

export function BoardView({
  tasks,
  actions,
  canWrite,
  onAdd,
  bottomInset = 0,
}: {
  /** Task tree — flattened internally (the board shows every task). */
  tasks: ProjectTask[];
  actions: TaskActions;
  canWrite: boolean;
  /** New task in a lane (shown only with write access). */
  onAdd?: (status: TaskStatus) => void;
  /** Space under the lanes (home indicator). */
  bottomInset?: number;
}) {
  const { colors: c } = useTheme();
  const t = useT();

  const lanes = useMemo<LaneSpec<ProjectTask>[]>(() => {
    const map = new Map<TaskStatus, ProjectTask[]>(TASK_STATUSES.map((s) => [s, []]));
    forEachTask(tasks, (task) => map.get(task.status)?.push(task));
    return TASK_STATUSES.map((status) => ({
      key: status,
      title: taskStatusLabel(status, t),
      icon: taskStatusIcon(status),
      color: taskStatusColor(status, c),
      items: map.get(status) ?? [],
      ...(canWrite && onAdd
        ? { onAdd: () => onAdd(status), addLabel: t('projects.newTaskIn', { status: taskStatusLabel(status, t) }) }
        : {}),
    }));
  }, [tasks, canWrite, onAdd, t, c]);

  return (
    <Lanes
      lanes={lanes}
      keyOf={(task) => String(task.id)}
      bottomInset={bottomInset}
      renderItem={(task) => <BoardCard task={task} actions={actions} canWrite={canWrite} />}
    />
  );
}

function BoardCard({ task, actions, canWrite }: { task: ProjectTask; actions: TaskActions; canWrite: boolean }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const cardStyle = useLaneCardStyle();
  const t = useT();
  const closed = task.status === 'done' || task.status === 'cancelled';
  const card = (
    <Pressable
      onPress={() => actions.open(task)}
      {...taskRowA11y(task, t, { actions, canWrite })}
      style={({ pressed }) => [cardStyle, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.cardTop}>
        <TaskStatusButton
          task={task}
          size={20}
          onToggle={canWrite ? () => void actions.setStatus(task, task.status === 'done' ? 'todo' : 'done') : undefined}
        />
        <Text numberOfLines={3} style={[styles.cardTitle, closed && styles.cardTitleClosed]}>
          {task.title}
        </Text>
        {task.assignee_nickname ? <InitialAvatar name={task.assignee_nickname} size={22} tint={c.gray} /> : null}
      </View>
      <View style={styles.cardMeta}>
        <TaskMeta task={task} />
      </View>
    </Pressable>
  );
  if (!canWrite) return card;
  return (
    <NativeMenu trigger="longPress" items={actions.menuItems(task)} onSelect={(id) => actions.onSelect(task, id)}>
      {card}
    </NativeMenu>
  );
}

const useStyles = makeStyles((c) => ({
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  cardTitle: { ...typo.subheadline, fontWeight: weight.medium, color: c.label, flex: 1, paddingTop: 1 },
  cardTitleClosed: { color: c.secondaryLabel, textDecorationLine: 'line-through' },
  cardMeta: { paddingLeft: 20 + space.sm },
}));
