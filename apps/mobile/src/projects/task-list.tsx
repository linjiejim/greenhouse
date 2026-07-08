/**
 * TaskTreeList — the detail screen's List view: a flattened task tree with
 * expand/collapse chevrons, status icon, priority flag, assignee and due date
 * (web parity: task-tree.tsx). Tap opens the task, long-press opens actions.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { ProjectTask } from '../shared/greenhouse-types';
import { useT } from '../lib/i18n';
import { EmptyState, Icon, Touchable } from '../ui';
import { font, makeStyles, useTheme, weight } from '../theme';
import { collectParentIds, flattenTree, isOverdue, priorityColor, shortDate, taskStatusColor, taskStatusIcon, type FlatTask } from './meta';

export function TaskTreeList({
  tasks,
  onOpen,
  onLongPress,
  refreshing,
  onRefresh,
  bottomPad = 120,
}: {
  tasks: ProjectTask[];
  onOpen: (task: ProjectTask) => void;
  onLongPress: (task: ProjectTask) => void;
  refreshing?: boolean;
  onRefresh?: () => void;
  bottomPad?: number;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Auto-expand every parent whenever the tree changes (web parity).
  useEffect(() => {
    setExpanded(collectParentIds(tasks));
  }, [tasks]);

  const rows = useMemo(() => flattenTree(tasks, expanded), [tasks, expanded]);

  const toggle = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => String(r.task.id)}
      contentContainerStyle={{ paddingBottom: bottomPad, flexGrow: 1 }}
      showsVerticalScrollIndicator={false}
      refreshing={refreshing}
      onRefresh={onRefresh}
      ListEmptyComponent={<EmptyState icon="list" title={t('projects.noTasks')} sub={t('projects.noTasksHint')} />}
      renderItem={({ item }) => (
        <TaskRow
          row={item}
          isExpanded={expanded.has(item.task.id)}
          onToggle={() => toggle(item.task.id)}
          onPress={() => onOpen(item.task)}
          onLongPress={() => onLongPress(item.task)}
        />
      )}
    />
  );
}

function TaskRow({
  row,
  isExpanded,
  onToggle,
  onPress,
  onLongPress,
}: {
  row: FlatTask;
  isExpanded: boolean;
  onToggle: () => void;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const task = row.task;
  const overdue = isOverdue(task);
  const done = task.status === 'done';
  const isMilestone = task.task_type === 'milestone';

  return (
    <Touchable
      haptic="none"
      onPress={onPress}
      onLongPress={onLongPress}
      pressedStyle={{ backgroundColor: c.surfaceMuted }}
      style={[styles.row, { paddingLeft: 12 + row.depth * 18 }]}
    >
      {row.isParent ? (
        <Touchable haptic="selection" onPress={onToggle} hitSlop={10} style={styles.chevBox}>
          <Icon name={isExpanded ? 'chevD' : 'chevR'} size={14} color={c.fgFaint} />
        </Touchable>
      ) : (
        <View style={styles.chevBox} />
      )}

      {isMilestone ? (
        <Icon name="diamond" size={13} color={c.warning} />
      ) : (
        <Icon name={taskStatusIcon(task.status)} size={14} color={taskStatusColor(task.status, c)} />
      )}

      <Text numberOfLines={1} style={[styles.title, done && styles.titleDone]}>
        {task.title}
      </Text>

      {task.priority !== 'normal' ? <Icon name="flag" size={12} color={priorityColor(task.priority, c)} /> : null}

      {task.assignee_nickname ? (
        <View style={styles.assignee}>
          <Text numberOfLines={1} style={styles.assigneeText}>
            {task.assignee_nickname}
          </Text>
        </View>
      ) : null}

      {task.due_date ? (
        <View style={styles.due}>
          <Icon name="calendar" size={11} color={overdue ? c.danger : c.fgFaint} />
          <Text style={[styles.dueText, overdue && { color: c.danger, fontWeight: weight.semibold }]}>{shortDate(task.due_date)}</Text>
        </View>
      ) : null}
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 16,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  chevBox: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: font.body, color: c.fg },
  titleDone: { textDecorationLine: 'line-through', color: c.fgFaint },
  assignee: {
    maxWidth: 76,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: c.surfaceMuted,
  },
  assigneeText: { fontSize: font.caption, color: c.fgMuted },
  due: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  dueText: { fontSize: font.caption, color: c.fgFaint },
}));
