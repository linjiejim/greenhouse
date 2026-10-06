/**
 * TaskTreeList — the project page's List view: the task tree as a plain iOS
 * list (Reminders-like). Web parity: task-tree.tsx.
 *
 *  - parents carry a disclosure chevron (expand / collapse, all expanded on
 *    load); children indent one step per level,
 *  - the leading status glyph is a button: tap toggles done ↔ todo (like
 *    completing a reminder); other statuses live in the context menu,
 *  - a meta line shows milestone ◆, priority flag, due date (red when overdue)
 *    and subtask progress; the assignee's monogram sits on the trailing edge,
 *  - tap opens the task page; long-press opens the system context menu
 *    (src/projects/task-actions),
 *  - VoiceOver: the row is one element ("title, status[, overdue]"); the
 *    nested checkbox / chevron are reachable as accessibility actions
 *    (complete, expand/collapse, edit, delete — `taskRowA11y`).
 *
 * Also exports the shared row pieces (`TaskStatusButton`, `TaskMeta`,
 * `taskRowA11y`) used by the board cards and the task page's subtask list.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native';
import type { ProjectTask } from '../shared/greenhouse-types';
import { useT } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import { HIT, makeStyles, space, typo, useTheme, weight } from '../theme';
import { Icon } from '../ui/core';
import { InitialAvatar } from '../ui/avatar';
import { EmptyState } from '../ui/empty';
import { NativeMenu } from '../ui/menu';
import {
  collectParentIds,
  flattenTree,
  formatDay,
  isMilestone,
  isOverdue,
  priorityColor,
  priorityLabel,
  taskStatusColor,
  taskStatusIcon,
  taskStatusLabel,
  type FlatTask,
  type TranslateFn,
} from './meta';
import type { useTaskActions } from './task-actions';

type TaskActions = ReturnType<typeof useTaskActions>;

/**
 * Accessibility for a task row / card: one element whose label carries the
 * status (and overdue), with the nested controls and the main context-menu
 * actions exposed as VoiceOver actions.
 */
export function taskRowA11y(
  task: ProjectTask,
  t: TranslateFn,
  {
    actions,
    canWrite,
    expand,
  }: { actions: TaskActions; canWrite: boolean; expand?: { expanded: boolean; onToggle: () => void } },
) {
  const done = task.status === 'done';
  const label = [task.title, taskStatusLabel(task.status, t), isOverdue(task) ? t('projects.overdue') : '']
    .filter(Boolean)
    .join(', ');
  return {
    accessibilityRole: 'button' as const,
    accessibilityLabel: label,
    accessibilityState: expand ? { expanded: expand.expanded } : undefined,
    accessibilityActions: [
      { name: 'activate' },
      ...(canWrite ? [{ name: 'toggleDone', label: done ? t('projects.markTodo') : t('projects.markDone') }] : []),
      ...(expand ? [{ name: 'toggleExpand', label: expand.expanded ? t('projects.collapse') : t('projects.expand') }] : []),
      ...(canWrite
        ? [
            { name: 'edit', label: t('projects.editTask') },
            { name: 'delete', label: t('projects.deleteTask') },
          ]
        : []),
    ],
    onAccessibilityAction: (e: AccessibilityActionEvent) => {
      switch (e.nativeEvent.actionName) {
        case 'activate':
          actions.open(task);
          break;
        case 'toggleDone':
          void actions.setStatus(task, done ? 'todo' : 'done');
          break;
        case 'toggleExpand':
          expand?.onToggle();
          break;
        case 'edit':
          actions.edit(task);
          break;
        case 'delete':
          void actions.remove(task);
          break;
      }
    },
  };
}

const INDENT = 22;
const CHEV = 20;
const GLYPH = 24;
const GAP = space.sm;
/** Where the row's text starts (separator inset), relative to the row's leading padding. */
const TEXT_X = CHEV - space.xs + GAP + GLYPH + GAP;

export function TaskTreeList({
  tasks,
  actions,
  canWrite,
  refreshing,
  onRefresh,
  header,
}: {
  tasks: ProjectTask[];
  actions: TaskActions;
  canWrite: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  header?: React.ReactElement;
}) {
  const { hex } = useTheme();
  const t = useT();
  const [expanded, setExpanded] = useState<Set<number>>(() => collectParentIds(tasks));

  // Auto-expand new parents whenever the tree changes (web parity) while
  // keeping the user's manual collapses.
  const parentKey = useMemo(() => [...collectParentIds(tasks)].join(','), [tasks]);
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of collectParentIds(tasks)) next.add(id);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentKey]);

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
      contentContainerStyle={{ paddingBottom: 48, flexGrow: 1 }}
      ListHeaderComponent={header}
      refreshControl={
        onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={hex.accent} /> : undefined
      }
      ListEmptyComponent={<EmptyState icon="checklist" title={t('projects.noTasks')} message={t('projects.noTasksHint')} />}
      renderItem={({ item, index }) => (
        <TaskRow
          row={item}
          last={index === rows.length - 1}
          isExpanded={expanded.has(item.task.id)}
          onToggle={() => toggle(item.task.id)}
          actions={actions}
          canWrite={canWrite}
        />
      )}
    />
  );
}

function TaskRow({
  row,
  last,
  isExpanded,
  onToggle,
  actions,
  canWrite,
}: {
  row: FlatTask;
  last: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  actions: TaskActions;
  canWrite: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const task = row.task;
  const closed = task.status === 'done' || task.status === 'cancelled';
  const lead = space.margin + row.depth * INDENT;

  const body = (
    <Pressable
      onPress={() => actions.open(task)}
      {...taskRowA11y(task, t, { actions, canWrite, expand: row.isParent ? { expanded: isExpanded, onToggle } : undefined })}
      style={({ pressed }) => [styles.row, { paddingLeft: lead }, pressed && { backgroundColor: c.fill }]}
    >
      {row.isParent ? (
        <Pressable
          onPress={onToggle}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={isExpanded ? t('projects.collapse') : t('projects.expand')}
          style={styles.chev}
        >
          <Icon name={isExpanded ? 'chevD' : 'chevR'} size={13} weight="semibold" color={c.tertiaryLabel} />
        </Pressable>
      ) : (
        <View style={styles.chev} />
      )}
      <TaskStatusButton task={task} onToggle={canWrite ? () => void actions.setStatus(task, task.status === 'done' ? 'todo' : 'done') : undefined} />
      <View style={styles.texts}>
        <Text numberOfLines={2} style={[styles.title, closed && styles.titleClosed]}>
          {task.title}
        </Text>
        <TaskMeta task={task} />
      </View>
      {task.assignee_nickname ? <InitialAvatar name={task.assignee_nickname} size={24} tint={c.gray} /> : null}
      {!last ? <View pointerEvents="none" style={[styles.sep, { left: lead + TEXT_X }]} /> : null}
    </Pressable>
  );

  if (!canWrite) return body;
  return (
    <NativeMenu trigger="longPress" items={actions.menuItems(task)} onSelect={(id) => actions.onSelect(task, id)}>
      {body}
    </NativeMenu>
  );
}

/** Leading status glyph; a button (done ↔ todo) when `onToggle` is given. */
export function TaskStatusButton({ task, onToggle, size = GLYPH }: { task: ProjectTask; onToggle?: () => void; size?: number }) {
  const { colors: c } = useTheme();
  const t = useT();
  const glyph = isMilestone(task) ? (
    <Icon name="diamondFill" size={size - 4} color={task.status === 'done' ? c.green : c.orange} />
  ) : (
    <Icon name={taskStatusIcon(task.status)} size={size} weight="light" color={taskStatusColor(task.status, c)} />
  );
  if (!onToggle) return <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>{glyph}</View>;
  return (
    <Pressable
      onPress={onToggle}
      hitSlop={10}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: task.status === 'done' }}
      accessibilityLabel={taskStatusLabel(task.status, t)}
      style={({ pressed }) => [{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, pressed && { opacity: 0.5 }]}
    >
      {glyph}
    </Pressable>
  );
}

/** One-line task meta: milestone · priority · due (red when overdue) · subtasks. Renders nothing when empty. */
export function TaskMeta({ task, showAssignee = false }: { task: ProjectTask; showAssignee?: boolean }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const overdue = isOverdue(task);
  const kids = task.children ?? [];
  const doneKids = kids.filter((k) => k.status === 'done').length;
  const parts: React.ReactNode[] = [];
  if (isMilestone(task)) {
    parts.push(
      <Text key="ms" style={[styles.meta, { color: c.orange }]}>
        {t('projects.milestone')}
      </Text>,
    );
  }
  if (task.priority !== 'normal') {
    parts.push(
      <View key="pri" style={styles.metaPair}>
        <Icon name="flagFill" size={11} color={priorityColor(task.priority, c)} />
        <Text style={[styles.meta, { color: priorityColor(task.priority, c) }]}>{priorityLabel(task.priority, t)}</Text>
      </View>,
    );
  }
  if (task.due_date) {
    parts.push(
      <View key="due" style={styles.metaPair}>
        <Icon name="calendar" size={11} color={overdue ? c.red : c.secondaryLabel} />
        <Text style={[styles.meta, overdue && { color: c.red, fontWeight: weight.semibold }]}>{formatDay(task.due_date, lang)}</Text>
      </View>,
    );
  }
  if (kids.length > 0) {
    parts.push(
      <View key="kids" style={styles.metaPair}>
        <Icon name="checklist" size={11} color={c.secondaryLabel} />
        <Text style={styles.meta}>
          {doneKids}/{kids.length}
        </Text>
      </View>,
    );
  }
  if (showAssignee && task.assignee_nickname) {
    parts.push(
      <Text key="who" numberOfLines={1} style={[styles.meta, { flexShrink: 1 }]}>
        {task.assignee_nickname}
      </Text>,
    );
  }
  if (parts.length === 0) return null;
  return <View style={styles.metaRow}>{parts}</View>;
}

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: GAP,
    minHeight: HIT + 8,
    paddingRight: space.margin,
    paddingVertical: space.sm + 2,
    backgroundColor: c.background,
  },
  chev: { width: CHEV, height: CHEV, alignItems: 'center', justifyContent: 'center', marginRight: -space.xs },
  texts: { flex: 1, minWidth: 0, gap: 2 },
  title: { ...typo.body, color: c.label },
  titleClosed: { color: c.secondaryLabel, textDecorationLine: 'line-through' },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: space.sm + 2, rowGap: 2 },
  metaPair: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  meta: { ...typo.footnote, color: c.secondaryLabel },
  sep: { position: 'absolute', right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: c.separator },
}));
